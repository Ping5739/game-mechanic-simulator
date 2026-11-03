import type { Vec2 } from "../sim/types";
import type { ClientSession } from "./client-session";

/** Something that can draw the game: the 2D top-down canvas or the 3D scene. */
export interface View {
  readonly kind: "2d" | "3d";
  /** Draw the "where you should be" ghost and its route. */
  showGhost: boolean;
  draw(s: ClientSession): void;
  /**
   * Turn keyboard input (x: right, y: back, as on screen) into a world
   * direction. In 2D, W is always north; in 3D it's away from the camera.
   */
  toWorldInput(input: Vec2): Vec2;
  setVisible(visible: boolean): void;
}

/** Colors live in CSS custom properties so both views share one palette. */
export function cssPalette() {
  const s = getComputedStyle(document.documentElement);
  const g = (n: string) => s.getPropertyValue(n).trim();
  return {
    bg: g("--bg"),
    floor: g("--floor"),
    floorLine: g("--floor-line"),
    rim: g("--rim"),
    ink: g("--ink"),
    muted: g("--muted"),
    boss: g("--boss"),
    aoe: g("--aoe"),
    stack: g("--stack"),
    spread: g("--spread"),
    fail: g("--fail"),
    tank: g("--tank"),
    healer: g("--healer"),
    dps: g("--dps"),
  };
}

export type Palette = ReturnType<typeof cssPalette>;

/** Ticks a resolved telegraph keeps flashing for. */
export const RESOLVE_FLASH_TICKS = 12;
