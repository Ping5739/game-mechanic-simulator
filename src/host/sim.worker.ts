/// <reference lib="webworker" />
/**
 * Runs the authoritative simulation off the main thread.
 *
 * Browsers heavily throttle timers in background tabs, which would stall the
 * room whenever the host alt-tabs. Dedicated workers aren't throttled the same
 * way, and the loop below also catches up against the real clock, so a late
 * timer never makes the encounter drift.
 */
import { ENCOUNTERS } from "../data";
import { DEFAULT_BOT_SETTINGS } from "../sim/bots";
import { SNAPSHOT_EVERY, TICK_MS } from "../sim/constants";
import { Simulation } from "../sim/simulation";
import { compileStrategy } from "../sim/strategy";
import { r2, type RosterEntry } from "../net/protocol";
import type { FromWorker, ToWorker } from "./worker-protocol";

declare const self: DedicatedWorkerGlobalScope;

let sim: Simulation | undefined;
let paused = false;
let startTime = 0;
let stepTimes: number[] = [];
let ticksThisSecond = 0;
let lastStatsAt = 0;

const post = (m: FromWorker) => self.postMessage(m);

function roster(s: Simulation): RosterEntry[] {
  return [...s.players.values()].map((p) => ({ id: p.id, slot: p.slot, name: p.name, isBot: p.isBot }));
}

function postSnap(s: Simulation): void {
  post({
    type: "snap",
    tick: s.tick,
    p: [...s.players.values()].map((p) => [p.id, r2(p.pos.x), r2(p.pos.y), p.fails, Math.round(p.facing)]),
    g: [...s.ghosts].map(([id, g]) => [id, r2(g.pos.x), r2(g.pos.y), r2(g.dest.x), r2(g.dest.y)]),
    a: s.actorStates().map((a) => [a.id, r2(a.pos.x), r2(a.pos.y), Math.round(a.facing), a.visible ? 1 : 0]),
  });
}

function loop(): void {
  if (!sim) return;
  const now = performance.now();
  if (paused) {
    lastStatsAt = now;
    return;
  }
  let target = Math.floor((now - startTime) / TICK_MS);
  // If we fell far behind (e.g. the machine slept), skip ahead instead of
  // running hundreds of ticks in a burst.
  if (target - sim.tick > 60) {
    startTime += (target - sim.tick - 1) * TICK_MS;
    target = sim.tick + 1;
  }
  while (sim.tick < target) {
    const t0 = performance.now();
    const ev = sim.step();
    stepTimes.push(performance.now() - t0);
    ticksThisSecond++;
    for (const h of ev.hazards) post({ type: "hazard", h });
    for (const r of ev.results) post({ type: "result", r });
    if (ev.rosterChanged) post({ type: "roster", roster: roster(sim) });
    if (sim.tick % SNAPSHOT_EVERY === 0) postSnap(sim);
  }
  if (now - lastStatsAt >= 1000) {
    const avg = stepTimes.length ? stepTimes.reduce((a, b) => a + b, 0) / stepTimes.length : 0;
    post({ type: "stats", avgStepMs: avg, maxStepMs: Math.max(0, ...stepTimes), ticksPerSec: ticksThisSecond });
    stepTimes = [];
    ticksThisSecond = 0;
    lastStatsAt = now;
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case "init": {
      const enc = ENCOUNTERS[m.encounterId];
      const stratDef = enc.strategies.find((s) => s.id === m.strategyId) ?? enc.strategies[0];
      sim = new Simulation(enc.def, compileStrategy(stratDef), m.seed, m.bots ?? DEFAULT_BOT_SETTINGS);
      startTime = performance.now();
      lastStatsAt = startTime;
      setInterval(loop, TICK_MS / 2);
      break;
    }
    case "join": {
      if (!sim) return;
      const slot = sim.addHuman(m.id, m.name, m.slot);
      if (!slot) post({ type: "full", id: m.id, requested: m.slot, taken: sim.humanSlots() });
      else
        post({
          type: "joined",
          id: m.id,
          slot,
          tick: sim.tick,
          epoch: sim.epoch,
          loopStartTick: sim.loopStartTick,
          paused,
          hazards: [...sim.hazards.values()],
        });
      break;
    }
    case "leave":
      sim?.removeHuman(m.id);
      break;
    case "sample":
      // While paused nobody moves, so late reports are dropped.
      if (!paused) sim?.applySample({ playerId: m.id, tick: m.tick, pos: { x: m.x, y: m.y }, epoch: m.epoch, facing: m.facing });
      break;
    case "seek": {
      if (!sim) return;
      const res = sim.seekTo(m.seconds);
      const positions: Record<string, [number, number]> = {};
      for (const [id, p] of Object.entries(res.positions)) positions[id] = [r2(p.x), r2(p.y)];
      post({ type: "seek", epoch: res.epoch, tick: sim.tick, loopStartTick: res.loopStartTick, positions });
      for (const h of res.hazards) post({ type: "hazard", h });
      postSnap(sim); // so a paused room still sees the new positions
      break;
    }
    case "pause": {
      if (!sim || paused === m.paused) return;
      paused = m.paused;
      // Resume exactly where we stopped, without catching up the paused time.
      if (!paused) startTime = performance.now() - sim.tick * TICK_MS;
      post({ type: "pause", paused, tick: sim.tick });
      break;
    }
    case "bots":
      sim?.setBotSettings(m.bots);
      break;
  }
};
