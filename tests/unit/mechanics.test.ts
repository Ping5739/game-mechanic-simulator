import { describe, expect, it } from "vitest";
import { ENCOUNTERS } from "../../src/data";
import { actorStateAt } from "../../src/sim/actors";
import { TICK_RATE } from "../../src/sim/constants";
import { Simulation } from "../../src/sim/simulation";
import { compileStrategy, upcomingStep, type StrategyDef } from "../../src/sim/strategy";
import { SLOTS, type EncounterDef, type HitResult, type MechanicDef, type Slot } from "../../src/sim/types";

const perfect = { difficulty: "perfect" as const, mistakeChance: 0 };

/** All eight players parked at fixed spots, so mechanics can be checked by hand. */
function arena(mechanics: { at: number; cast: number; mechanic: MechanicDef }[], spots: Record<Slot, [number, number]>, extra: Partial<EncounterDef> = {}) {
  const pos = Object.fromEntries(SLOTS.map((s) => [s, { x: spots[s][0], y: spots[s][1] }])) as Record<Slot, { x: number; y: number }>;
  const enc: EncounterDef = { id: "t", name: "t", arenaRadius: 20, bossRadius: 2, loopLength: 60, timeline: mechanics, ...extra };
  const strat: StrategyDef = { id: "s", name: "s", default: pos, positions: {} };
  const sim = new Simulation(enc, compileStrategy(strat), 1, perfect, 0);
  const results: HitResult[] = [];
  for (let i = 0; i < 20 * TICK_RATE; i++) results.push(...sim.step().results);
  return results;
}

const spread: Record<Slot, [number, number]> = {
  MT: [0, -5], OT: [5, 0], H1: [0, 5], H2: [-5, 0], M1: [3, -3], M2: [-3, -3], R1: [12, 12], R2: [-12, 12],
};

describe("new mechanic types", () => {
  it("protean: cones at the nearest players; anyone else in a cone fails", () => {
    const at = { kind: "point", x: 0, y: -15 } as const;
    // From the north edge, the nearest players are MT (0,-5), M1 and M2. M2 stands behind MT's line? No — put OT behind MT.
    const r = arena([{ at: 1, cast: 1, mechanic: { type: "protean", name: "P", from: at, count: 1, radius: 40, angleDeg: 10 } }], {
      ...spread,
      OT: [0, 5], // directly behind MT, inside the cone aimed at MT
      H1: [5, 5],
    })[0];
    expect(r.failed).toEqual(["bot:OT"]);
    expect(r.shapes).toHaveLength(1);
  });

  it("baited circles land on the farthest players; others nearby fail, baiters may overlap", () => {
    const r = arena([{ at: 1, cast: 1, mechanic: { type: "baited", name: "Sluice", from: { kind: "point", x: 0, y: 0 }, pick: "farthest", count: 2, radius: 3 } }], {
      ...spread,
      R1: [12, 12],
      R2: [13, 13], // both baiters, overlapping: fine
      H1: [11, 10], // a non-baiter next to them: fails
    })[0];
    expect(r.failed).toEqual(["bot:H1"]);
  });

  it("cleave hits everyone in front of the boss except its target", () => {
    const r = arena([{ at: 1, cast: 1, mechanic: { type: "cleave", name: "TB", from: { kind: "boss" }, target: { kind: "slot", slot: "MT" }, radius: 10, angleDeg: 60 } }], {
      ...spread,
      M1: [1, -7], // in front with MT: fails
      M2: [-3, 3],
    })[0];
    expect(r.failed).toEqual(["bot:M1"]);
  });

  it("circles with allowedHits fail only players in too many of them", () => {
    const r = arena([
      { at: 1, cast: 1, mechanic: { type: "circle", name: "Exhaust", at: { kind: "point", x: 0, y: 0 }, radius: 6, allowedHits: 1, count: 1 } },
    ], spread)[0];
    expect(r.failed).toEqual([]); // one circle never fails with allowedHits 1
  });

  it("zones fail anyone who touches them while they're active", () => {
    const r = arena([{ at: 1, cast: 3, mechanic: { type: "zone", name: "Orb", at: { kind: "actor", id: "orb" }, radius: 1 } }], spread, {
      actors: [
        { id: "boss", name: "Boss", kind: "boss", radius: 2, keys: [{ at: 0, x: 0, y: 0 }] },
        // The orb drifts across H2's spot during the zone.
        { id: "orb", name: "Orb", kind: "object", radius: 0.5, keys: [{ at: 0, x: -10, y: 0 }, { at: 4, x: 0, y: 0, move: 3 }] },
      ],
    })[0];
    expect(r.failed).toEqual(["bot:H2"]);
  });
});

describe("actors", () => {
  it("interpolates keyframed moves and visibility", () => {
    const def = { id: "a", name: "a", kind: "boss" as const, radius: 1, keys: [{ at: 0, x: 0, y: 0, facing: 0 }, { at: 10, x: 10, y: 0, move: 4, facing: 90 }, { at: 20, visible: false }] };
    expect(actorStateAt(def, 5).pos).toEqual({ x: 0, y: 0 });
    expect(actorStateAt(def, 8).pos.x).toBeCloseTo(5);
    expect(actorStateAt(def, 8).facing).toBeCloseTo(45);
    expect(actorStateAt(def, 12).pos).toEqual({ x: 10, y: 0 });
    expect(actorStateAt(def, 19).visible).toBe(true);
    expect(actorStateAt(def, 21).visible).toBe(false);
  });
});

describe("Living Liquid (APT)", () => {
  const e = ENCOUNTERS["tea-living-liquid"];
  const strat = compileStrategy(e.strategies[0]);

  it("perfect and realistic bots following the plan clear the whole loop", () => {
    for (const difficulty of ["perfect", "realistic"] as const) {
      for (const seed of [1, 2, 3]) {
        const sim = new Simulation(e.def, strat, seed, { difficulty, mistakeChance: 0 });
        const failures: string[] = [];
        let count = 0;
        for (let i = 0; i < (e.def.loopLength + 4) * TICK_RATE; i++) {
          for (const r of sim.step().results) {
            count++;
            failures.push(...r.reasons);
          }
        }
        expect(failures, `${difficulty} seed ${seed}`).toEqual([]);
        expect(count).toBe(e.def.timeline.length);
      }
    }
  });

  it("bots that skip steps get caught", () => {
    const sim = new Simulation(e.def, strat, 7, { difficulty: "perfect", mistakeChance: 0.35 });
    const failures: string[] = [];
    for (let i = 0; i < (e.def.loopLength + 4) * TICK_RATE; i++) for (const r of sim.step().results) failures.push(...r.reasons);
    expect(failures.length).toBeGreaterThan(0);
  });

  it("a human copying their ghost clears it, in any slot", () => {
    for (const slot of SLOTS) {
      const sim = new Simulation(e.def, strat, 5, { difficulty: "realistic", mistakeChance: 0 });
      sim.addHuman("me", "Me", slot);
      const failures: string[] = [];
      for (let i = 0; i < (e.def.loopLength + 4) * TICK_RATE; i++) {
        sim.applySample({ playerId: "me", tick: sim.tick + 1, pos: { ...sim.ghosts.get("me")!.pos }, epoch: sim.epoch });
        for (const r of sim.step().results) failures.push(...r.reasons);
      }
      expect(failures, slot).toEqual([]);
    }
  });

  it("steps are in order and every step tells players what's next", () => {
    expect(strat.steps).toHaveLength(18);
    expect(upcomingStep(strat.steps!, 0)!.label).toBe("Cascade");
    expect(upcomingStep(strat.steps!, 15)!.label).toBe("Tornado proteans");
    expect(strat.steps!.every((s) => s.note && s.note.length > 10)).toBe(true);
  });
});
