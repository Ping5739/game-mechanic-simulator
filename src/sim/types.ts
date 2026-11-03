// Core data types shared by the simulation, networking and renderer.
// Units: distances in "yalms"-like world units, time in simulation ticks.

export interface Vec2 {
  x: number;
  y: number;
}

/** Party slot names. A slot is filled by either a human or a bot. */
export const SLOTS = ["MT", "OT", "H1", "H2", "M1", "M2", "R1", "R2"] as const;
export type Slot = (typeof SLOTS)[number];

export type Role = "tank" | "healer" | "dps";

export function roleOf(slot: Slot): Role {
  if (slot === "MT" || slot === "OT") return "tank";
  if (slot === "H1" || slot === "H2") return "healer";
  return "dps";
}

export interface PlayerState {
  id: string; // stable id: "bot:<slot>" for bots, peer id for humans
  slot: Slot;
  name: string;
  isBot: boolean;
  pos: Vec2;
  fails: number;
}

// ---------------------------------------------------------------------------
// Encounter definition (authored as JSON in src/data/encounters)
// ---------------------------------------------------------------------------

/** How a mechanic picks its anchor point / target. */
export type Anchor =
  | { kind: "boss" }
  | { kind: "point"; x: number; y: number }
  | { kind: "randomPlayer" }
  | { kind: "randomRole"; role: Role };

export type MechanicDef =
  | { type: "circle"; name: string; radius: number; at: Anchor; count?: number; spread?: number }
  | { type: "donut"; name: string; inner: number; outer: number; at: Anchor }
  | { type: "line"; name: string; width: number; length: number; toward: Anchor }
  | { type: "cone"; name: string; radius: number; angleDeg: number; facingDeg: number | "randomCardinal" }
  | { type: "spread"; name: string; radius: number }
  | { type: "stack"; name: string; radius: number; minPlayers: number; on: Anchor };

export interface TimelineEntry {
  /** Seconds from the start of the loop when the cast begins. */
  at: number;
  /** Cast time in seconds (telegraph visible for this long). */
  cast: number;
  mechanic: MechanicDef;
  /** Optional strategy key so bots know which positions to use. */
  key?: string;
}

export interface EncounterDef {
  id: string;
  name: string;
  arenaRadius: number;
  bossRadius: number;
  /** Total loop length in seconds; the timeline repeats. */
  loopLength: number;
  timeline: TimelineEntry[];
}

// ---------------------------------------------------------------------------
// Resolved, concrete hazards (what the server sends to clients)
// ---------------------------------------------------------------------------

/**
 * A concrete hazard instance with fixed geometry, or geometry anchored to a
 * player (spread / stack follow their target until they resolve).
 */
export type Shape =
  | { kind: "circle"; c: Vec2 | { player: string }; r: number }
  | { kind: "donut"; c: Vec2; r0: number; r1: number }
  | { kind: "rect"; origin: Vec2; dir: Vec2; length: number; width: number }
  | { kind: "cone"; origin: Vec2; dir: Vec2; r: number; halfAngle: number };

export interface Hazard {
  id: number;
  name: string;
  key?: string;
  mechType: MechanicDef["type"];
  shapes: Shape[];
  startTick: number;
  resolveTick: number;
  /** For stacks: the number of players that must share the circle. */
  minPlayers?: number;
  /** For spread/stack: the targeted players. */
  targets?: string[];
}

export interface HitResult {
  hazardId: number;
  name: string;
  tick: number;
  /** Players who failed this mechanic. */
  failed: string[];
  /** Human-readable reasons, one per failure. */
  reasons: string[];
}

export interface InputSample {
  playerId: string;
  /** The host tick this position corresponds to (client's estimate). */
  tick: number;
  pos: Vec2;
  /** Seek epoch the client was in when it sent this. */
  epoch?: number;
}
