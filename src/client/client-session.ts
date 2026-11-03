import { ENCOUNTERS } from "../data";
import { actorsOf } from "../sim/actors";
import { compileStrategy, type CompiledStrategy } from "../sim/strategy";
import type { BotSettings } from "../sim/bots";
import { MOVE_SPEED, TICK_MS } from "../sim/constants";
import { clampToArena, degFromDir, dist } from "../sim/math";
import type { ActorDef, EncounterDef, Hazard, HitResult, Slot, Vec2 } from "../sim/types";
import { PROTOCOL_VERSION, r2, type HostMsg, type RosterEntry } from "../net/protocol";
import type { Link } from "../host/host-session";

interface Sample {
  tick: number;
  x: number;
  y: number;
  f: number;
}

interface Remote {
  id: string;
  slot: Slot;
  name: string;
  isBot: boolean;
  fails: number;
  buf: Sample[];
}

export interface FeedItem {
  ok: boolean;
  text: string;
  mine: boolean;
  at: number;
}

interface GhostSample {
  tick: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/** A position plus the compass direction (degrees) the character faces. */
export interface Placed extends Vec2 {
  facing: number;
}

export interface PlacedActor extends Placed {
  visible: boolean;
}

export interface GhostView {
  pos: Vec2;
  dest: Vec2;
  facing: number;
}

export interface TrackedHazard extends Hazard {
  result?: HitResult;
}

/** Interpolate between two compass angles the short way round. */
function lerpDeg(a: number, b: number, f: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * f + 360) % 360;
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
  myFacing = 0;
  actorDefs: ActorDef[] = [];
  strategy?: CompiledStrategy;
  private actorBuf = new Map<string, { tick: number; x: number; y: number; f: number; v: boolean }[]>();
  rtt = 0;
  readonly players = new Map<string, Remote>();
  readonly hazards = new Map<number, TrackedHazard>();
  readonly feed: FeedItem[] = [];
  pings: Record<string, number> = {};
  /** Seek epoch; position reports carry it so the host can drop stale ones. */
  epoch = 0;
  loopStartTick = 0;
  /** While paused, the clock stops and nobody can move. */
  paused = false;
  private pausedTick = 0;
  private ghostBuf: GhostSample[] = [];
  private ghostFacing = 0;

  onReady: () => void = () => {};
  onFull: (reason: string, taken: Slot[]) => void = () => {};
  onDisconnect: () => void = () => {};
  onRoster: () => void = () => {};
  onFeed: (item: FeedItem) => void = () => {};
  onBots: () => void = () => {};
  onSeek: (loopSeconds: number) => void = () => {};
  onPause: (paused: boolean) => void = () => {};

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
    requestedSlot?: Slot,
  ) {
    link.onMessage((m) => this.onMsg(m));
    link.onClose(() => {
      clearInterval(this.pingTimer);
      this.onDisconnect();
    });
    link.send({ t: "hello", name, version: PROTOCOL_VERSION, slot: requestedSlot });
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

  /** Best estimate of the host's current tick (fractional). Frozen while paused. */
  hostTick(now = performance.now()): number {
    if (this.paused) return this.pausedTick;
    if (this.tickOffset === undefined) return 0;
    const t = now / TICK_MS + this.tickOffset;
    // Never run backwards; small corrections are absorbed by slowing down.
    this.shownTick = Math.max(this.shownTick, t);
    return this.shownTick;
  }

  private syncClock(snapTick: number): void {
    if (this.paused) return;
    const now = performance.now();
    const measured = snapTick + this.rtt / 2 / TICK_MS - now / TICK_MS;
    if (this.tickOffset === undefined || Math.abs(measured - this.tickOffset) > 6) {
      this.tickOffset = measured;
      this.shownTick = now / TICK_MS + measured;
    } else {
      this.tickOffset += (measured - this.tickOffset) * 0.08;
    }
  }

  private setPaused(paused: boolean, tick: number): void {
    this.paused = paused;
    if (paused) {
      // Freeze exactly where the host stopped.
      this.pausedTick = tick;
      this.shownTick = tick;
    } else {
      // Carry on from the host's tick as if no time had passed.
      this.tickOffset = tick + this.rtt / 2 / TICK_MS - performance.now() / TICK_MS;
      this.shownTick = tick;
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
        const enc = ENCOUNTERS[m.encounterId];
        this.encounter = enc.def;
        this.actorDefs = actorsOf(enc.def);
        const stratDef = enc.strategies.find((x) => x.id === m.strategyId) ?? enc.strategies[0];
        this.strategy = compileStrategy(stratDef);
        this.bots = m.bots;
        this.epoch = m.epoch;
        this.loopStartTick = m.loopStartTick;
        for (const h of m.hazards) this.hazards.set(h.id, h);
        this.syncClock(m.tick);
        if (m.paused) this.setPaused(true, m.tick);
        this.ready = true;
        this.onReady();
        break;
      }
      case "full":
        this.onFull(m.reason, m.taken ?? []);
        break;
      case "pong": {
        const sample = performance.now() - m.c;
        this.rtt = this.rtt === 0 ? sample : this.rtt * 0.8 + sample * 0.2;
        break;
      }
      case "pause":
        this.setPaused(m.paused, m.tick);
        this.onPause(m.paused);
        break;
      case "snap": {
        if (!this.ready) return;
        this.syncClock(m.tick);
        for (const [id, x, y, f, vis] of m.a) {
          let b = this.actorBuf.get(id);
          if (!b) this.actorBuf.set(id, (b = []));
          b.push({ tick: m.tick, x, y, f, v: vis === 1 });
          if (b.length > 40) b.shift();
        }
        for (const [id, x, y, fails, f] of m.p) {
          let r = this.players.get(id);
          if (!r) {
            r = { id, slot: "MT", name: id, isBot: id.startsWith("bot:"), fails, buf: [] };
            this.players.set(id, r);
          }
          r.fails = fails;
          if (id === this.myId) {
            if (!this.gotFirstSnap) {
              this.myPos = { x, y };
              this.myFacing = f;
              this.gotFirstSnap = true;
            } else {
              this.reconcile(m.tick, x, y);
            }
            continue;
          }
          r.buf.push({ tick: m.tick, x, y, f });
          if (r.buf.length > 40) r.buf.shift();
        }
        for (const [id, x, y, dx, dy] of m.g) {
          if (id !== this.myId) continue;
          this.ghostBuf.push({ tick: m.tick, x, y, dx, dy });
          if (this.ghostBuf.length > 40) this.ghostBuf.shift();
        }
        const present = new Set(m.p.map((p) => p[0]));
        for (const id of this.players.keys()) if (!present.has(id)) this.players.delete(id);
        break;
      }
      case "hazard":
        this.hazards.set(m.h.id, m.h);
        break;
      case "seek": {
        this.epoch = m.epoch;
        this.loopStartTick = m.loopStartTick;
        this.hazards.clear();
        this.ghostBuf = [];
        this.myHistory = [];
        for (const r of this.players.values()) r.buf = [];
        this.actorBuf.clear();
        const mine = m.positions[this.myId];
        if (mine) {
          this.myPos = { x: mine[0], y: mine[1] };
          this.ghostBuf.push({ tick: m.tick, x: mine[0], y: mine[1], dx: mine[0], dy: mine[1] });
        }
        if (this.paused) {
          this.pausedTick = m.tick;
          this.shownTick = m.tick;
        }
        this.lastSentTick = -1;
        this.onSeek((m.tick - m.loopStartTick) * TICK_MS / 1000);
        break;
      }
      case "result": {
        const h = this.hazards.get(m.r.hazardId);
        if (h) {
          h.result = m.r;
          // Untelegraphed mechanics reveal where they landed.
          if (m.r.shapes) {
            h.shapes = m.r.shapes;
            h.hidden = false;
          }
        }
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

  /**
   * Move our own character (input is a world-space direction) and report our
   * position once per host tick. Nothing moves while the encounter is paused.
   */
  update(dtSec: number, input: Vec2): void {
    if (!this.ready || !this.gotFirstSnap || this.paused) return;
    const l = Math.hypot(input.x, input.y);
    if (l > 0) {
      // Cap long frames (e.g. after a tab switch) but keep slow machines moving at full speed.
      const step = Math.min(dtSec, 0.25) * MOVE_SPEED;
      this.myPos = clampToArena(
        { x: this.myPos.x + (input.x / l) * step, y: this.myPos.y + (input.y / l) * step },
        this.encounter.arenaRadius,
      );
      this.myFacing = degFromDir(input);
    }
    const tick = Math.floor(this.hostTick());
    if (tick !== this.lastSentTick) {
      this.lastSentTick = tick;
      const x = r2(this.myPos.x);
      const y = r2(this.myPos.y);
      this.link.send({ t: "pos", tick, x, y, e: this.epoch, f: Math.round(this.myFacing) });
      this.myHistory.push({ tick, x, y });
      if (this.myHistory.length > 120) this.myHistory.shift();
    }
    // Drop hazards that finished well in the past.
    for (const [id, h] of this.hazards) if (tick > h.resolveTick + 45) this.hazards.delete(id);
  }

  /** Bosses, adds and objects to draw this frame (interpolated like other players). */
  renderActors(): Map<string, PlacedActor> {
    const out = new Map<string, PlacedActor>();
    const t = this.hostTick() - this.interpDelayTicks();
    for (const [id, b] of this.actorBuf) {
      if (!b.length) continue;
      let a = b[0];
      let c = b[b.length - 1];
      for (let i = b.length - 1; i > 0; i--) {
        if (t >= b[i - 1].tick) {
          a = b[i - 1];
          c = b[i];
          break;
        }
      }
      const f = c.tick === a.tick ? 1 : Math.max(0, Math.min(1, (t - a.tick) / (c.tick - a.tick)));
      out.set(id, { x: a.x + (c.x - a.x) * f, y: a.y + (c.y - a.y) * f, facing: lerpDeg(a.f, c.f, f), visible: f < 0.5 ? a.v : c.v });
    }
    return out;
  }

  /** Positions and facings to draw this frame. Actors are included as "actor:<id>". */
  renderPositions(): Map<string, Placed> {
    const out = new Map<string, Placed>();
    for (const [id, a] of this.renderActors()) out.set(`actor:${id}`, a);
    const t = this.hostTick() - this.interpDelayTicks();
    for (const r of this.players.values()) {
      if (r.id === this.myId) {
        out.set(r.id, { ...this.myPos, facing: this.myFacing });
        continue;
      }
      const b = r.buf;
      if (!b.length) continue;
      if (t <= b[0].tick) out.set(r.id, { x: b[0].x, y: b[0].y, facing: b[0].f });
      else if (t >= b[b.length - 1].tick) {
        const last = b[b.length - 1];
        out.set(r.id, { x: last.x, y: last.y, facing: last.f });
      } else {
        for (let i = b.length - 1; i > 0; i--) {
          const a = b[i - 1];
          const c = b[i];
          if (t >= a.tick && t <= c.tick) {
            const f = (t - a.tick) / Math.max(1e-6, c.tick - a.tick);
            out.set(r.id, { x: a.x + (c.x - a.x) * f, y: a.y + (c.y - a.y) * f, facing: lerpDeg(a.f, c.f, f) });
            break;
          }
        }
      }
    }
    return out;
  }

  /** Seconds into the encounter loop at the current host time (negative during lead-in). */
  loopTime(): number {
    const t = (this.hostTick() - this.loopStartTick) * TICK_MS / 1000;
    return t < 0 ? t : t % this.encounter.loopLength;
  }

  /** Where a perfect player in your slot is right now, and where they're heading. */
  ghost(): GhostView | undefined {
    const b = this.ghostBuf;
    if (!b.length) return undefined;
    const t = this.hostTick() - this.interpDelayTicks();
    let a = b[0];
    let c = b[b.length - 1];
    for (let i = b.length - 1; i > 0; i--) {
      if (t >= b[i - 1].tick) {
        a = b[i - 1];
        c = b[i];
        break;
      }
    }
    const f = c.tick === a.tick ? 1 : Math.max(0, Math.min(1, (t - a.tick) / (c.tick - a.tick)));
    const pos = { x: a.x + (c.x - a.x) * f, y: a.y + (c.y - a.y) * f };
    const dest = { x: c.dx, y: c.dy };
    // The ghost faces where it is heading; when it has arrived it keeps its facing.
    if (dist(pos, dest) > 0.3) this.ghostFacing = degFromDir({ x: dest.x - pos.x, y: dest.y - pos.y });
    return { pos, dest, facing: this.ghostFacing };
  }

  /** The mechanic currently being cast (for the cast bar). */
  currentCast(): { name: string; progress: number; secondsLeft: number } | undefined {
    const t = this.hostTick();
    let best: Hazard | undefined;
    for (const h of this.hazards.values()) {
      if (h.mechType === "zone") continue; // lingering hazards aren't casts
      if (t >= h.startTick && t < h.resolveTick && (!best || h.resolveTick < best.resolveTick)) best = h;
    }
    if (!best) return undefined;
    return {
      name: best.name,
      progress: (t - best.startTick) / (best.resolveTick - best.startTick),
      secondsLeft: ((best.resolveTick - t) * TICK_MS) / 1000,
    };
  }
}
