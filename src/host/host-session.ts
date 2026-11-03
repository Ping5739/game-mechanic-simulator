import type { BotSettings } from "../sim/bots";
import { PROTOCOL_VERSION, type ClientMsg, type HostMsg, type RosterEntry } from "../net/protocol";
import type { Connection, HostRoom, Transport } from "../net/transport";
import type { FromWorker, ToWorker } from "./worker-protocol";

/** The minimal pipe a ClientSession needs; a remote Connection or an in-page link. */
export interface Link {
  send(msg: ClientMsg): void;
  onMessage(cb: (msg: HostMsg) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export const LOCAL_ID = "host";

interface Member {
  name: string;
  rtt: number;
  deliver: (m: HostMsg) => void;
  conn?: Connection;
}

export interface HostStats {
  avgStepMs: number;
  maxStepMs: number;
  ticksPerSec: number;
  peers: number;
}

/**
 * Runs on the host's page. Owns the simulation worker, accepts peer
 * connections, and relays messages between them. The host's own player is
 * just another member, connected through an in-page link.
 */
export class HostSession {
  room?: HostRoom;
  stats: HostStats = { avgStepMs: 0, maxStepMs: 0, ticksPerSec: 0, peers: 0 };
  onRoomError: (err: string) => void = () => {};

  private worker!: Worker;
  private readonly members = new Map<string, Member>();
  private roster: RosterEntry[] = [];
  private readonly seed = (Math.random() * 2 ** 31) | 0;
  private rosterTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly transport: Transport | null,
    private readonly opts: { name: string; encounterId: string; strategyId: string; bots: BotSettings },
  ) {}

  async start(): Promise<Link> {
    if (this.transport) {
      this.room = await this.transport.createRoom();
      this.room.onConnection((c) => this.acceptPeer(c));
      this.room.onError((e) => this.onRoomError(e));
    }

    this.worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data);
    this.toWorker({
      type: "init",
      encounterId: this.opts.encounterId,
      strategyId: this.opts.strategyId,
      seed: this.seed,
      bots: this.opts.bots,
    });

    this.rosterTimer = setInterval(() => this.broadcastRoster(), 2000);

    // In-page link for the host's own player.
    let toLocal: (m: HostMsg) => void = () => {};
    const link: Link = {
      send: (msg) => this.onClientMsg(LOCAL_ID, msg),
      onMessage: (cb) => (toLocal = cb),
      onClose: () => {},
      close: () => this.stop(),
    };
    this.members.set(LOCAL_ID, { name: this.opts.name, rtt: 0, deliver: (m) => toLocal(m) });
    // The local client sends "hello" itself, like any remote client.
    return link;
  }

  paused = false;

  /** Freeze or resume the encounter for everyone (host only). */
  setPaused(paused: boolean): void {
    this.toWorker({ type: "pause", paused });
  }

  /** Jump the encounter to `seconds` into the loop (host only). */
  seek(seconds: number): void {
    this.toWorker({ type: "seek", seconds });
  }

  setBots(bots: BotSettings): void {
    this.opts.bots = bots;
    this.toWorker({ type: "bots", bots });
    this.broadcast({ t: "bots", bots });
  }

  stop(): void {
    clearInterval(this.rosterTimer);
    for (const m of this.members.values()) m.conn?.close();
    this.room?.close();
    this.worker?.terminate();
  }

  private toWorker(m: ToWorker): void {
    this.worker.postMessage(m);
  }

  private acceptPeer(conn: Connection): void {
    conn.onMessage((msg) => this.onClientMsg(conn.id, msg as ClientMsg, conn));
    conn.onClose(() => {
      if (!this.members.has(conn.id)) return;
      this.members.delete(conn.id);
      this.toWorker({ type: "leave", id: conn.id });
      this.stats.peers = this.members.size - 1;
    });
  }

  private onClientMsg(id: string, msg: ClientMsg, conn?: Connection): void {
    switch (msg.t) {
      case "hello": {
        if (msg.version !== PROTOCOL_VERSION) {
          conn?.send({ t: "full", reason: "Version mismatch: please refresh the page." } satisfies HostMsg);
          return;
        }
        const name = String(msg.name).slice(0, 24) || "Player";
        if (conn) this.members.set(id, { name, rtt: 0, deliver: (m) => conn.send(m), conn });
        else this.members.get(LOCAL_ID)!.name = name;
        this.stats.peers = this.members.size - 1;
        this.toWorker({ type: "join", id, name });
        break;
      }
      case "pos":
        if (!this.members.has(id)) return;
        this.toWorker({ type: "sample", id, tick: msg.tick, x: msg.x, y: msg.y, epoch: msg.e, facing: msg.f });
        break;
      case "ping": {
        const m = this.members.get(id);
        if (!m) return;
        if (typeof msg.rtt === "number") m.rtt = msg.rtt;
        m.deliver({ t: "pong", c: msg.c });
        break;
      }
    }
  }

  private onWorker(m: FromWorker): void {
    switch (m.type) {
      case "joined": {
        const member = this.members.get(m.id);
        member?.deliver({
          t: "welcome",
          you: m.id,
          slot: m.slot,
          tick: m.tick,
          epoch: m.epoch,
          loopStartTick: m.loopStartTick,
          paused: m.paused,
          encounterId: this.opts.encounterId,
          strategyId: this.opts.strategyId,
          seed: this.seed,
          bots: this.opts.bots,
          hazards: m.hazards,
        });
        break;
      }
      case "full": {
        const member = this.members.get(m.id);
        member?.deliver({ t: "full", reason: "The room is full (8/8 humans)." });
        this.members.delete(m.id);
        setTimeout(() => member?.conn?.close(), 500);
        break;
      }
      case "snap":
        this.broadcast({ t: "snap", tick: m.tick, p: m.p, g: m.g, a: m.a });
        break;
      case "pause":
        this.paused = m.paused;
        this.broadcast({ t: "pause", paused: m.paused, tick: m.tick });
        break;
      case "seek": {
        const { type: _type, ...info } = m;
        this.broadcast({ t: "seek", ...info });
        break;
      }
      case "hazard":
        this.broadcast({ t: "hazard", h: m.h });
        break;
      case "result":
        this.broadcast({ t: "result", r: m.r });
        break;
      case "roster":
        this.roster = m.roster;
        this.broadcastRoster();
        break;
      case "stats":
        this.stats = { ...this.stats, avgStepMs: m.avgStepMs, maxStepMs: m.maxStepMs, ticksPerSec: m.ticksPerSec };
        break;
    }
  }

  private broadcastRoster(): void {
    const pings: Record<string, number> = {};
    for (const [id, mem] of this.members) pings[id] = Math.round(mem.rtt);
    this.broadcast({ t: "roster", roster: this.roster, pings });
  }

  private broadcast(msg: HostMsg): void {
    for (const m of this.members.values()) m.deliver(msg);
  }
}

/** Wrap a remote Connection as a typed Link for the client. */
export function linkFromConnection(conn: Connection): Link {
  return {
    send: (m) => conn.send(m),
    onMessage: (cb) => conn.onMessage((m) => cb(m as HostMsg)),
    onClose: (cb) => conn.onClose(cb),
    close: () => conn.close(),
  };
}
