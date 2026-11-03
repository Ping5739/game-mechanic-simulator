import type { Shape, Vec2 } from "../sim/types";
import { roleOf } from "../sim/types";
import type { ClientSession } from "./client-session";

/** Colors are read from CSS custom properties so the palette lives in one place. */
function palette() {
  const s = getComputedStyle(document.documentElement);
  const g = (n: string) => s.getPropertyValue(n).trim();
  return {
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

const RESOLVE_FLASH_TICKS = 12;

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private colors = palette();
  private scale = 10;
  /** Draw the "where you should be" ghost for your own slot. */
  showGhost = true;
  private cx = 0;
  private cy = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => (this.colors = palette()));
  }

  /** Convert a screen point (CSS pixels relative to the canvas) to world units. */
  toWorld(px: number, py: number): Vec2 {
    return { x: (px - this.cx) / this.scale, y: (py - this.cy) / this.scale };
  }

  private resize(arenaRadius: number): void {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cx = w / 2;
    this.cy = h / 2;
    this.scale = (Math.min(w, h) / 2 - 28) / arenaRadius;
  }

  draw(s: ClientSession): void {
    if (!s.ready) return;
    const enc = s.encounter;
    this.resize(enc.arenaRadius);
    const { ctx, colors: c } = this;
    const k = this.scale;
    const P = (p: Vec2): [number, number] => [this.cx + p.x * k, this.cy + p.y * k];

    ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);

    // Arena floor with a 5-unit grid so distances are readable.
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, enc.arenaRadius * k, 0, Math.PI * 2);
    ctx.fillStyle = c.floor;
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = c.floorLine;
    ctx.lineWidth = 1;
    for (let g = -enc.arenaRadius; g <= enc.arenaRadius; g += 5) {
      ctx.beginPath();
      ctx.moveTo(...P({ x: g, y: -enc.arenaRadius }));
      ctx.lineTo(...P({ x: g, y: enc.arenaRadius }));
      ctx.moveTo(...P({ x: -enc.arenaRadius, y: g }));
      ctx.lineTo(...P({ x: enc.arenaRadius, y: g }));
      ctx.stroke();
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, enc.arenaRadius * k, 0, Math.PI * 2);
    ctx.strokeStyle = c.rim;
    ctx.lineWidth = 3;
    ctx.stroke();

    // Cardinal markers just outside the rim.
    ctx.fillStyle = c.muted;
    ctx.font = "600 13px 'Barlow Semi Condensed', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const off = enc.arenaRadius * k + 15;
    ctx.fillText("N", this.cx, this.cy - off);
    ctx.fillText("S", this.cx, this.cy + off);
    ctx.fillText("E", this.cx + off, this.cy);
    ctx.fillText("W", this.cx - off, this.cy);

    const tick = s.hostTick();
    const positions = s.renderPositions();
    const lookup = (id: string) => positions.get(id);

    // Telegraphs, clipped to the arena.
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, enc.arenaRadius * k + 1, 0, Math.PI * 2);
    ctx.clip();
    for (const h of s.hazards.values()) {
      if (tick < h.startTick) continue;
      const progress = Math.min(1, (tick - h.startTick) / (h.resolveTick - h.startTick));
      const resolved = tick >= h.resolveTick;
      if (resolved && tick > h.resolveTick + RESOLVE_FLASH_TICKS) continue;
      const base = h.mechType === "stack" ? c.stack : h.mechType === "spread" ? c.spread : c.aoe;
      for (const shape of h.shapes) {
        if (!this.path(shape, lookup)) continue;
        if (resolved) {
          const fade = 1 - (tick - h.resolveTick) / RESOLVE_FLASH_TICKS;
          const failed = h.result ? h.result.failed.length > 0 : false;
          ctx.globalAlpha = 0.55 * fade;
          ctx.fillStyle = failed ? c.fail : c.ink;
          ctx.fill("evenodd");
        } else {
          ctx.globalAlpha = 0.14 + 0.22 * progress;
          ctx.fillStyle = base;
          ctx.fill("evenodd");
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = base;
          ctx.lineWidth = 2;
          ctx.setLineDash(h.mechType === "stack" ? [6, 5] : []);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.globalAlpha = 1;
      }
      if (!resolved && h.mechType === "stack" && h.targets) {
        const p = positions.get(h.targets[0]);
        if (p) {
          ctx.fillStyle = c.stack;
          ctx.font = "700 12px 'Barlow Semi Condensed', system-ui, sans-serif";
          ctx.fillText(`Stack ${h.minPlayers ?? ""}+`, this.cx + p.x * k, this.cy + (p.y - 6) * k);
        }
      }
    }
    ctx.restore();

    // Boss.
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, enc.bossRadius * k, 0, Math.PI * 2);
    ctx.strokeStyle = c.boss;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([3, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, Math.max(5, 0.9 * k), 0, Math.PI * 2);
    ctx.fillStyle = c.boss;
    ctx.fill();

    if (this.showGhost) this.drawGhost(s, positions);

    // Players that failed something in the last 1.5 s.
    const recentFails = new Set<string>();
    for (const h of s.hazards.values()) {
      if (h.result && tick - h.resolveTick < 45) for (const id of h.result.failed) recentFails.add(id);
    }

    // Players (draw self last so it's on top).
    const order = [...s.players.values()].sort((a, b) => Number(a.id === s.myId) - Number(b.id === s.myId));
    for (const p of order) {
      const pos = positions.get(p.id);
      if (!pos) continue;
      const [x, y] = P(pos);
      const me = p.id === s.myId;
      const role = roleOf(p.slot);
      const r = Math.max(me ? 9 : 7, (me ? 0.8 : 0.65) * k);
      ctx.globalAlpha = p.isBot ? 0.75 : 1;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = c[role];
      ctx.fill();
      if (me) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = c.ink;
        ctx.stroke();
      } else if (!p.isBot) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = c.ink;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = c.ink;
      ctx.font = `${me ? 700 : 600} 11px 'Barlow Semi Condensed', system-ui, sans-serif`;
      ctx.fillText(p.slot, x, y + r + 9);
      if (recentFails.has(p.id)) {
        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = c.fail;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }
  }

  /**
   * The ghost is a perfect player in your slot: a hollow copy of your marker,
   * a dashed line to where it is heading, and a faint tether from you to it.
   */
  private drawGhost(s: ClientSession, positions: Map<string, Vec2>): void {
    const g = s.ghost();
    const me = positions.get(s.myId);
    if (!g || !me) return;
    const { ctx, colors: c } = this;
    const k = this.scale;
    const P = (p: Vec2): [number, number] => [this.cx + p.x * k, this.cy + p.y * k];
    const roleColor = c[roleOf(s.slot)];
    const r = Math.max(9, 0.8 * k);
    const [gx, gy] = P(g.pos);
    const [dx, dy] = P(g.dest);
    const [mx, my] = P(me);

    // Path the ghost is about to take.
    if (Math.hypot(dx - gx, dy - gy) > r) {
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(dx, dy);
      ctx.strokeStyle = roleColor;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Destination marker: a small ring with a dot.
      ctx.beginPath();
      ctx.arc(dx, dy, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(dx, dy, 2, 0, Math.PI * 2);
      ctx.fillStyle = roleColor;
      ctx.fill();
    }

    // Tether from you to the ghost when you're out of position.
    const off = Math.hypot(gx - mx, gy - my);
    if (off > r * 1.5) {
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(gx, gy);
      ctx.strokeStyle = c.ink;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // The ghost itself.
    ctx.beginPath();
    ctx.arc(gx, gy, r, 0, Math.PI * 2);
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = roleColor;
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  /** Build a canvas path for a shape. Returns false if it can't be placed yet. */
  private path(s: Shape, lookup: (id: string) => Vec2 | undefined): boolean {
    const { ctx } = this;
    const k = this.scale;
    const X = (x: number) => this.cx + x * k;
    const Y = (y: number) => this.cy + y * k;
    ctx.beginPath();
    switch (s.kind) {
      case "circle": {
        const c = "player" in s.c ? lookup(s.c.player) : s.c;
        if (!c) return false;
        ctx.arc(X(c.x), Y(c.y), s.r * k, 0, Math.PI * 2);
        return true;
      }
      case "donut":
        ctx.arc(X(s.c.x), Y(s.c.y), s.r1 * k, 0, Math.PI * 2);
        ctx.moveTo(X(s.c.x) + s.r0 * k, Y(s.c.y));
        ctx.arc(X(s.c.x), Y(s.c.y), s.r0 * k, 0, Math.PI * 2, true);
        return true;
      case "rect": {
        const n = { x: -s.dir.y, y: s.dir.x };
        const hw = s.width / 2;
        const a = { x: s.origin.x + n.x * hw, y: s.origin.y + n.y * hw };
        const b = { x: a.x + s.dir.x * s.length, y: a.y + s.dir.y * s.length };
        const d = { x: s.origin.x - n.x * hw, y: s.origin.y - n.y * hw };
        const e = { x: d.x + s.dir.x * s.length, y: d.y + s.dir.y * s.length };
        ctx.moveTo(X(a.x), Y(a.y));
        ctx.lineTo(X(b.x), Y(b.y));
        ctx.lineTo(X(e.x), Y(e.y));
        ctx.lineTo(X(d.x), Y(d.y));
        ctx.closePath();
        return true;
      }
      case "cone": {
        const ang = Math.atan2(s.dir.y, s.dir.x);
        ctx.moveTo(X(s.origin.x), Y(s.origin.y));
        ctx.arc(X(s.origin.x), Y(s.origin.y), s.r * k, ang - s.halfAngle, ang + s.halfAngle);
        ctx.closePath();
        return true;
      }
    }
  }
}
