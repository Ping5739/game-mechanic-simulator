import type { Shape, Vec2 } from "./types";

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export function norm(a: Vec2): Vec2 {
  const l = len(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: -1 };
}

/** Unit vector for a compass angle: 0° = north (−y), 90° = east (+x). */
export function dirFromDeg(deg: number): Vec2 {
  const r = (deg * Math.PI) / 180;
  return { x: Math.sin(r), y: -Math.cos(r) };
}

/** Compass degrees (0 = north, 90 = east) of a direction vector. */
export function degFromDir(d: Vec2): number {
  const deg = (Math.atan2(d.x, -d.y) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Clamp a point to stay inside a circular arena centered on the origin. */
export function clampToArena(p: Vec2, radius: number): Vec2 {
  const l = len(p);
  return l > radius ? scale(p, radius / l) : p;
}

/** Resolve a shape's center when it may be anchored to a player. */
export type PositionLookup = (playerId: string) => Vec2 | undefined;

export function shapeCenter(s: Shape, lookup: PositionLookup): Vec2 | undefined {
  switch (s.kind) {
    case "circle":
      return "player" in s.c ? lookup(s.c.player) : s.c;
    case "donut":
      return s.c;
    case "rect":
    case "cone":
      return s.origin;
  }
}

/** Point-in-shape test. Players are treated as points (no hitbox radius). */
export function inShape(p: Vec2, s: Shape, lookup: PositionLookup): boolean {
  switch (s.kind) {
    case "circle": {
      const c = shapeCenter(s, lookup);
      return c !== undefined && dist(p, c) <= s.r;
    }
    case "donut": {
      const d = dist(p, s.c);
      return d >= s.r0 && d <= s.r1;
    }
    case "rect": {
      const rel = sub(p, s.origin);
      const along = dot(rel, s.dir);
      const across = Math.abs(rel.x * -s.dir.y + rel.y * s.dir.x);
      return along >= 0 && along <= s.length && across <= s.width / 2;
    }
    case "cone": {
      const rel = sub(p, s.origin);
      const d = len(rel);
      if (d > s.r) return false;
      if (d < 1e-6) return true;
      const cos = dot(rel, s.dir) / d;
      return cos >= Math.cos(s.halfAngle);
    }
  }
}
