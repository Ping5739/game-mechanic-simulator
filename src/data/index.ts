import trainingDummy from "./encounters/training-dummy.json";
import trainingDummyDefault from "./strategies/training-dummy-default.json";
import type { EncounterDef } from "../sim/types";
import type { StrategyDef } from "../sim/strategy";

/** Registry of bundled encounters and the strategies available for each. */
export const ENCOUNTERS: Record<string, { def: EncounterDef; strategies: StrategyDef[] }> = {
  [trainingDummy.id]: {
    def: trainingDummy as EncounterDef,
    strategies: [trainingDummyDefault as unknown as StrategyDef],
  },
};

export const DEFAULT_ENCOUNTER_ID = trainingDummy.id;
