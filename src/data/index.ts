import trainingDummy from "./encounters/training-dummy.json";
import livingLiquid from "./encounters/tea-living-liquid.json";
import trainingDummyDefault from "./strategies/training-dummy-default.json";
import livingLiquidApt from "./strategies/tea-living-liquid-apt.json";
import type { EncounterDef } from "../sim/types";
import type { StrategyDef } from "../sim/strategy";

/** Registry of bundled encounters and the strategies available for each, in menu order. */
export const ENCOUNTERS: Record<string, { def: EncounterDef; strategies: StrategyDef[] }> = {
  [trainingDummy.id]: {
    def: trainingDummy as EncounterDef,
    strategies: [trainingDummyDefault as unknown as StrategyDef],
  },
  [livingLiquid.id]: {
    def: livingLiquid as unknown as EncounterDef,
    strategies: [livingLiquidApt as unknown as StrategyDef],
  },
};

export const DEFAULT_ENCOUNTER_ID = trainingDummy.id;
