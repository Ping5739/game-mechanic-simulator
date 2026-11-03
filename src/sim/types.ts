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
  /** Compass degrees the player faces (0 = north, 90 = east). */
  facing: number;
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
  | { kind: "randomRole"; role: Role }
  /** An actor (boss, add or object) from the encounter's `actors`. */
  | { kind: "actor"; id: string }
  /** Whoever fills a party slot. */
  | { kind: "slot"; slot: Slot };

export type MechanicDef =
  | {
      type: "circle";
      name: string;
      radius: number;
      at: Anchor;
      count?: number;
      spread?: number;
      /** How many of this mechanic's circles a player may stand in without failing (default 0). */
      allowedHits?: number;
      /** For actor/slot anchors: the circle follows its anchor until it resolves. */
      follow?: boolean;
    }
  | { type: "donut"; name: string; inner: number; outer: number; at: Anchor }
  | { type: "line"; name: string; width: number; length: number; toward: Anchor }
  | {
      type: "cone";
      name: string;
      radius: number;
      angleDeg: number;
      /** Fixed direction; omit when using `toward`. */
      facingDeg?: number | "randomCardinal";
      /** Where the cone comes from (default: the boss / arena center). */
      from?: Anchor;
    }
  /** Circles on players; anyone else inside a target's circle fails. `on` limits it to some slots. */
  | { type: "spread"; name: string; radius: number; on?: Slot[] }
  | { type: "stack"; name: string; radius: number; minPlayers: number; on: Anchor }
  /**
   * Untelegraphed cones from `from` toward the `count` nearest players, decided
   * when it resolves. A player in a cone aimed at someone else fails.
   */
  | { type: "protean"; name: string; from: Anchor; count: number; radius: number; angleDeg: number }
  /**
   * Untelegraphed circles dropped on the `count` nearest or farthest players
   * from `from` when it resolves. Non-targets inside any circle fail.
   */
  | { type: "baited"; name: string; from: Anchor; pick: "nearest" | "farthest"; count: number; radius: number }
  /** Untelegraphed cone from `from` at the `target` (e.g. a tank buster cleave). Anyone else inside fails. */
  | { type: "cleave"; name: string; from: Anchor; target: Anchor; radius: number; angleDeg: number }
  /** Party-wide damage: a cast bar and a timeline entry, nothing to dodge. */
  | { type: "raidwide"; name: string }
  /** A persistent hazard (e.g. an orb) around an actor: touching it at any time while active fails. */
  | { type: "zone"; name: string; at: Anchor; radius: number };

/**
 * Something on the field besides players: a boss, an add, or an object such
 * as a tornado or an orb. Where it is over time is given by keyframes.
 */
export interface ActorDef {
  id: string;
  name: string;
  kind: "boss" | "add" | "object";
  /** How it's drawn. Bosses and adds default to "tetra". */
  look?: "tetra" | "tornado" | "orb";
  /** Hitbox ring radius for bosses; display size otherwise. */
  radius: number;
  /**
   * Keyframes in loop seconds. At `at` the actor is at x/y (arriving after
   * `move` seconds of travel, or instantly), faces `facing`, and turns
   * visible/invisible. Values carry over until changed.
   */
  keys: { at: number; x?: number; y?: number; facing?: number; visible?: boolean; move?: number }[];
}

export interface TimelineEntry {
  /** Seconds from the start of the loop when the cast begins. */
  at: number;
  /** Cast time in seconds (telegraph visible for this long). */
  cast: number;
  mechanic: MechanicDef;
  /** Optional strategy key so bots know which positions to use. */
  key?: string;
  /** Leave this cast off the timeline bar's labels (still shown as a block). */
  minor?: boolean;
}

export interface EncounterDef {
  id: string;
  name: string;
  arenaRadius: number;
  bossRadius: number;
  /** Total loop length in seconds; the timeline repeats. */
  loopLength: number;
  timeline: TimelineEntry[];
  /** Bosses, adds and objects. Without this there's one boss in the center. */
  actors?: ActorDef[];
  /** Where the encounter was taken from, shown in the lobby. */
  source?: { title: string; author?: string; url?: string; caveat?: string };
}

// ---------------------------------------------------------------------------
// Resolved, concrete hazards (what the server sends to clients)
// ---------------------------------------------------------------------------

/**
 * A concrete hazard instance with fixed geometry, or geometry anchored to a
 * player (spread / stack follow their target until they resolve).
 */
export type Shape =
  /** `player` may also be "actor:<id>" for circles that follow an actor. */
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
  /** Full mechanic definition (proteans, cleaves etc. are worked out when they resolve). */
  def?: MechanicDef;
  /** Untelegraphed: nothing is drawn until it resolves. */
  hidden?: boolean;
  /** Circles: how many may hit one player before it counts as a failure. */
  allowedHits?: number;
}

export interface HitResult {
  hazardId: number;
  name: string;
  tick: number;
  /** Players who failed this mechanic. */
  failed: string[];
  /** Human-readable reasons, one per failure. */
  reasons: string[];
  /** Shapes decided at resolve time (untelegraphed mechanics), so clients can flash them. */
  shapes?: Shape[];
}

/** Where an actor is at a moment. */
export interface ActorState {
  id: string;
  pos: Vec2;
  facing: number;
  visible: boolean;
}

export interface InputSample {
  playerId: string;
  /** The host tick this position corresponds to (client's estimate). */
  tick: number;
  pos: Vec2;
  /** Seek epoch the client was in when it sent this. */
  epoch?: number;
  /** Compass degrees the player faces. */
  facing?: number;
}
