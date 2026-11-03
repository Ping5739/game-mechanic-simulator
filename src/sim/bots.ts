import { TICK_RATE } from "./constants";
import { clampToArena, dirFromDeg, dist, inShape } from "./math";
import { Rng } from "./rng";
import type { Simulation } from "./simulation";
import type { Hazard, PlayerState, Slot, Vec2 } from "./types";

export interface BotSettings {
  /** "perfect": instant, exact. "realistic": human-ish reaction time and drift. */
  difficulty: "perfect" | "realistic";
  /** Chance (0–1) that a bot ignores a given mechanic, to practice recovering. */
  mistakeChance: number;
}

export const DEFAULT_BOT_SETTINGS: BotSettings = { difficulty: "realistic", mistakeChance: 0 };

interface Plan {
  reactTick: number;
  ignore: boolean;
  jitter: Vec2;
}

/**
 * Strategy-driven bot. Each tick it picks a destination:
 *   1. the strategy's spot for the most urgent mechanic it has reacted to,
 *   2. otherwise its default (uptime) spot,
 * then nudges that spot out of any telegraph it would otherwise stand in.
 */
export class BotBrain {
  private readonly rng: Rng;
  private readonly plans = new Map<number, Plan>();

  constructor(
    readonly id: string,
    readonly slot: Slot,
    seed: number,
    public settings: BotSettings,
  ) {
    this.rng = new Rng(seed);
  }

  private planFor(h: Hazard): Plan {
    let plan = this.plans.get(h.id);
    if (!plan) {
      const realistic = this.settings.difficulty === "realistic";
      const reaction = realistic ? 0.35 + this.rng.next() * 0.45 : 0.1; // seconds
      const jitterR = realistic ? this.rng.next() * 0.6 : 0;
      const jitterA = this.rng.next() * Math.PI * 2;
      plan = {
        reactTick: h.startTick + Math.round(reaction * TICK_RATE),
        ignore: this.rng.next() < this.settings.mistakeChance,
        jitter: { x: Math.cos(jitterA) * jitterR, y: Math.sin(jitterA) * jitterR },
      };
      this.plans.set(h.id, plan);
    }
    return plan;
  }

  decide(sim: Simulation, me: PlayerState): Vec2 {
    // Forget plans for hazards that are gone.
    for (const id of this.plans.keys()) if (!sim.hazards.has(id)) this.plans.delete(id);

    const known = [...sim.hazards.values()]
      .filter((h) => {
        const plan = this.planFor(h);
        return sim.tick >= plan.reactTick && !plan.ignore;
      })
      .sort((a, b) => a.resolveTick - b.resolveTick);

    const strat = sim.strategy;
    let dest: Vec2 = strat.defaults[this.slot];
    let jitter: Vec2 = { x: 0, y: 0 };
    let positioned = false;

    for (const h of known) {
      if (h.mechType === "stack") {
        const target = h.targets![0];
        if (target === me.id) dest = strat.stackSpot ?? me.pos;
        else dest = sim.players.get(target)?.pos ?? dest;
        positioned = true;
        break;
      }
      if (h.key && strat.positions[h.key]) {
        dest = strat.positions[h.key][this.slot];
        jitter = this.planFor(h).jitter;
        positioned = true;
        break;
      }
    }
    if (!positioned && known.length) jitter = this.planFor(known[0]).jitter;

    dest = clampToArena({ x: dest.x + jitter.x, y: dest.y + jitter.y }, sim.encounter.arenaRadius - 0.5);
    return this.avoidTelegraphs(sim, dest, known);
  }

  /** If dest is inside a ground telegraph, find the nearest safe spot. */
  private avoidTelegraphs(sim: Simulation, dest: Vec2, known: Hazard[]): Vec2 {
    const ground = known.filter((h) => h.mechType !== "spread" && h.mechType !== "stack");
    if (!ground.length) return dest;
    const lookup = (id: string) => sim.players.get(id)?.pos;
    const margin = 1.0;
    const unsafe = (p: Vec2) =>
      ground.some((h) =>
        h.shapes.some((s) => {
          // Test the point and a small ring around it so bots keep a margin.
          if (inShape(p, s, lookup)) return true;
          for (let k = 0; k < 8; k++) {
            const d = dirFromDeg(k * 45);
            if (inShape({ x: p.x + d.x * margin, y: p.y + d.y * margin }, s, lookup)) return true;
          }
          return false;
        }),
      );
    if (!unsafe(dest)) return dest;
    const R = sim.encounter.arenaRadius - 0.5;
    let best: Vec2 | undefined;
    let bestD = Infinity;
    for (let r = 1; r <= R * 2; r += 1) {
      for (let k = 0; k < 24; k++) {
        const d = dirFromDeg(k * 15);
        const p = { x: dest.x + d.x * r, y: dest.y + d.y * r };
        if (Math.hypot(p.x, p.y) > R) continue;
        if (unsafe(p)) continue;
        const cost = dist(p, dest);
        if (cost < bestD) {
          bestD = cost;
          best = p;
        }
      }
      if (best) break;
    }
    return best ?? dest;
  }
}
