import type { BotSettings } from "../sim/bots";
import type { Hazard, HitResult, Slot } from "../sim/types";
import type { RosterEntry, SeekInfo, SnapGhost, SnapPlayer } from "../net/protocol";

/** Messages from the host page to the simulation worker. */
export type ToWorker =
  | { type: "init"; encounterId: string; strategyId: string; seed: number; bots: BotSettings }
  | { type: "join"; id: string; name: string }
  | { type: "leave"; id: string }
  | { type: "sample"; id: string; tick: number; x: number; y: number; epoch: number }
  | { type: "seek"; seconds: number }
  | { type: "bots"; bots: BotSettings };

/** Messages from the simulation worker back to the host page. */
export type FromWorker =
  | { type: "joined"; id: string; slot: Slot; tick: number; epoch: number; loopStartTick: number; hazards: Hazard[] }
  | ({ type: "seek" } & SeekInfo)
  | { type: "full"; id: string }
  | { type: "snap"; tick: number; p: SnapPlayer[]; g: SnapGhost[] }
  | { type: "hazard"; h: Hazard }
  | { type: "result"; r: HitResult }
  | { type: "roster"; roster: RosterEntry[] }
  | { type: "stats"; avgStepMs: number; maxStepMs: number; ticksPerSec: number };
