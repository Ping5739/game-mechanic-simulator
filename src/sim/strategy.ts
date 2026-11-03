import { dirFromDeg, scale } from "./math";
import { SLOTS, type Slot, type Vec2 } from "./types";

/** A position written as [compass angle in degrees, distance from center]. */
export type PolarSpot = [angleDeg: number, radius: number];

export interface StrategyDef {
  id: string;
  name: string;
  /** Where each slot stands when nothing is happening. */
  default: Record<Slot, PolarSpot>;
  /** Per-mechanic positions, keyed by the timeline entry's `key`. */
  positions: Record<string, Record<Slot, PolarSpot>>;
  /** Where the stack target goes before a stack resolves. */
  stackSpot?: PolarSpot;
}

export function polarToVec([angle, r]: PolarSpot): Vec2 {
  return scale(dirFromDeg(angle), r);
}

export interface CompiledStrategy {
  id: string;
  name: string;
  defaults: Record<Slot, Vec2>;
  positions: Record<string, Record<Slot, Vec2>>;
  stackSpot?: Vec2;
}

export function compileStrategy(def: StrategyDef): CompiledStrategy {
  const mapSlots = (m: Record<Slot, PolarSpot>) =>
    Object.fromEntries(SLOTS.map((s) => [s, polarToVec(m[s])])) as Record<Slot, Vec2>;
  return {
    id: def.id,
    name: def.name,
    defaults: mapSlots(def.default),
    positions: Object.fromEntries(Object.entries(def.positions).map(([k, m]) => [k, mapSlots(m)])),
    stackSpot: def.stackSpot ? polarToVec(def.stackSpot) : undefined,
  };
}
