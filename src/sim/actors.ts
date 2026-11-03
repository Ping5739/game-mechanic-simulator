import type { ActorDef, ActorState, EncounterDef } from "./types";

/** Encounters without `actors` get a single boss in the middle of the arena. */
export function actorsOf(enc: EncounterDef): ActorDef[] {
  return enc.actors ?? [{ id: "boss", name: "Boss", kind: "boss", radius: enc.bossRadius, keys: [{ at: 0, x: 0, y: 0, facing: 0 }] }];
}

function lerpDeg(a: number, b: number, f: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * f + 360) % 360;
}

/**
 * Where an actor is `t` seconds into the loop. Pure function of time, so the
 * host, every client and a timeline jump all agree without extra messages.
 */
export function actorStateAt(def: ActorDef, t: number): ActorState {
  const time = Math.max(0, t);
  const keys = [...def.keys].sort((a, b) => a.at - b.at);
  let x = 0;
  let y = 0;
  let facing = 0;
  let visible = true;
  let first = true;
  for (const k of keys) {
    const move = k.move ?? 0;
    const start = k.at - move;
    if (time < start && !first) break;
    first = false;
    // Visibility flips when the actor starts heading to (or appears at) this key.
    if (k.visible !== undefined && time >= start) visible = k.visible;
    if (time >= k.at || move <= 0) {
      if (k.x !== undefined) x = k.x;
      if (k.y !== undefined) y = k.y;
      if (k.facing !== undefined) facing = k.facing;
      if (time < k.at && move <= 0) break;
      continue;
    }
    // Part-way through a move.
    const f = (time - start) / move;
    if (k.x !== undefined) x = x + (k.x - x) * f;
    if (k.y !== undefined) y = y + (k.y - y) * f;
    if (k.facing !== undefined) facing = lerpDeg(facing, k.facing, f);
    break;
  }
  return { id: def.id, pos: { x, y }, facing, visible };
}

/** The last time (loop seconds, ≤ t) a keyframe set this actor's facing. */
export function lastFacingKeyAt(def: ActorDef, t: number): number {
  let last = -Infinity;
  for (const k of def.keys) if (k.facing !== undefined && k.at - (k.move ?? 0) <= t) last = Math.max(last, k.at - (k.move ?? 0));
  return last;
}
