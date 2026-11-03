import { describe, expect, it } from "vitest";
import { ENCOUNTERS, DEFAULT_ENCOUNTER_ID } from "../../src/data";
import { TICK_RATE } from "../../src/sim/constants";
import { dirFromDeg, inShape } from "../../src/sim/math";
import { Simulation } from "../../src/sim/simulation";
import { compileStrategy } from "../../src/sim/strategy";
import type { HitResult } from "../../src/sim/types";

const enc = ENCOUNTERS[DEFAULT_ENCOUNTER_ID];
const strat = compileStrategy(enc.strategies[0]);
const none = () => undefined;

function run(sim: Simulation, seconds: number): HitResult[] {
  const results: HitResult[] = [];
  for (let i = 0; i < seconds * TICK_RATE; i++) results.push(...sim.step().results);
  return results;
}

describe("shapes", () => {
  it("circle, donut, rect and cone hit tests", () => {
    expect(inShape({ x: 3, y: 0 }, { kind: "circle", c: { x: 0, y: 0 }, r: 5 }, none)).toBe(true);
    expect(inShape({ x: 6, y: 0 }, { kind: "circle", c: { x: 0, y: 0 }, r: 5 }, none)).toBe(false);
    expect(inShape({ x: 3, y: 0 }, { kind: "donut", c: { x: 0, y: 0 }, r0: 6, r1: 20 }, none)).toBe(false);
    expect(inShape({ x: 8, y: 0 }, { kind: "donut", c: { x: 0, y: 0 }, r0: 6, r1: 20 }, none)).toBe(true);
    const rect = { kind: "rect" as const, origin: { x: 0, y: 10 }, dir: { x: 0, y: -1 }, length: 20, width: 4 };
    expect(inShape({ x: 1.9, y: 0 }, rect, none)).toBe(true);
    expect(inShape({ x: 2.1, y: 0 }, rect, none)).toBe(false);
    const cone = { kind: "cone" as const, origin: { x: 0, y: 0 }, dir: dirFromDeg(0), r: 10, halfAngle: Math.PI / 4 };
    expect(inShape({ x: 0, y: -5 }, cone, none)).toBe(true); // north, inside
    expect(inShape({ x: 0, y: 5 }, cone, none)).toBe(false); // south, behind
  });
});

describe("simulation", () => {
  it("perfect bots clear two full loops without a single failure", () => {
    const sim = new Simulation(enc.def, strat, 12345, { difficulty: "perfect", mistakeChance: 0 });
    const results = run(sim, enc.def.loopLength * 2 + 5);
    expect(results.length).toBe(enc.def.timeline.length * 2);
    const failures = results.flatMap((r) => r.reasons);
    expect(failures).toEqual([]);
  });

  it("realistic bots also clear the encounter across several seeds", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const sim = new Simulation(enc.def, strat, seed, { difficulty: "realistic", mistakeChance: 0 });
      const failures = run(sim, enc.def.loopLength + 5).flatMap((r) => r.reasons);
      expect(failures, `seed ${seed}`).toEqual([]);
    }
  });

  it("mistake injection makes bots fail", () => {
    const sim = new Simulation(enc.def, strat, 7, { difficulty: "perfect", mistakeChance: 1 });
    const failures = run(sim, enc.def.loopLength + 5).flatMap((r) => r.failed);
    expect(failures.length).toBeGreaterThan(0);
  });

  it("is deterministic for the same seed", () => {
    const a = run(new Simulation(enc.def, strat, 99, { difficulty: "realistic", mistakeChance: 0.3 }), 60);
    const b = run(new Simulation(enc.def, strat, 99, { difficulty: "realistic", mistakeChance: 0.3 }), 60);
    expect(a).toEqual(b);
  });

  it("judges humans by the position they reported for the resolve tick", () => {
    const sim = new Simulation(enc.def, strat, 5, { difficulty: "perfect", mistakeChance: 0 });
    sim.addHuman("human", "Tester", "MT");
    // Stand in the "Searing Ring" (out) until just after it resolves, but
    // report a late sample — the host must use the position at the resolve tick.
    const first = enc.def.timeline[0];
    const resolveTick = Math.round((3 + first.at + first.cast) * TICK_RATE);
    let results: HitResult[] = [];
    while (sim.tick < resolveTick + 10) {
      const t = sim.tick + 1;
      // Inside the ring up to the resolve tick, then out at 15 units.
      const pos = t <= resolveTick ? { x: 0, y: -2 } : { x: 0, y: -15 };
      if (t !== resolveTick) sim.applySample({ playerId: "human", tick: t, pos });
      results = results.concat(sim.step().results);
    }
    const ring = results.find((r) => r.name === "Searing Ring")!;
    expect(ring.failed).toContain("human");
  });

  it("clamps impossible movement from clients", () => {
    const sim = new Simulation(enc.def, strat, 5, { difficulty: "perfect", mistakeChance: 0 });
    sim.addHuman("human", "Tester", "MT");
    const start = { ...sim.players.get("human")!.pos };
    sim.applySample({ playerId: "human", tick: 1, pos: { x: start.x + 15, y: start.y } });
    const moved = sim.players.get("human")!.pos.x - start.x;
    expect(moved).toBeLessThan(1);
  });

  it("returns a slot to a bot when a human leaves", () => {
    const sim = new Simulation(enc.def, strat, 5, { difficulty: "perfect", mistakeChance: 0 });
    expect(sim.addHuman("a", "A")).toBe("MT");
    expect(sim.addHuman("b", "B")).toBe("OT");
    sim.removeHuman("a");
    expect(sim.players.has("bot:MT")).toBe(true);
    expect(sim.players.size).toBe(8);
  });
});
