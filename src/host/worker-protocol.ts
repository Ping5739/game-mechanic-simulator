import type { BotSettings } from "../sim/bots";
import type { Hazard, HitResult, Slot } from "../sim/types";
import type { RosterEntry, SeekInfo, SnapActor, SnapGhost, SnapPlayer } from "../net/protocol";

/** Messages from the host page to the simulation worker. */
export type ToWorker =
  | { type: "init"; encounterId: string; strategyId: string; seed: number; bots: BotSettings }
  | { type: "join"; id: string; name: string; slot?: Slot }
  | { type: "leave"; id: string }
  | { type: "sample"; id: string; tick: number; x: number; y: number; epoch: number; facing: number }
  | { type: "seek"; seconds: number }
  | { type: "pause"; paused: boolean }
  | { type: "bots"; bots: BotSettings };

/** Messages from the simulation worker back to the host page. */
export type FromWorker =
  | { type: "joined"; id: string; slot: Slot; tick: number; epoch: number; loopStartTick: number; paused: boolean; hazards: Hazard[] }
  | { type: "pause"; paused: boolean; tick: number }
  | ({ type: "seek" } & SeekInfo)
  | { type: "full"; id: string; requested?: Slot; taken: Slot[] }
  | { type: "snap"; tick: number; p: SnapPlayer[]; g: SnapGhost[]; a: SnapActor[] }
  | { type: "hazard"; h: Hazard }
  | { type: "result"; r: HitResult }
  | { type: "roster"; roster: RosterEntry[] }
  | { type: "stats"; avgStepMs: number; maxStepMs: number; ticksPerSec: number };
