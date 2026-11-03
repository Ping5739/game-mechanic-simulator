import { BotBrain, type BotSettings } from "./bots";
import { HISTORY_TICKS, MOVE_SPEED, RESOLVE_GRACE_TICKS, TICK_RATE } from "./constants";
import { clampToArena, degFromDir, dirFromDeg, dist, inShape, norm, scale, sub, v } from "./math";
import { Rng } from "./rng";
import type { CompiledStrategy } from "./strategy";
import {
  SLOTS,
  roleOf,
  type Anchor,
  type EncounterDef,
  type Hazard,
  type HitResult,
  type InputSample,
  type PlayerState,
  type Shape,
  type Slot,
  type Vec2,
} from "./types";

export interface Ghost {
  pos: Vec2;
  /** Where the ghost is heading right now. */
  dest: Vec2;
  brain: BotBrain;
}

export interface SeekResult {
  epoch: number;
  loopStartTick: number;
  /** New positions for every human (they get teleported here). */
  positions: Record<string, Vec2>;
  /** Mechanics already mid-cast at the new time. */
  hazards: Hazard[];
}

export interface StepEvents {
  hazards: Hazard[];
  results: HitResult[];
  rosterChanged: boolean;
}

interface HistoryEntry {
  tick: number;
  pos: Vec2;
}

/**
 * Deterministic, authoritative encounter simulation.
 *
 * It knows nothing about rendering or networking: the host feeds it human
 * position samples and calls step() at a fixed rate. Given the same seed and
 * the same inputs it always produces the same results, which is what makes
 * replays and log reviews trustworthy.
 */
export class Simulation {
  tick = 0;
  readonly players = new Map<string, PlayerState>();
  readonly hazards = new Map<number, Hazard>();
  /** A "perfect player" per human, showing where they should be. */
  readonly ghosts = new Map<string, Ghost>();
  /** Bumped on every seek; position reports from an older epoch are ignored. */
  epoch = 0;
  loopStartTick = 0;
  /** The boss turns to face its directional attacks (cones, lines). */
  bossFacing = 0;

  private readonly history = new Map<string, HistoryEntry[]>();
  private readonly lastSample = new Map<string, HistoryEntry>();
  private readonly bots = new Map<string, BotBrain>();
  private readonly rng: Rng;
  private nextHazardId = 1;
  private timelineIndex = 0;
  private rosterChanged = true;

  constructor(
    readonly encounter: EncounterDef,
    readonly strategy: CompiledStrategy,
    readonly seed: number,
    private botSettings: BotSettings,
    /** Seconds before the first loop starts, so people can get ready. */
    leadInSeconds = 3,
  ) {
    this.rng = new Rng(seed);
    this.loopStartTick = Math.round(leadInSeconds * TICK_RATE);
    for (const slot of SLOTS) this.spawnBot(slot);
  }

  // -------------------------------------------------------------------------
  // Roster
  // -------------------------------------------------------------------------

  private spawnBot(slot: Slot, at?: Vec2): void {
    const id = `bot:${slot}`;
    const pos = at ?? { ...this.strategy.defaults[slot] };
    this.players.set(id, { id, slot, name: `${slot} (bot)`, isBot: true, pos, facing: 0, fails: 0 });
    this.bots.set(id, new BotBrain(id, slot, this.seed ^ slot.charCodeAt(0) * 7919 ^ slot.charCodeAt(1) * 104729, this.botSettings));
    this.history.set(id, [{ tick: this.tick, pos: { ...pos } }]);
    this.rosterChanged = true;
  }

  /** A human takes over a slot (the first free bot slot if none is given). */
  addHuman(id: string, name: string, preferred?: Slot): Slot | undefined {
    const existing = this.players.get(id);
    if (existing) return existing.slot;
    const freeSlots = SLOTS.filter((s) => this.players.has(`bot:${s}`));
    const slot = preferred && freeSlots.includes(preferred) ? preferred : freeSlots[0];
    if (!slot) return undefined;
    const bot = this.players.get(`bot:${slot}`)!;
    this.players.delete(bot.id);
    this.bots.delete(bot.id);
    this.history.delete(bot.id);
    const pos = { ...bot.pos };
    this.players.set(id, { id, slot, name, isBot: false, pos, facing: bot.facing, fails: 0 });
    this.history.set(id, [{ tick: this.tick, pos: { ...pos } }]);
    this.lastSample.set(id, { tick: this.tick, pos: { ...pos } });
    this.ghosts.set(id, { pos: { ...pos }, dest: { ...pos }, brain: this.perfectBrain(id, slot) });
    this.rosterChanged = true;
    return slot;
  }

  /** A human leaves; a bot takes their slot back from where they stood. */
  removeHuman(id: string): void {
    const p = this.players.get(id);
    if (!p || p.isBot) return;
    this.players.delete(id);
    this.history.delete(id);
    this.lastSample.delete(id);
    this.ghosts.delete(id);
    this.spawnBot(p.slot, p.pos);
  }

  private perfectBrain(id: string, slot: Slot): BotBrain {
    return new BotBrain(id, slot, 1, { difficulty: "perfect", mistakeChance: 0 });
  }

  setBotSettings(settings: BotSettings): void {
    this.botSettings = settings;
    for (const b of this.bots.values()) b.settings = settings;
  }

  // -------------------------------------------------------------------------
  // Human input
  // -------------------------------------------------------------------------

  /**
   * Accept a position report from a human client. Clients move themselves
   * (so their own movement feels instant); the host only sanity-checks that
   * the report is inside the arena and not faster than movement allows.
   */
  applySample(sample: InputSample): void {
    const p = this.players.get(sample.playerId);
    if (!p || p.isBot) return;
    if ((sample.epoch ?? 0) !== this.epoch) return; // sent before a seek
    const prev = this.lastSample.get(p.id);
    let pos = clampToArena(sample.pos, this.encounter.arenaRadius);
    let tick = Math.round(sample.tick);
    if (prev) {
      if (tick <= prev.tick) tick = prev.tick; // never go backwards in time
      const maxStep = (MOVE_SPEED * Math.max(1, tick - prev.tick)) / TICK_RATE * 1.5 + 0.5;
      const delta = sub(pos, prev.pos);
      const d = Math.hypot(delta.x, delta.y);
      if (d > maxStep) pos = { x: prev.pos.x + (delta.x / d) * maxStep, y: prev.pos.y + (delta.y / d) * maxStep };
    }
    p.pos = pos;
    if (typeof sample.facing === "number" && Number.isFinite(sample.facing)) p.facing = ((sample.facing % 360) + 360) % 360;
    const entry = { tick, pos: { ...pos } };
    this.lastSample.set(p.id, entry);
    this.pushHistory(p.id, entry);
  }

  private pushHistory(id: string, entry: HistoryEntry): void {
    const h = this.history.get(id);
    if (!h) return;
    const last = h[h.length - 1];
    if (last && last.tick === entry.tick) h[h.length - 1] = entry;
    else h.push(entry);
    const cutoff = this.tick - HISTORY_TICKS;
    while (h.length > 2 && h[0].tick < cutoff) h.shift();
  }

  /** Where a player was at a given tick (latest known position at or before it). */
  positionAt(id: string, tick: number): Vec2 | undefined {
    const h = this.history.get(id);
    if (!h || h.length === 0) return this.players.get(id)?.pos;
    let best = h[0];
    for (const e of h) {
      if (e.tick <= tick) best = e;
      else break;
    }
    return best.pos;
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  step(): StepEvents {
    this.tick++;
    const events: StepEvents = { hazards: [], results: [], rosterChanged: false };

    this.scheduleTimeline(events);

    // Bots think and move.
    for (const [id, brain] of this.bots) {
      const p = this.players.get(id)!;
      const before = p.pos;
      p.pos = this.moveToward(p.pos, brain.decide(this, p));
      if (dist(before, p.pos) > 1e-4) p.facing = degFromDir(sub(p.pos, before));
      this.pushHistory(id, { tick: this.tick, pos: { ...p.pos } });
    }

    // Ghosts move exactly like a perfect bot in the human's slot would.
    for (const [id, g] of this.ghosts) {
      const p = this.players.get(id);
      if (!p) continue;
      g.dest = g.brain.decide(this, { ...p, pos: g.pos });
      g.pos = this.moveToward(g.pos, g.dest);
    }

    this.resolveDue(events);

    if (this.rosterChanged) {
      events.rosterChanged = true;
      this.rosterChanged = false;
    }
    return events;
  }

  private moveToward(from: Vec2, target: Vec2): Vec2 {
    const d = dist(from, target);
    if (d <= 1e-3) return from;
    const stepLen = Math.min(d, MOVE_SPEED / TICK_RATE);
    const dir = norm(sub(target, from));
    return clampToArena({ x: from.x + dir.x * stepLen, y: from.y + dir.y * stepLen }, this.encounter.arenaRadius);
  }

  /** Seconds into the current loop (negative during the lead-in). */
  loopTime(): number {
    return (this.tick - this.loopStartTick) / TICK_RATE;
  }

  /**
   * Jump the encounter to a moment in the loop. Mechanics already being cast
   * at that moment are restarted mid-cast, and everyone is placed where the
   * strategy says they should be at that moment.
   */
  seekTo(seconds: number): SeekResult {
    const loopTicks = Math.round(this.encounter.loopLength * TICK_RATE);
    const t = Math.max(0, Math.min(loopTicks - 1, Math.round(seconds * TICK_RATE)));
    this.epoch++;
    this.hazards.clear();
    this.loopStartTick = this.tick - t;

    const spawned: Hazard[] = [];
    let idx = 0;
    for (const entry of this.encounter.timeline) {
      const start = this.loopStartTick + Math.round(entry.at * TICK_RATE);
      if (start > this.tick) break;
      const resolve = start + Math.round(entry.cast * TICK_RATE);
      if (resolve > this.tick) {
        const h = this.spawnHazard(entry.mechanic, entry.key, start, resolve);
        this.hazards.set(h.id, h);
        spawned.push(h);
      }
      idx++;
    }
    this.timelineIndex = idx;

    // Place everyone where a perfect player would be heading at this moment.
    const positions: Record<string, Vec2> = {};
    const perfect = new Map<string, BotBrain>();
    for (const p of this.players.values()) perfect.set(p.id, this.perfectBrain(p.id, p.slot));
    // Two passes so players who follow someone (e.g. a stack) see the
    // target's new position rather than where they stood before the jump.
    for (let pass = 0; pass < 2; pass++) {
      for (const p of this.players.values()) {
        p.pos = perfect.get(p.id)!.decide(this, { ...p, pos: { ...this.strategy.defaults[p.slot] } });
      }
    }
    for (const p of this.players.values()) {
      const pos = p.pos;
      this.history.set(p.id, [{ tick: this.tick, pos: { ...pos } }]);
      if (!p.isBot) {
        this.lastSample.set(p.id, { tick: this.tick, pos: { ...pos } });
        const g = this.ghosts.get(p.id);
        if (g) {
          g.pos = { ...pos };
          g.dest = { ...pos };
        }
        positions[p.id] = { ...pos };
      }
    }
    return { epoch: this.epoch, loopStartTick: this.loopStartTick, positions, hazards: spawned };
  }

  private scheduleTimeline(events: StepEvents): void {
    const tl = this.encounter.timeline;
    const loopTicks = Math.round(this.encounter.loopLength * TICK_RATE);
    if (this.tick >= this.loopStartTick + loopTicks) {
      this.loopStartTick += loopTicks;
      this.timelineIndex = 0;
    }
    while (this.timelineIndex < tl.length) {
      const entry = tl[this.timelineIndex];
      const startTick = this.loopStartTick + Math.round(entry.at * TICK_RATE);
      if (startTick > this.tick) break;
      const hazard = this.spawnHazard(entry.mechanic, entry.key, startTick, startTick + Math.round(entry.cast * TICK_RATE));
      this.hazards.set(hazard.id, hazard);
      events.hazards.push(hazard);
      this.timelineIndex++;
    }
  }

  private resolveAnchor(a: Anchor): { pos: Vec2; player?: string } {
    switch (a.kind) {
      case "boss":
        return { pos: v(0, 0) };
      case "point":
        return { pos: v(a.x, a.y) };
      case "randomPlayer": {
        const ids = [...this.players.keys()].sort();
        const id = this.rng.pick(ids);
        return { pos: { ...this.players.get(id)!.pos }, player: id };
      }
      case "randomRole": {
        const ids = [...this.players.values()].filter((p) => roleOf(p.slot) === a.role).map((p) => p.id).sort();
        const id = ids.length ? this.rng.pick(ids) : this.rng.pick([...this.players.keys()].sort());
        return { pos: { ...this.players.get(id)!.pos }, player: id };
      }
    }
  }

  private spawnHazard(m: EncounterDef["timeline"][number]["mechanic"], key: string | undefined, startTick: number, resolveTick: number): Hazard {
    const base = { id: this.nextHazardId++, name: m.name, key, mechType: m.type, startTick, resolveTick };
    const R = this.encounter.arenaRadius;
    switch (m.type) {
      case "circle": {
        if (m.count && m.count > 1) {
          const shapes: Shape[] = [];
          const minSep = m.spread ?? m.radius;
          let guard = 0;
          while (shapes.length < m.count && guard++ < 500) {
            const ang = this.rng.next() * Math.PI * 2;
            const r = Math.sqrt(this.rng.next()) * (R - m.radius * 0.5);
            const c = v(Math.cos(ang) * r, Math.sin(ang) * r);
            if (shapes.every((s) => s.kind === "circle" && !("player" in s.c) && dist(s.c, c) >= minSep)) {
              shapes.push({ kind: "circle", c, r: m.radius });
            }
          }
          return { ...base, shapes };
        }
        const a = this.resolveAnchor(m.at);
        return { ...base, shapes: [{ kind: "circle", c: a.pos, r: m.radius }] };
      }
      case "donut": {
        const a = this.resolveAnchor(m.at);
        return { ...base, shapes: [{ kind: "donut", c: a.pos, r0: m.inner, r1: m.outer }] };
      }
      case "line": {
        const a = this.resolveAnchor(m.toward);
        const dir = norm(a.pos.x === 0 && a.pos.y === 0 ? dirFromDeg(this.rng.int(4) * 90) : a.pos);
        const origin = scale(dir, -m.length / 2);
        this.bossFacing = degFromDir(dir);
        return { ...base, shapes: [{ kind: "rect", origin, dir, length: m.length, width: m.width }], targets: a.player ? [a.player] : undefined };
      }
      case "cone": {
        const deg = m.facingDeg === "randomCardinal" ? this.rng.int(4) * 90 : m.facingDeg;
        this.bossFacing = deg;
        return {
          ...base,
          shapes: [{ kind: "cone", origin: v(0, 0), dir: dirFromDeg(deg), r: m.radius, halfAngle: (m.angleDeg * Math.PI) / 360 }],
        };
      }
      case "spread": {
        const ids = [...this.players.keys()].sort();
        return { ...base, shapes: ids.map((id) => ({ kind: "circle", c: { player: id }, r: m.radius })), targets: ids };
      }
      case "stack": {
        const a = this.resolveAnchor(m.on);
        const target = a.player ?? this.rng.pick([...this.players.keys()].sort());
        return { ...base, shapes: [{ kind: "circle", c: { player: target }, r: m.radius }], targets: [target], minPlayers: m.minPlayers };
      }
    }
  }

  /** Has every human reported a position for this tick (or is the grace period over)? */
  private readyToJudge(resolveTick: number): boolean {
    if (this.tick < resolveTick) return false;
    if (this.tick >= resolveTick + RESOLVE_GRACE_TICKS) return true;
    for (const p of this.players.values()) {
      if (p.isBot) continue;
      const last = this.lastSample.get(p.id);
      if (!last || last.tick < resolveTick) return false;
    }
    return true;
  }

  private resolveDue(events: StepEvents): void {
    for (const h of [...this.hazards.values()].sort((a, b) => a.resolveTick - b.resolveTick)) {
      if (!this.readyToJudge(h.resolveTick)) continue;
      this.hazards.delete(h.id);
      const result = this.judge(h);
      for (const id of result.failed) {
        const p = this.players.get(id);
        if (p) p.fails++;
      }
      events.results.push(result);
    }
  }

  /** Decide who failed a hazard, using everyone's position at its resolve tick. */
  judge(h: Hazard): HitResult {
    const T = h.resolveTick;
    const posAt = (id: string) => this.positionAt(id, T);
    const ids = [...this.players.keys()].sort();
    const failed = new Set<string>();
    const reasons: string[] = [];
    const label = (id: string) => this.players.get(id)?.slot ?? id;

    if (h.mechType === "spread") {
      for (const target of h.targets ?? []) {
        const c = posAt(target);
        if (!c) continue;
        const r = (h.shapes[0] as { r: number }).r;
        for (const other of ids) {
          if (other === target) continue;
          const p = posAt(other);
          if (p && dist(p, c) <= r) {
            failed.add(other);
            failed.add(target);
            reasons.push(`${label(target)}'s spread clipped ${label(other)}`);
          }
        }
      }
    } else if (h.mechType === "stack") {
      const target = h.targets![0];
      const c = posAt(target);
      const r = (h.shapes[0] as { r: number }).r;
      if (c) {
        const inside = ids.filter((id) => {
          const p = posAt(id);
          return p !== undefined && dist(p, c) <= r;
        });
        const need = h.minPlayers ?? 1;
        if (inside.length < need) {
          for (const id of inside) failed.add(id);
          reasons.push(`${h.name} on ${label(target)} had ${inside.length}/${need} players`);
        }
      }
    } else {
      for (const id of ids) {
        const p = posAt(id);
        if (p && h.shapes.some((s) => inShape(p, s, posAt))) {
          failed.add(id);
          reasons.push(`${label(id)} was hit by ${h.name}`);
        }
      }
    }

    return { hazardId: h.id, name: h.name, tick: T, failed: [...failed], reasons };
  }

  snapshotPlayers(): PlayerState[] {
    return [...this.players.values()].map((p) => ({ ...p, pos: { ...p.pos } }));
  }
}
