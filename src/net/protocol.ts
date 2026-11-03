import type { BotSettings } from "../sim/bots";
import type { Hazard, HitResult, Slot } from "../sim/types";

/** Compact player row in a snapshot: [id, x, y, fails]. */
export type SnapPlayer = [id: string, x: number, y: number, fails: number];

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
      encounterId: string;
      strategyId: string;
      seed: number;
      bots: BotSettings;
      hazards: Hazard[];
    }
  | { t: "full"; reason: string }
  | { t: "snap"; tick: number; p: SnapPlayer[] }
  | { t: "hazard"; h: Hazard }
  | { t: "result"; r: HitResult }
  | { t: "roster"; roster: RosterEntry[]; pings: Record<string, number> }
  | { t: "pong"; c: number }
  | { t: "bots"; bots: BotSettings };

// Client → host -------------------------------------------------------------

export type ClientMsg =
  | { t: "hello"; name: string; version: number }
  | { t: "pos"; tick: number; x: number; y: number }
  | { t: "ping"; c: number; rtt?: number };

export const PROTOCOL_VERSION = 1;

/** Round to 2 decimals to keep messages small. */
export const r2 = (n: number) => Math.round(n * 100) / 100;
