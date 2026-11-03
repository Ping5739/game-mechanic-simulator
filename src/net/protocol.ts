import type { BotSettings } from "../sim/bots";
import type { Hazard, HitResult, Slot } from "../sim/types";

/** Compact player row in a snapshot: [id, x, y, fails, facingDeg]. */
export type SnapPlayer = [id: string, x: number, y: number, fails: number, facing: number];

/** Ghost row in a snapshot: [humanId, x, y, destX, destY]. */
export type SnapGhost = [id: string, x: number, y: number, dx: number, dy: number];

/** Actor row in a snapshot: [actorId, x, y, facingDeg, visible 0/1]. */
export type SnapActor = [id: string, x: number, y: number, facing: number, visible: number];

/** Sent when the host jumps the encounter to another moment. */
export interface SeekInfo {
  epoch: number;
  tick: number;
  loopStartTick: number;
  positions: Record<string, [number, number]>;
}

export interface RosterEntry {
  id: string;
  slot: Slot;
  name: string;
  isBot: boolean;
}

// Host → client -------------------------------------------------------------

export type HostMsg =
  | {
      t: "welcome";
      you: string;
      slot: Slot;
      tick: number;
      epoch: number;
      loopStartTick: number;
      paused: boolean;
      encounterId: string;
      strategyId: string;
      seed: number;
      bots: BotSettings;
      hazards: Hazard[];
    }
  | { t: "full"; reason: string }
  | { t: "snap"; tick: number; p: SnapPlayer[]; g: SnapGhost[]; a: SnapActor[] }
  | { t: "pause"; paused: boolean; tick: number }
  | ({ t: "seek" } & SeekInfo)
  | { t: "hazard"; h: Hazard }
  | { t: "result"; r: HitResult }
  | { t: "roster"; roster: RosterEntry[]; pings: Record<string, number> }
  | { t: "pong"; c: number }
  | { t: "bots"; bots: BotSettings };

// Client → host -------------------------------------------------------------

export type ClientMsg =
  | { t: "hello"; name: string; version: number }
  | { t: "pos"; tick: number; x: number; y: number; e: number; f: number }
  | { t: "ping"; c: number; rtt?: number };

export const PROTOCOL_VERSION = 4;

/** Round to 2 decimals to keep messages small. */
export const r2 = (n: number) => Math.round(n * 100) / 100;
