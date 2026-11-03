import { ENCOUNTERS } from "../data";
import type { BotSettings } from "../sim/bots";
import { MOVE_SPEED, TICK_MS } from "../sim/constants";
import { clampToArena, dist } from "../sim/math";
import type { EncounterDef, Hazard, HitResult, Slot, Vec2 } from "../sim/types";
import { PROTOCOL_VERSION, r2, type HostMsg, type RosterEntry } from "../net/protocol";
import type { Link } from "../host/host-session";

interface Remote {
  id: string;
  slot: Slot;
  name: string;
  isBot: boolean;
  fails: number;
  buf: { tick: number; x: number; y: number }[];
}

export interface FeedItem {
  ok: boolean;
  text: string;
  mine: boolean;
  at: number;
}

export interface TrackedHazard extends Hazard {
  result?: HitResult;
}

/**
 * Everything one player's page knows about the game, and how it smooths over
 * network delay:
 *   - your own character moves immediately (prediction),
 *   - the encounter timeline runs on an estimate of the host's clock,
 *   - other players are drawn slightly in the past and interpolated.
 */
export class ClientSession {
  myId = "";
  slot: Slot = "MT";
  encounter!: EncounterDef;
  bots!: BotSettings;
  ready = false;
  myPos: Vec2 = { x: 0, y: 0 };
  rtt = 0;
  readonly players = new Map<string, Remote>();
  readonly hazards = new Map<number, TrackedHazard>();
  readonly feed: FeedItem[] = [];
  pings: Record<string, number> = {};

  onReady: () => void = () => {};
  onFull: (reason: string) => void = () => {};
  onDisconnect: () => void = () => {};
  onRoster: () => void = () => {};
  onFeed: (item: FeedItem) => void = () => {};
  onBots: () => void = () => {};

  private tickOffset: number | undefined;
  private shownTick = 0;
  private lastSentTick = -1;
  private myHistory: { tick: number; x: number; y: number }[] = [];
  private pingTimer?: ReturnType<typeof setInterval>;
  private gotFirstSnap = false;

  constructor(
    private readonly link: Link,
    name: string,
    readonly isHost: boolean,
  ) {
    link.onMessage((m) => this.onMsg(m));
    link.onClose(() => {
      clearInterval(this.pingTimer);
      this.onDisconnect();
    });
    link.send({ t: "hello", name, version: PROTOCOL_VERSION });
    const ping = () => link.send({ t: "ping", c: performance.now(), rtt: Math.round(this.rtt) });
    this.pingTimer = setInterval(ping, 1000);
    ping();
  }

  close(): void {
    clearInterval(this.pingTimer);
    this.link.close();
  }

  // -------------------------------------------------------------------------
  // Clock
  // -------------------------------------------------------------------------

  /** Best estimate of the host's current tick (fractional). */
  hostTick(now = performance.now()): number {
    if (this.tickOffset === undefined) return 0;
    const t = now / TICK_MS + this.tickOffset;
    // Never run backwards; small corrections are absorbed by slowing down.
    this.shownTick = Math.max(this.shownTick, t);
    return this.shownTick;
  }

  private syncClock(snapTick: number): void {
    const now = performance.now();
    const measured = snapTick + this.rtt / 2 / TICK_MS - now / TICK_MS;
    if (this.tickOffset === undefined || Math.abs(measured - this.tickOffset) > 6) {
      this.tickOffset = measured;
      this.shownTick = now / TICK_MS + measured;
    } else {
      this.tickOffset += (measured - this.tickOffset) * 0.08;
    }
  }

  /** Other players are drawn this far behind the host clock so we can interpolate. */
  private interpDelayTicks(): number {
    return 3 + this.rtt / 2 / TICK_MS;
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  private onMsg(m: HostMsg): void {
    switch (m.t) {
      case "welcome": {
        this.myId = m.you;
        this.slot = m.slot;
        this.encounter = ENCOUNTERS[m.encounterId].def;
        this.bots = m.bots;
        for (const h of m.hazards) this.hazards.set(h.id, h);
        this.syncClock(m.tick);
        this.ready = true;
        this.onReady();
        break;
      }
      case "full":
        this.onFull(m.reason);
        break;
      case "pong": {
        const sample = performance.now() - m.c;
        this.rtt = this.rtt === 0 ? sample : this.rtt * 0.8 + sample * 0.2;
        break;
      }
      case "snap": {
        if (!this.ready) return;
        this.syncClock(m.tick);
        for (const [id, x, y, fails] of m.p) {
          let r = this.players.get(id);
          if (!r) {
            r = { id, slot: "MT", name: id, isBot: id.startsWith("bot:"), fails, buf: [] };
            this.players.set(id, r);
          }
          r.fails = fails;
          if (id === this.myId) {
            if (!this.gotFirstSnap) {
              this.myPos = { x, y };
              this.gotFirstSnap = true;
            } else {
              this.reconcile(m.tick, x, y);
            }
            continue;
          }
          r.buf.push({ tick: m.tick, x, y });
          if (r.buf.length > 40) r.buf.shift();
        }
        const present = new Set(m.p.map((p) => p[0]));
        for (const id of this.players.keys()) if (!present.has(id)) this.players.delete(id);
        break;
      }
      case "hazard":
        this.hazards.set(m.h.id, m.h);
        break;
      case "result": {
        const h = this.hazards.get(m.r.hazardId);
        if (h) h.result = m.r;
        const mine = m.r.failed.includes(this.myId);
        const item: FeedItem = m.r.reasons.length
          ? { ok: false, text: `${m.r.name}: ${m.r.reasons.join("; ")}`, mine, at: performance.now() }
          : { ok: true, text: `${m.r.name}: clean`, mine: false, at: performance.now() };
        this.feed.unshift(item);
        if (this.feed.length > 30) this.feed.pop();
        this.onFeed(item);
        break;
      }
      case "roster":
        this.pings = m.pings;
        for (const e of m.roster) this.applyRoster(e);
        this.onRoster();
        break;
      case "bots":
        this.bots = m.bots;
        this.onBots();
        break;
    }
  }

  private applyRoster(e: RosterEntry): void {
    let r = this.players.get(e.id);
    if (!r) {
      r = { id: e.id, slot: e.slot, name: e.name, isBot: e.isBot, fails: 0, buf: [] };
      this.players.set(e.id, r);
    }
    r.slot = e.slot;
    r.name = e.name;
    r.isBot = e.isBot;
    if (e.id === this.myId) this.slot = e.slot;
  }

  /** The host only corrects us if our report was rejected (e.g. impossible speed). */
  private reconcile(tick: number, x: number, y: number): void {
    const mine = this.myHistory.find((h) => h.tick === tick);
    if (!mine) return;
    const dx = x - mine.x;
    const dy = y - mine.y;
    if (Math.hypot(dx, dy) > 1.5) {
      this.myPos = { x: this.myPos.x + dx, y: this.myPos.y + dy };
      this.myHistory = [];
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  /** Move our own character and report our position once per host tick. */
  update(dtSec: number, input: Vec2): void {
    if (!this.ready || !this.gotFirstSnap) return;
    const l = Math.hypot(input.x, input.y);
    if (l > 0) {
      const step = Math.min(dtSec, 0.1) * MOVE_SPEED;
      this.myPos = clampToArena(
        { x: this.myPos.x + (input.x / l) * step, y: this.myPos.y + (input.y / l) * step },
        this.encounter.arenaRadius,
      );
    }
    const tick = Math.floor(this.hostTick());
    if (tick !== this.lastSentTick) {
      this.lastSentTick = tick;
      const x = r2(this.myPos.x);
      const y = r2(this.myPos.y);
      this.link.send({ t: "pos", tick, x, y });
      this.myHistory.push({ tick, x, y });
      if (this.myHistory.length > 120) this.myHistory.shift();
    }
    // Drop hazards that finished well in the past.
    for (const [id, h] of this.hazards) if (tick > h.resolveTick + 45) this.hazards.delete(id);
  }

  /** Positions to draw this frame. */
  renderPositions(): Map<string, Vec2> {
    const out = new Map<string, Vec2>();
    const t = this.hostTick() - this.interpDelayTicks();
    for (const r of this.players.values()) {
      if (r.id === this.myId) {
        out.set(r.id, this.myPos);
        continue;
      }
      const b = r.buf;
      if (!b.length) continue;
      if (t <= b[0].tick) out.set(r.id, { x: b[0].x, y: b[0].y });
      else if (t >= b[b.length - 1].tick) {
        const last = b[b.length - 1];
        out.set(r.id, { x: last.x, y: last.y });
      } else {
        for (let i = b.length - 1; i > 0; i--) {
          const a = b[i - 1];
          const c = b[i];
          if (t >= a.tick && t <= c.tick) {
            const f = (t - a.tick) / Math.max(1e-6, c.tick - a.tick);
            out.set(r.id, { x: a.x + (c.x - a.x) * f, y: a.y + (c.y - a.y) * f });
            break;
          }
        }
      }
    }
    return out;
  }

  /** The mechanic currently being cast (for the cast bar). */
  currentCast(): { name: string; progress: number; secondsLeft: number } | undefined {
    const t = this.hostTick();
    let best: Hazard | undefined;
    for (const h of this.hazards.values()) {
      if (t >= h.startTick && t < h.resolveTick && (!best || h.resolveTick < best.resolveTick)) best = h;
    }
    if (!best) return undefined;
    return {
      name: best.name,
      progress: (t - best.startTick) / (best.resolveTick - best.startTick),
      secondsLeft: ((best.resolveTick - t) * TICK_MS) / 1000,
    };
  }

  distanceTo(id: string): number {
    const p = this.renderPositions().get(id);
    return p ? dist(p, this.myPos) : Infinity;
  }
}
