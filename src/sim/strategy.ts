import { dirFromDeg, scale } from "./math";
import { SLOTS, type Slot, type Vec2 } from "./types";

/** A position written as [compass angle in degrees, distance from center]. */
export type PolarSpot = [angleDeg: number, radius: number];
/** A position as world coordinates (x east, y south). */
export type CartSpot = { x: number; y: number };
export type Spot = PolarSpot | CartSpot;

/**
 * A strategy step: where everyone should be at `at` seconds into the loop.
 * Bots (and your ghost) head for the next step as soon as the previous one
 * has passed, so each step's time should be the moment its mechanic resolves.
 */
export interface StrategyStep {
  at: number;
  label: string;
  /** Short reminder shown to players while this step is coming up. */
  note?: string;
  positions: Record<Slot, Spot>;
}

export interface StrategyDef {
  id: string;
  name: string;
  /** Where each slot stands when nothing is happening. */
  default: Record<Slot, Spot>;
  /** Per-mechanic positions, keyed by the timeline entry's `key`. */
  positions: Record<string, Record<Slot, Spot>>;
  /** Where the stack target goes before a stack resolves. */
  stackSpot?: Spot;
  /** Step-by-step positions over the loop (used instead of `positions` when present). */
  steps?: StrategyStep[];
  source?: { title: string; author?: string; url?: string };
}

export function spotToVec(s: Spot): Vec2 {
  if (Array.isArray(s)) return scale(dirFromDeg(s[0]), s[1]);
  return { x: s.x, y: s.y };
}

/** @deprecated kept for older callers; use spotToVec. */
export const polarToVec = (s: PolarSpot): Vec2 => spotToVec(s);

export interface CompiledStep {
  at: number;
  label: string;
  note?: string;
  positions: Record<Slot, Vec2>;
}

export interface CompiledStrategy {
  id: string;
  name: string;
  defaults: Record<Slot, Vec2>;
  positions: Record<string, Record<Slot, Vec2>>;
  stackSpot?: Vec2;
  steps?: CompiledStep[];
}

const mapSlots = (m: Record<Slot, Spot>) => Object.fromEntries(SLOTS.map((s) => [s, spotToVec(m[s])])) as Record<Slot, Vec2>;

export function compileStrategy(def: StrategyDef): CompiledStrategy {
  return {
    id: def.id,
    name: def.name,
    defaults: mapSlots(def.default),
    positions: Object.fromEntries(Object.entries(def.positions).map(([k, m]) => [k, mapSlots(m)])),
    stackSpot: def.stackSpot ? spotToVec(def.stackSpot) : undefined,
    steps: def.steps
      ?.map((s) => ({ at: s.at, label: s.label, note: s.note, positions: mapSlots(s.positions) }))
      .sort((a, b) => a.at - b.at),
  };
}

/**
 * The step players should be heading for at loop time `t`: the first step
 * whose time hasn't passed yet (or the last one at the end of the loop).
 */
export function upcomingStep(steps: CompiledStep[], t: number): CompiledStep | undefined {
  if (!steps.length) return undefined;
  for (const s of steps) if (s.at >= t) return s;
  return steps[steps.length - 1];
}
