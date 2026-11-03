import { actorStateAt, actorsOf, lastFacingKeyAt } from "./actors";
import { BotBrain, type BotSettings } from "./bots";
import { HISTORY_TICKS, MOVE_SPEED, RESOLVE_GRACE_TICKS, TICK_RATE } from "./constants";
import { clampToArena, degFromDir, dirFromDeg, dist, inShape, norm, scale, sub, v } from "./math";
import { Rng } from "./rng";
import type { CompiledStrategy } from "./strategy";
import {
  SLOTS,
  roleOf,
  type ActorDef,
  type ActorState,
  type Anchor,
  type EncounterDef,
  type Hazard,
  type HitResult,
  type InputSample,
  type MechanicDef,
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

/** Lookup keys for actors share the player id space with this prefix. */
export const ACTOR_PREFIX = "actor:";

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
  readonly actorDefs: ActorDef[];

  private readonly actorById = new Map<string, ActorDef>();
  /** Facing set by a directional attack, which wins over keyframes set earlier. */
  private readonly facingOverride = new Map<string, { deg: number; tick: number }>();
  private readonly history = new Map<string, HistoryEntry[]>();
  private readonly lastSample = new Map<string, HistoryEntry>();
  private readonly bots = new Map<string, BotBrain>();
  private readonly zoneTouched = new Map<number, Map<string, string>>();
  private readonly rng: Rng;
  private nextHazardId = 1;
  private timelineIndex = 0;
  private rosterChanged = true;
  private readonly loopTicks: number;

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
    this.loopTicks = Math.round(encounter.loopLength * TICK_RATE);
    this.actorDefs = actorsOf(encounter);
    for (const a of this.actorDefs) this.actorById.set(a.id, a);
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

  /**
   * A human takes over a slot: the requested one, or the first free one if
   * none is requested. Returns undefined if the requested slot is held by
   * another human (each role belongs to one player) or the party is full.
   */
  addHuman(id: string, name: string, preferred?: Slot): Slot | undefined {
    const existing = this.players.get(id);
    if (existing) return existing.slot;
    const freeSlots = SLOTS.filter((s) => this.players.has(`bot:${s}`));
    const slot = preferred ? (freeSlots.includes(preferred) ? preferred : undefined) : freeSlots[0];
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

  /** Slots currently held by humans. */
  humanSlots(): Slot[] {
    return SLOTS.filter((s) => !this.players.has(`bot:${s}`));
  }

  /** Who fills a slot right now (bot or human). */
  occupant(slot: Slot): string | undefined {
    for (const p of this.players.values()) if (p.slot === slot) return p.id;
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Actors
  // -------------------------------------------------------------------------

  /** Loop seconds at a tick (handles ticks from just before the loop wrapped). */
  loopTimeAt(tick: number): number {
    let t = tick - this.loopStartTick;
    if (t < 0 && this.loopStartTick - this.loopTicks >= 0 && tick >= this.loopStartTick - this.loopTicks) t += this.loopTicks;
    return t / TICK_RATE;
  }

  actorAt(id: string, tick = this.tick): ActorState | undefined {
    const def = this.actorById.get(id);
    if (!def) return undefined;
    const t = this.loopTimeAt(tick);
    const s = actorStateAt(def, t);
    const o = this.facingOverride.get(id);
    if (o && o.tick <= tick && this.loopTimeAt(o.tick) >= lastFacingKeyAt(def, t)) s.facing = o.deg;
    return s;
  }

  actorStates(): ActorState[] {
    return this.actorDefs.map((d) => this.actorAt(d.id)!);
  }

  /** Position of a player, or of an actor when the id starts with "actor:". */
  posAt(id: string, tick: number): Vec2 | undefined {
    if (id.startsWith(ACTOR_PREFIX)) return this.actorAt(id.slice(ACTOR_PREFIX.length), tick)?.pos;
    return this.positionAt(id, tick);
  }

  /** Current position of a player or actor. */
  currentPos(id: string): Vec2 | undefined {
    if (id.startsWith(ACTOR_PREFIX)) return this.actorAt(id.slice(ACTOR_PREFIX.length))?.pos;
    return this.players.get(id)?.pos;
  }

  private faceActor(id: string, deg: number, tick: number): void {
    if (this.actorById.has(id)) this.facingOverride.set(id, { deg, tick });
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

    this.checkZones();
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
    const t = Math.max(0, Math.min(this.loopTicks - 1, Math.round(seconds * TICK_RATE)));
    this.epoch++;
    this.hazards.clear();
    this.zoneTouched.clear();
    this.facingOverride.clear();
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
        p.pos = perfect.get(p.id)!.decide(this, { ...p, pos: { ...this.strategy.defaults[p.slot] } }, true);
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
    if (this.tick >= this.loopStartTick + this.loopTicks) {
      this.loopStartTick += this.loopTicks;
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

  /** Resolve an anchor to a position (and the player or actor it refers to). */
  private resolveAnchor(a: Anchor, tick = this.tick): { pos: Vec2; player?: string; actor?: string } {
    switch (a.kind) {
      case "boss": {
        const boss = this.actorAt("boss", tick);
        return { pos: boss ? { ...boss.pos } : v(0, 0), actor: boss ? "boss" : undefined };
      }
      case "point":
        return { pos: v(a.x, a.y) };
      case "actor": {
        const s = this.actorAt(a.id, tick);
        return { pos: s ? { ...s.pos } : v(0, 0), actor: a.id };
      }
      case "slot": {
        const id = this.occupant(a.slot);
        return { pos: { ...(id ? this.posAt(id, tick) ?? v(0, 0) : v(0, 0)) }, player: id };
      }
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

  private spawnHazard(m: MechanicDef, key: string | undefined, startTick: number, resolveTick: number): Hazard {
    const base: Hazard = { id: this.nextHazardId++, name: m.name, key, mechType: m.type, startTick, resolveTick, shapes: [] };
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
          return { ...base, shapes, allowedHits: m.allowedHits };
        }
        const a = this.resolveAnchor(m.at);
        const follow = m.follow && (a.actor || a.player);
        const c = follow ? { player: a.actor ? ACTOR_PREFIX + a.actor : a.player! } : a.pos;
        return { ...base, shapes: [{ kind: "circle", c, r: m.radius }], allowedHits: m.allowedHits };
      }
      case "donut": {
        const a = this.resolveAnchor(m.at);
        return { ...base, shapes: [{ kind: "donut", c: a.pos, r0: m.inner, r1: m.outer }] };
      }
      case "line": {
        const a = this.resolveAnchor(m.toward);
        const dir = norm(a.pos.x === 0 && a.pos.y === 0 ? dirFromDeg(this.rng.int(4) * 90) : a.pos);
        const origin = scale(dir, -m.length / 2);
        this.faceActor("boss", degFromDir(dir), startTick);
        return { ...base, shapes: [{ kind: "rect", origin, dir, length: m.length, width: m.width }], targets: a.player ? [a.player] : undefined };
      }
      case "cone": {
        const src = this.resolveAnchor(m.from ?? { kind: "boss" });
        const deg = m.facingDeg === "randomCardinal" ? this.rng.int(4) * 90 : (m.facingDeg ?? 0);
        this.faceActor(src.actor ?? "boss", deg, startTick);
        return {
          ...base,
          shapes: [{ kind: "cone", origin: src.pos, dir: dirFromDeg(deg), r: m.radius, halfAngle: (m.angleDeg * Math.PI) / 360 }],
        };
      }
      case "spread": {
        const ids = m.on ? m.on.map((s) => this.occupant(s)).filter((x): x is string => !!x) : [...this.players.keys()].sort();
        return { ...base, shapes: ids.map((id) => ({ kind: "circle", c: { player: id }, r: m.radius })), targets: ids };
      }
      case "stack": {
        const a = this.resolveAnchor(m.on);
        const target = a.player ?? this.rng.pick([...this.players.keys()].sort());
        return { ...base, shapes: [{ kind: "circle", c: { player: target }, r: m.radius }], targets: [target], minPlayers: m.minPlayers };
      }
      case "protean": {
        if (!m.telegraphed) return { ...base, def: m, hidden: true };
        // Locked onto the nearest players right now, and drawn for everyone to dodge.
        const src = this.resolveAnchor(m.from);
        const half = (m.angleDeg * Math.PI) / 360;
        const ids = [...this.players.keys()]
          .sort()
          .map((id) => ({ id, d: dist(this.players.get(id)!.pos, src.pos) }))
          .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1))
          .slice(0, m.count)
          .map((x) => x.id);
        const shapes: Shape[] = ids.map((id) => ({ kind: "cone", origin: { ...src.pos }, dir: norm(sub(this.players.get(id)!.pos, src.pos)), r: m.radius, halfAngle: half }));
        if (m.front && src.actor) {
          const facing = this.actorAt(src.actor)!.facing;
          shapes.push({ kind: "cone", origin: { ...src.pos }, dir: dirFromDeg(facing), r: m.radius, halfAngle: half });
        }
        return { ...base, def: m, shapes, targets: ids };
      }
      case "baited":
      case "cleave":
        // Decided when they resolve; nothing to draw before then.
        return { ...base, def: m, hidden: true };
      case "raidwide":
        return { ...base, def: m };
      case "zone": {
        const a = this.resolveAnchor(m.at);
        const c = a.actor ? { player: ACTOR_PREFIX + a.actor } : a.player ? { player: a.player } : a.pos;
        this.zoneTouched.set(base.id, new Map());
        return { ...base, def: m, shapes: [{ kind: "circle", c, r: m.radius }] };
      }
    }
  }

  /** Persistent zones: anyone touching one while it's active fails it. */
  private checkZones(): void {
    for (const h of this.hazards.values()) {
      if (h.mechType !== "zone" || this.tick < h.startTick || this.tick > h.resolveTick) continue;
      const shape = h.shapes[0];
      if (shape.kind === "circle" && "player" in shape.c && shape.c.player.startsWith(ACTOR_PREFIX)) {
        const actor = this.actorAt(shape.c.player.slice(ACTOR_PREFIX.length));
        if (!actor?.visible) continue;
      }
      const touched = this.zoneTouched.get(h.id)!;
      const lookup = (id: string) => this.currentPos(id);
      for (const p of this.players.values()) {
        if (touched.has(p.id)) continue;
        if (inShape(p.pos, shape, lookup)) touched.set(p.id, `${p.slot} touched ${h.name}`);
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
      this.zoneTouched.delete(h.id);
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
    const posAt = (id: string) => this.posAt(id, T);
    const ids = [...this.players.keys()].sort();
    const failed = new Set<string>();
    const reasons: string[] = [];
    const label = (id: string) => this.players.get(id)?.slot ?? id;
    const result = (shapes?: Shape[]): HitResult => ({ hazardId: h.id, name: h.name, tick: T, failed: [...failed], reasons, shapes });
    const m = h.def;

    if ((m?.type === "protean" && !m.telegraphed) || m?.type === "baited") {
      const src = this.resolveAnchor(m.from, T).pos;
      const byDist = ids
        .map((id) => ({ id, d: dist(posAt(id) ?? src, src) }))
        .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));
      const picked = (m.type === "baited" && m.pick === "farthest" ? byDist.reverse() : byDist).slice(0, m.count).map((x) => x.id);
      const shapes: Shape[] = picked.map((id) => {
        const p = posAt(id)!;
        return m.type === "protean"
          ? { kind: "cone", origin: src, dir: norm(sub(p, src)), r: m.radius, halfAngle: (m.angleDeg * Math.PI) / 360 }
          : { kind: "circle", c: { ...p }, r: m.radius };
      });
      // The wave straight ahead of the boss belongs to nobody: anyone in it fails.
      let front: Shape | undefined;
      if (m.type === "protean" && m.front) {
        const actorId = m.from.kind === "actor" ? m.from.id : m.from.kind === "boss" ? "boss" : undefined;
        const facing = actorId ? this.actorAt(actorId, T)?.facing : undefined;
        if (facing !== undefined) front = { kind: "cone", origin: src, dir: dirFromDeg(facing), r: m.radius, halfAngle: (m.angleDeg * Math.PI) / 360 };
      }
      for (const id of ids) {
        const p = posAt(id);
        if (!p) continue;
        if (front && inShape(p, front, posAt)) {
          failed.add(id);
          reasons.push(`${label(id)} stood in front of the boss during ${h.name}`);
        }
        shapes.forEach((s, i) => {
          const owner = picked[i];
          if (owner === id) return;
          if (m.type === "baited" && picked.includes(id)) return; // baiters may overlap each other
          if (inShape(p, s, posAt)) {
            failed.add(id);
            reasons.push(`${label(id)} was clipped by ${h.name} aimed at ${label(owner)}`);
          }
        });
      }
      return result(front ? [...shapes, front] : shapes);
    }

    if (m?.type === "cleave") {
      const src = this.resolveAnchor(m.from, T);
      const tgt = this.resolveAnchor(m.target, T);
      const dir = norm(sub(tgt.pos, src.pos));
      if (src.actor) this.faceActor(src.actor, degFromDir(dir), T);
      const shape: Shape = { kind: "cone", origin: src.pos, dir, r: m.radius, halfAngle: (m.angleDeg * Math.PI) / 360 };
      for (const id of ids) {
        if (id === tgt.player) continue;
        const p = posAt(id);
        if (p && inShape(p, shape, posAt)) {
          failed.add(id);
          reasons.push(`${label(id)} was hit by ${h.name} meant for ${tgt.player ? label(tgt.player) : "the tank"}`);
        }
      }
      return result([shape]);
    }

    if (m?.type === "raidwide") return result();

    if (m?.type === "zone") {
      for (const [id, why] of this.zoneTouched.get(h.id) ?? []) {
        failed.add(id);
        reasons.push(why);
      }
      return result();
    }

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
            reasons.push(`${label(target)}'s ${h.name} clipped ${label(other)}`);
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
      const allowed = h.allowedHits ?? 0;
      for (const id of ids) {
        const p = posAt(id);
        if (!p) continue;
        const hits = h.shapes.filter((s) => inShape(p, s, posAt)).length;
        if (hits > allowed) {
          failed.add(id);
          reasons.push(allowed ? `${label(id)} was hit by ${hits}× ${h.name}` : `${label(id)} was hit by ${h.name}`);
        }
      }
    }

    return result();
  }

  snapshotPlayers(): PlayerState[] {
    return [...this.players.values()].map((p) => ({ ...p, pos: { ...p.pos } }));
  }
}
