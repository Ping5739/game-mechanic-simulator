import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { dirFromDeg } from "../sim/math";
import { roleOf, type ActorDef, type EncounterDef, type Shape, type Vec2 } from "../sim/types";
import type { ClientSession, Placed, TrackedHazard } from "./client-session";
import { RESOLVE_FLASH_TICKS, cssPalette, type Palette, type View } from "./view";

// World (x east, y south) maps to Three.js (x, 0, z) with z = y, so north is −z.
const W = (p: Vec2, h = 0) => new THREE.Vector3(p.x, h, p.y);

const PLAYER_TOP_RADIUS = 0.8;
const PLAYER_HEIGHT = 1.7;

/**
 * An upside-down tetrahedron standing on its tip. The tip touches the ground
 * at the character's position (that point is the hitbox). The top face is a
 * triangle whose front corner points the way the character faces, and the
 * edge from the tip to that corner is highlighted.
 *
 * Local forward is −z (north when unrotated).
 */
function invertedTetra(topRadius: number, height: number): THREE.BufferGeometry {
  const tip = new THREE.Vector3(0, 0, 0);
  const front = new THREE.Vector3(0, height, -topRadius);
  const left = new THREE.Vector3(-topRadius * Math.sin((2 * Math.PI) / 3), height, topRadius * 0.5);
  const right = new THREE.Vector3(topRadius * Math.sin((2 * Math.PI) / 3), height, topRadius * 0.5);
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => [a, b, c].flatMap((v) => [v.x, v.y, v.z]);
  // Faces wound counter-clockwise when seen from outside.
  const verts = [
    ...tri(front, left, right), // top (normal up)
    ...tri(tip, left, front),
    ...tri(tip, front, right),
    ...tri(tip, right, left),
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.computeVertexNormals();
  return g;
}

/** A thin rod along the facing edge, from the tip to the front top corner. */
function facingEdge(topRadius: number, height: number, thickness: number, color: THREE.ColorRepresentation): THREE.Mesh {
  const from = new THREE.Vector3(0, 0, 0);
  const to = new THREE.Vector3(0, height, -topRadius);
  const len = from.distanceTo(to);
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(thickness, thickness, len, 6), new THREE.MeshBasicMaterial({ color }));
  rod.position.copy(from.clone().add(to).multiplyScalar(0.5));
  rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
  return rod;
}

/** Outline points (in world x/y) for a telegraph shape. */
function outline(s: Shape, center: Vec2): Vec2[][] {
  const ring = (c: Vec2, r: number, n = 72) =>
    Array.from({ length: n }, (_, i) => ({ x: c.x + Math.cos((i / n) * Math.PI * 2) * r, y: c.y + Math.sin((i / n) * Math.PI * 2) * r }));
  switch (s.kind) {
    case "circle":
      return [ring(center, s.r)];
    case "donut":
      return [ring(s.c, s.r1), ring(s.c, s.r0)];
    case "rect": {
      const n = { x: -s.dir.y, y: s.dir.x };
      const hw = s.width / 2;
      const a = { x: s.origin.x + n.x * hw, y: s.origin.y + n.y * hw };
      const d = { x: s.origin.x - n.x * hw, y: s.origin.y - n.y * hw };
      return [[a, { x: a.x + s.dir.x * s.length, y: a.y + s.dir.y * s.length }, { x: d.x + s.dir.x * s.length, y: d.y + s.dir.y * s.length }, d]];
    }
    case "cone": {
      const ang = Math.atan2(s.dir.y, s.dir.x);
      const pts = [s.origin];
      const n = 40;
      for (let i = 0; i <= n; i++) {
        const a = ang - s.halfAngle + (i / n) * s.halfAngle * 2;
        pts.push({ x: s.origin.x + Math.cos(a) * s.r, y: s.origin.y + Math.sin(a) * s.r });
      }
      return [pts];
    }
  }
}

/** Filled ground geometry for a shape, positioned relative to `center` for circles. */
function fillGeometry(s: Shape): THREE.BufferGeometry {
  let g: THREE.BufferGeometry;
  switch (s.kind) {
    case "circle":
      g = new THREE.CircleGeometry(s.r, 72);
      break;
    case "donut":
      g = new THREE.RingGeometry(s.r0, s.r1, 96);
      break;
    case "rect":
      g = new THREE.PlaneGeometry(s.width, s.length);
      break;
    case "cone": {
      // CircleGeometry angle t lands at world direction (cos t, −sin t) after
      // the rotation below, so a cone facing (dx, dy) starts at atan2(−dy, dx).
      const t0 = Math.atan2(-s.dir.y, s.dir.x);
      g = new THREE.CircleGeometry(s.r, 48, t0 - s.halfAngle, s.halfAngle * 2);
      break;
    }
  }
  g.rotateX(-Math.PI / 2);
  return g;
}

interface PlayerObj {
  group: THREE.Group;
  body: THREE.Mesh;
  edges: THREE.LineSegments;
  label: CSS2DObject;
  failRing: THREE.Mesh;
  role: string;
  me: boolean;
}

interface HazardObj {
  group: THREE.Group;
  fills: { mesh: THREE.Mesh; shape: Shape }[];
  /** One outline group per shape (a donut has two loops). */
  lines: THREE.Group[];
  label?: CSS2DObject;
}

export class View3D implements View {
  readonly kind = "3d";
  showGhost = true;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
  private colors: Palette = cssPalette();
  private built?: EncounterDef;

  /** Camera orbit around your character, controlled by right-mouse drag and wheel. */
  yaw = 0; // compass degrees the camera looks toward
  pitch = 52; // degrees above the horizon
  distance = 24;

  private readonly players = new Map<string, PlayerObj>();
  private readonly hazards = new Map<number, HazardObj>();
  private readonly actors = new Map<string, THREE.Group>();
  private ghost?: {
    group: THREE.Group;
    route: THREE.Line;
    dest: THREE.Mesh;
    tether: THREE.Line;
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    labelHost: HTMLElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "labels3d";
    labelHost.append(this.labels.domElement);

    this.scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x20263d, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(8, 20, 12);
    this.scene.add(sun);

    this.bindCameraControls();
  }

  setVisible(visible: boolean): void {
    this.canvas.hidden = !visible;
    this.labels.domElement.hidden = !visible;
  }

  /** W/S move along the camera's view, A/D strafe across it. */
  toWorldInput(input: Vec2): Vec2 {
    const f = dirFromDeg(this.yaw);
    const r = dirFromDeg(this.yaw + 90);
    return { x: r.x * input.x - f.x * input.y, y: r.y * input.x - f.y * input.y };
  }

  // -------------------------------------------------------------------------
  // Camera: hold the right mouse button and drag; scroll to zoom.
  // -------------------------------------------------------------------------

  private bindCameraControls(): void {
    const c = this.canvas;
    let dragging: number | undefined;
    let lastX = 0;
    let lastY = 0;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 2) return;
      dragging = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      c.setPointerCapture(e.pointerId);
      c.classList.add("rotating");
    });
    c.addEventListener("pointermove", (e) => {
      if (dragging !== e.pointerId) return;
      this.yaw = (this.yaw + (e.clientX - lastX) * 0.3 + 360) % 360;
      this.pitch = Math.max(8, Math.min(88, this.pitch + (e.clientY - lastY) * 0.25));
      lastX = e.clientX;
      lastY = e.clientY;
    });
    const stop = (e: PointerEvent) => {
      if (dragging !== e.pointerId) return;
      dragging = undefined;
      c.classList.remove("rotating");
    };
    c.addEventListener("pointerup", stop);
    c.addEventListener("pointercancel", stop);
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.distance = Math.max(6, Math.min(50, this.distance * Math.pow(1.1, Math.sign(e.deltaY))));
      },
      { passive: false },
    );
  }

  private placeCamera(target: Vec2): void {
    const f = dirFromDeg(this.yaw);
    const p = (this.pitch * Math.PI) / 180;
    const t = W(target, 1);
    this.camera.position.set(
      t.x - f.x * Math.cos(p) * this.distance,
      t.y + Math.sin(p) * this.distance,
      t.z - f.y * Math.cos(p) * this.distance,
    );
    this.camera.lookAt(t);
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h, false);
      this.labels.setSize(w, h);
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
    }
  }

  // -------------------------------------------------------------------------
  // Static scene
  // -------------------------------------------------------------------------

  private buildArena(enc: EncounterDef): void {
    this.built = enc;
    const c = this.colors;
    this.scene.background = new THREE.Color(c.bg);
    const R = enc.arenaRadius;

    // The floor writes 1 to the stencil buffer; telegraphs only draw where it's 1,
    // which clips lines and cones neatly to the arena.
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(R, 128).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: c.floor,
        roughness: 0.95,
        stencilWrite: true,
        stencilRef: 1,
        stencilFunc: THREE.AlwaysStencilFunc,
        stencilZPass: THREE.ReplaceStencilOp,
      }),
    );
    floor.renderOrder = 0;
    this.scene.add(floor);

    // 5-unit grid, clipped to the circle.
    const pts: THREE.Vector3[] = [];
    for (let g = -R + 5; g < R; g += 5) {
      const half = Math.sqrt(R * R - g * g);
      pts.push(new THREE.Vector3(g, 0.01, -half), new THREE.Vector3(g, 0.01, half));
      pts.push(new THREE.Vector3(-half, 0.01, g), new THREE.Vector3(half, 0.01, g));
    }
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: c.rim, transparent: true, opacity: 0.25 }),
    );
    this.scene.add(grid);

    // A low wall around the edge helps judge distance from any angle.
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(R + 0.1, R + 0.1, 0.5, 128, 1, true),
      new THREE.MeshStandardMaterial({ color: c.rim, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    wall.position.y = 0.25;
    this.scene.add(wall);

    // A dark ground outside the arena so the edge reads clearly.
    const outside = new THREE.Mesh(
      new THREE.RingGeometry(R + 0.1, R * 6, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: c.bg }),
    );
    outside.position.y = -0.01;
    this.scene.add(outside);

    for (const [text, x, z] of [
      ["N", 0, -R - 2],
      ["S", 0, R + 2],
      ["E", R + 2, 0],
      ["W", -R - 2, 0],
    ] as const) {
      const el = document.createElement("div");
      el.className = "label3d cardinal";
      el.textContent = text;
      const o = new CSS2DObject(el);
      o.position.set(x, 0.3, z);
      this.scene.add(o);
    }

  }

  /**
   * Bosses: larger half-transparent inverted tetrahedra; their hitbox is the
   * dashed ring on the ground. Adds: small grey tetrahedra. Tornadoes: a
   * spinning translucent column. Orbs: glowing spheres.
   */
  private buildActors(defs: ActorDef[]): void {
    const c = this.colors;
    const bossColors = [c.boss, c.hand];
    let bossIndex = 0;
    const multipleBosses = defs.filter((d) => d.kind === "boss").length > 1;
    const label = (text: string, y: number, cls: string) => {
      const el = document.createElement("div");
      el.className = `label3d ${cls}`;
      el.textContent = text;
      const o = new CSS2DObject(el);
      o.position.set(0, y, 0);
      return o;
    };
    for (const def of defs) {
      const group = new THREE.Group();
      const look = def.look ?? "tetra";
      group.userData.turns = look === "tetra";
      if (look === "tornado") {
        const col = new THREE.Mesh(
          new THREE.CylinderGeometry(def.radius * 0.6, def.radius * 0.9, 4, 24, 1, true),
          new THREE.MeshStandardMaterial({ color: c.tornado, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }),
        );
        col.position.y = 2;
        const swirl = new THREE.Mesh(
          new THREE.TorusGeometry(def.radius * 0.8, 0.08, 6, 32, Math.PI * 1.3).rotateX(Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: c.tornado }),
        );
        swirl.position.y = 1.2;
        const disc = new THREE.Mesh(
          new THREE.CircleGeometry(def.radius, 40).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: c.tornado, transparent: true, opacity: 0.25, depthWrite: false }),
        );
        disc.position.y = 0.015;
        group.add(col, swirl, disc);
      } else if (look === "orb") {
        const orb = new THREE.Mesh(
          new THREE.SphereGeometry(def.radius, 20, 14),
          new THREE.MeshStandardMaterial({ color: c.orb, emissive: c.orb, emissiveIntensity: 0.6 }),
        );
        orb.position.y = def.radius + 0.3;
        group.add(orb);
      } else if (def.kind === "boss") {
        const color = bossColors[bossIndex++ % bossColors.length];
        const h = def.radius * 1.6;
        group.add(
          new THREE.Mesh(
            invertedTetra(def.radius, h),
            new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.5, flatShading: true, depthWrite: false }),
          ),
        );
        group.add(facingEdge(def.radius, h, 0.08, c.ink));
        const ringPts = Array.from({ length: 97 }, (_, i) => {
          const a = (i / 96) * Math.PI * 2;
          return new THREE.Vector3(Math.cos(a) * def.radius, 0.04, Math.sin(a) * def.radius);
        });
        const ring = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(ringPts),
          new THREE.LineDashedMaterial({ color, dashSize: 0.5, gapSize: 0.35 }),
        );
        ring.computeLineDistances();
        group.add(ring);
        if (multipleBosses) group.add(label(def.name, h + 0.8, "boss-label"));
      } else {
        const r = Math.max(0.6, def.radius);
        group.add(
          new THREE.Mesh(invertedTetra(r, r * 2), new THREE.MeshStandardMaterial({ color: c.add, flatShading: true })),
          facingEdge(r, r * 2, 0.04, c.ink),
          label(def.name, r * 2 + 0.5, "add-label"),
        );
      }
      this.scene.add(group);
      this.actors.set(def.id, group);
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  draw(s: ClientSession): void {
    if (!s.ready) return;
    if (this.built !== s.encounter) {
      this.buildArena(s.encounter);
      this.buildActors(s.actorDefs);
    }
    this.resize();

    const positions = s.renderPositions();
    const lookup = (id: string) => positions.get(id);
    const tick = s.hostTick();

    for (const [id, a] of s.renderActors()) {
      const obj = this.actors.get(id);
      if (!obj) continue;
      obj.visible = a.visible;
      obj.position.set(a.x, 0, a.y);
      if (obj.userData.turns) obj.rotation.y = (-a.facing * Math.PI) / 180;
      else obj.rotation.y += 0.03; // tornadoes spin
    }
    this.syncHazards(s, tick, lookup);
    this.syncPlayers(s, positions, tick);
    this.syncGhost(s, positions);

    const me = positions.get(s.myId) ?? { x: 0, y: 0 };
    this.placeCamera(me);
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  private syncPlayers(s: ClientSession, positions: Map<string, Placed>, tick: number): void {
    const c = this.colors;
    const recentFails = new Set<string>();
    for (const h of s.hazards.values() as Iterable<TrackedHazard>) {
      if (h.result && tick - h.resolveTick < 45) for (const id of h.result.failed) recentFails.add(id);
    }

    for (const [id, obj] of this.players) {
      if (!s.players.has(id)) {
        this.scene.remove(obj.group);
        obj.label.element.remove();
        this.players.delete(id);
      }
    }

    for (const p of s.players.values()) {
      const pos = positions.get(p.id);
      const role = roleOf(p.slot);
      const me = p.id === s.myId;
      let obj = this.players.get(p.id);
      if (obj && (obj.role !== role || obj.me !== me)) {
        this.scene.remove(obj.group);
        obj.label.element.remove();
        obj = undefined;
      }
      if (!obj) {
        obj = this.makePlayer(c[role], me, role);
        this.players.set(p.id, obj);
        this.scene.add(obj.group);
      }
      obj.group.visible = pos !== undefined;
      if (!pos) continue;
      obj.group.position.set(pos.x, 0, pos.y);
      obj.group.rotation.y = (-pos.facing * Math.PI) / 180;
      const mat = obj.body.material as THREE.MeshStandardMaterial;
      mat.opacity = p.isBot ? 0.8 : 1;
      obj.label.element.textContent = p.slot;
      obj.failRing.visible = recentFails.has(p.id);
    }
  }

  private makePlayer(color: string, me: boolean, role: string): PlayerObj {
    const c = this.colors;
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      invertedTetra(PLAYER_TOP_RADIUS, PLAYER_HEIGHT),
      new THREE.MeshStandardMaterial({ color, flatShading: true, transparent: true, roughness: 0.6 }),
    );
    group.add(body);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(body.geometry),
      new THREE.LineBasicMaterial({ color: me ? c.ink : 0x000000, transparent: true, opacity: me ? 1 : 0.35 }),
    );
    group.add(edges);
    group.add(facingEdge(PLAYER_TOP_RADIUS, PLAYER_HEIGHT, me ? 0.06 : 0.045, c.ink));

    // The hitbox: the tip, marked where it touches the ground.
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.14, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: c.ink }));
    dot.position.y = 0.035;
    group.add(dot);

    const failRing = new THREE.Mesh(
      new THREE.RingGeometry(0.75, 0.95, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: c.fail, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    failRing.position.y = 0.04;
    failRing.visible = false;
    group.add(failRing);

    const el = document.createElement("div");
    el.className = `label3d slot-label${me ? " me" : ""}`;
    const label = new CSS2DObject(el);
    label.position.set(0, PLAYER_HEIGHT + 0.45, 0);
    group.add(label);
    return { group, body, edges, label, failRing, role, me };
  }

  private syncHazards(s: ClientSession, tick: number, lookup: (id: string) => Vec2 | undefined): void {
    const c = this.colors;
    for (const [id, obj] of this.hazards) {
      const h = s.hazards.get(id);
      if (!h || tick > h.resolveTick + RESOLVE_FLASH_TICKS) {
        this.disposeHazard(obj);
        this.hazards.delete(id);
      }
    }

    for (const h of s.hazards.values() as Iterable<TrackedHazard>) {
      if (tick < h.startTick || tick > h.resolveTick + RESOLVE_FLASH_TICKS) continue;
      let obj = this.hazards.get(h.id);
      if (obj && obj.fills.length !== h.shapes.length) {
        this.disposeHazard(obj);
        this.hazards.delete(h.id);
        obj = undefined;
      }
      const base = h.mechType === "stack" ? c.stack : h.mechType === "spread" ? c.spread : c.aoe;
      if (!obj) {
        obj = this.makeHazard(h, base);
        this.hazards.set(h.id, obj);
        this.scene.add(obj.group);
      }

      const progress = Math.min(1, (tick - h.startTick) / (h.resolveTick - h.startTick));
      const resolved = tick >= h.resolveTick;
      const fade = resolved ? 1 - (tick - h.resolveTick) / RESOLVE_FLASH_TICKS : 1;
      const failed = h.result ? h.result.failed.length > 0 : false;

      // Player-anchored circles (spread, stack) follow their target.
      obj.fills.forEach(({ mesh, shape }, i) => {
        if (shape.kind === "circle" && "player" in shape.c) {
          const p = lookup(shape.c.player);
          mesh.visible = p !== undefined;
          obj.lines[i].visible = p !== undefined && !resolved;
          if (p) {
            mesh.position.x = p.x;
            mesh.position.z = p.y;
            obj.lines[i].position.x = p.x;
            obj.lines[i].position.z = p.y;
          }
        }
        const m = mesh.material as THREE.MeshBasicMaterial;
        if (resolved) {
          m.color.set(failed ? c.fail : c.ink);
          m.opacity = 0.55 * fade;
        } else {
          m.opacity = 0.16 + 0.24 * progress;
        }
      });
      if (resolved) for (const l of obj.lines) l.visible = false;
      if (obj.label) {
        const target = h.targets?.[0];
        const p = target ? lookup(target) : undefined;
        obj.label.visible = !resolved && p !== undefined;
        if (p) obj.label.position.set(p.x, PLAYER_HEIGHT + 1.3, p.y);
      }
    }
  }

  private makeHazard(h: TrackedHazard, color: string): HazardObj {
    const group = new THREE.Group();
    const y = 0.02 + (h.id % 8) * 0.003;
    const stencil = {
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.EqualStencilFunc,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
    };
    const fills: HazardObj["fills"] = [];
    const lines: THREE.Group[] = [];
    for (const shape of h.shapes) {
      const anchored = shape.kind === "circle" && "player" in shape.c;
      const mesh = new THREE.Mesh(
        fillGeometry(shape),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide, ...stencil }),
      );
      mesh.renderOrder = 1;
      const center = anchored ? { x: 0, y: 0 } : shape.kind === "circle" ? (shape.c as Vec2) : { x: 0, y: 0 };
      if (shape.kind === "circle") mesh.position.set(anchored ? 0 : center.x, y, anchored ? 0 : center.y);
      else if (shape.kind === "donut") mesh.position.set(shape.c.x, y, shape.c.y);
      else if (shape.kind === "rect") {
        mesh.position.set(shape.origin.x + (shape.dir.x * shape.length) / 2, y, shape.origin.y + (shape.dir.y * shape.length) / 2);
        mesh.rotation.y = Math.atan2(shape.dir.x, shape.dir.y);
      } else mesh.position.set(shape.origin.x, y, shape.origin.y);
      group.add(mesh);
      fills.push({ mesh, shape });

      // Outline(s): drawn relative to the circle's center so anchored ones can move.
      const loops = outline(shape, anchored ? { x: 0, y: 0 } : center);
      const dashed = h.mechType === "stack";
      const lineMat = dashed
        ? new THREE.LineDashedMaterial({ color, dashSize: 0.7, gapSize: 0.5, ...stencil })
        : new THREE.LineBasicMaterial({ color, ...stencil });
      const lineGroup = new THREE.Group();
      for (const loop of loops) {
        const pts = loop.map((p) => new THREE.Vector3(p.x, y + 0.004, p.y));
        const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), lineMat);
        line.renderOrder = 2;
        if (dashed) line.computeLineDistances();
        lineGroup.add(line);
      }
      group.add(lineGroup);
      lines.push(lineGroup);
    }

    let label: CSS2DObject | undefined;
    if (h.mechType === "stack") {
      const el = document.createElement("div");
      el.className = "label3d stack-label";
      el.textContent = `Stack ${h.minPlayers ?? ""}+`;
      label = new CSS2DObject(el);
      group.add(label);
    }
    return { group, fills, lines, label };
  }

  private disposeHazard(obj: HazardObj): void {
    this.scene.remove(obj.group);
    obj.label?.element.remove();
    obj.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose();
    });
  }

  private syncGhost(s: ClientSession, positions: Map<string, Placed>): void {
    const c = this.colors;
    const g = this.showGhost ? s.ghost() : undefined;
    const me = positions.get(s.myId);
    if (!this.ghost) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(
        invertedTetra(PLAYER_TOP_RADIUS, PLAYER_HEIGHT),
        new THREE.MeshBasicMaterial({ color: c.ink, transparent: true, opacity: 0.18, depthWrite: false }),
      );
      group.add(body);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(body.geometry),
        new THREE.LineDashedMaterial({ color: c.ink, dashSize: 0.18, gapSize: 0.12 }),
      );
      edges.computeLineDistances();
      group.add(edges);
      const dot = new THREE.Mesh(
        new THREE.RingGeometry(0.12, 0.2, 16).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: c.ink }),
      );
      dot.position.y = 0.03;
      group.add(dot);
      const route = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineDashedMaterial({ color: c.ink, dashSize: 0.5, gapSize: 0.35 }),
      );
      const dest = new THREE.Mesh(
        new THREE.RingGeometry(0.35, 0.55, 24).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: c.ink, transparent: true, opacity: 0.9, depthWrite: false }),
      );
      dest.position.y = 0.05;
      const tether = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineDashedMaterial({ color: c.ink, dashSize: 0.15, gapSize: 0.3, transparent: true, opacity: 0.45 }),
      );
      this.scene.add(group, route, dest, tether);
      this.ghost = { group, route, dest, tether };
    }
    const { group, route, dest, tether } = this.ghost;
    const roleColor = c[roleOf(s.slot)];
    (group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.color.set(roleColor);
    (route.material as THREE.LineDashedMaterial).color.set(roleColor);
    (dest.material as THREE.MeshBasicMaterial).color.set(roleColor);

    const visible = g !== undefined && me !== undefined;
    group.visible = route.visible = dest.visible = tether.visible = visible;
    if (!visible) return;

    group.position.set(g.pos.x, 0, g.pos.y);
    group.rotation.y = (-g.facing * Math.PI) / 180;

    const far = Math.hypot(g.dest.x - g.pos.x, g.dest.y - g.pos.y) > 0.6;
    route.visible = dest.visible = far;
    if (far) {
      route.geometry.setFromPoints([W(g.pos, 0.06), W(g.dest, 0.06)]);
      route.computeLineDistances();
      dest.position.x = g.dest.x;
      dest.position.z = g.dest.y;
    }
    const off = Math.hypot(g.pos.x - me.x, g.pos.y - me.y) > 1.2;
    tether.visible = off;
    if (off) {
      tether.geometry.setFromPoints([W(me, 0.06), W(g.pos, 0.06)]);
      tether.computeLineDistances();
    }
  }
}
