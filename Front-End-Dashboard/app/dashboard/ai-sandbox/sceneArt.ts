import type { SceneMark } from "./scenarios/adapter";
import type { RainIntensity, VehicleKind } from "./scenarios/assumptions";

/**
 * Canvas art for scenario events: what each one looks like ON THE ROAD, in place of the amber triangle
 * marker every family used to get. Pure drawing, no React and no engine: everything here reads a
 * SceneMark (adapter.ts's sceneMarks — the family, the running phase and how far through it, the lanes
 * and stretch the event is actually holding) plus the geometry render() already computed, and paints.
 *
 * Nothing here changes what the engine does. A wreck is drawn only where the closure the engine is
 * honouring says lanes are blocked (SceneMark.closedLanes is empty when an event yielded its closure to
 * the operator's), and responders arrive and leave by phase, so the picture stays a picture of the model,
 * not a second model. Animation runs off `g.t`, seconds of real time that stop while the run is paused.
 */

/**
 * The part of the 2D canvas context the scene art uses, and no more. A real CanvasRenderingContext2D
 * satisfies it, and so does a recording stand-in, which is how verify.ts runs the drawing code in Node and
 * checks what it paints (how much rain, that a paused clock freezes it, that a pending event draws nothing).
 */
export type SceneCtx = Pick<
  CanvasRenderingContext2D,
  | "save" | "restore" | "translate" | "scale" | "rotate" | "beginPath" | "closePath" | "moveTo" | "lineTo" | "arc" | "arcTo" | "ellipse" | "rect"
  | "fill" | "stroke" | "clip" | "fillRect" | "strokeRect" | "fillText" | "createLinearGradient" | "setLineDash"
  | "fillStyle" | "strokeStyle" | "lineWidth" | "lineJoin" | "font" | "textAlign" | "textBaseline"
>;

export type SceneGeometry = {
  readonly ctx: SceneCtx;
  readonly cssW: number;
  readonly roadTop: number;
  readonly roadH: number;
  readonly laneH: number;
  /** Metres along the road in the direction of travel -> screen x (mirrored for southbound). */
  readonly xPx: (m: number) => number;
  /** +1: traffic runs left to right on screen; -1: right to left. */
  readonly fwd: 1 | -1;
  /** Centre y of an engine lane's slot (accounts for Both mode's reversed NB block). */
  readonly laneCenterY: (engineLane: number) => number;
  /** Screen y of the road's outer (shoulder-side) edge, and which way "outward" points (-1 up, +1 down). */
  readonly outerEdgeY: number;
  readonly outward: 1 | -1;
  /** Size of a "hero" car in px: the scene's vehicles are drawn larger than traffic so they read as the event. */
  readonly carLen: number;
  readonly carWid: number;
  /** Seconds of animation clock; frozen while the run is paused. */
  readonly t: number;
};

/* ── small helpers ─────────────────────────────────────────────────────────── */

/** Deterministic pseudo-random in [0, 1) from a number: stable drop positions without any per-drop state. */
function hash(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const smooth = (v: number): number => {
  const c = clamp01(v);
  return c * c * (3 - 2 * c);
};
/** 0 until `from`, 1 from `to`, eased in between. */
const ramp = (f: number, from: number, to: number): number => smooth((f - from) / Math.max(1e-6, to - from));
const wrap = (v: number, period: number): number => ((v % period) + period) % period;

function rrect(ctx: SceneCtx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Run `paint` in a local frame centred on (x, y), rotated `angle`, with +x pointing the way traffic travels. */
function inFrame(g: SceneGeometry, x: number, y: number, angle: number, paint: () => void): void {
  g.ctx.save();
  g.ctx.translate(x, y);
  g.ctx.scale(g.fwd, 1);
  g.ctx.rotate(angle);
  paint();
  g.ctx.restore();
}

/* ── vehicles (top-down, centred, nose toward +x) ──────────────────────────── */

type CarStyle = { readonly body: string; readonly roof: string; readonly glass: string };
const GLASS = "rgba(186,214,250,0.92)";

function paintCar(ctx: SceneCtx, len: number, wid: number, s: CarStyle): void {
  ctx.fillStyle = "rgba(0,0,0,0.30)";
  rrect(ctx, -len / 2 + 1.5, -wid / 2 + 2.5, len, wid, wid * 0.32);
  ctx.fill();
  ctx.fillStyle = s.body;
  rrect(ctx, -len / 2, -wid / 2, len, wid, wid * 0.32);
  ctx.fill();
  ctx.fillStyle = s.glass;
  rrect(ctx, len * 0.14, -wid * 0.4, len * 0.2, wid * 0.8, wid * 0.14); // windscreen
  ctx.fill();
  rrect(ctx, -len * 0.38, -wid * 0.36, len * 0.12, wid * 0.72, wid * 0.1); // rear glass
  ctx.fill();
  ctx.fillStyle = s.roof;
  rrect(ctx, -len * 0.24, -wid * 0.36, len * 0.36, wid * 0.72, wid * 0.16);
  ctx.fill();
}

function paintTruck(ctx: SceneCtx, len: number, wid: number, cab: string, trailer: string): void {
  const cabLen = len * 0.27;
  ctx.fillStyle = "rgba(0,0,0,0.30)";
  rrect(ctx, -len / 2 + 1.5, -wid / 2 + 2.5, len, wid, 3);
  ctx.fill();
  ctx.fillStyle = trailer;
  rrect(ctx, -len / 2, -wid / 2, len - cabLen - len * 0.03, wid, 2.5);
  ctx.fill();
  ctx.strokeStyle = "rgba(15,23,42,0.35)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = cab;
  rrect(ctx, len / 2 - cabLen, -wid * 0.46, cabLen, wid * 0.92, wid * 0.22);
  ctx.fill();
  ctx.fillStyle = GLASS;
  rrect(ctx, len / 2 - cabLen * 0.45, -wid * 0.36, cabLen * 0.32, wid * 0.72, wid * 0.1);
  ctx.fill();
}

/** Four amber lamps at the corners, lit half the time: the universal "I am stopped" signal. */
function paintHazards(ctx: SceneCtx, len: number, wid: number, on: boolean): void {
  if (!on) return;
  const r = Math.max(1.6, wid * 0.12);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const x = (sx * len) / 2;
      const y = sy * wid * 0.42;
      ctx.fillStyle = "rgba(251,191,36,0.28)";
      ctx.beginPath();
      ctx.arc(x, y, r * 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fbbf24";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** A roof light bar whose two halves alternate: police (red/blue), ambulance (red/white), tow (amber). */
function paintLightBar(ctx: SceneCtx, wid: number, t: number, a: string, b: string, rate: number, at = 0): void {
  const phase = Math.floor(t * rate) % 2 === 0;
  const w = wid * 0.34;
  for (const side of [-1, 1] as const) {
    const lit = (side === -1) === phase;
    const c = side === -1 ? a : b;
    ctx.fillStyle = lit ? c : "rgba(30,41,59,0.85)";
    rrect(ctx, at - w / 2, side === -1 ? -wid * 0.44 : wid * 0.44 - w, w, w, 1.2);
    ctx.fill();
    if (lit) {
      ctx.fillStyle = c.replace(")", ",0.30)").replace("rgb(", "rgba(");
      ctx.beginPath();
      ctx.arc(at, side * wid * 0.28, wid * 0.85, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

const STALLED: Readonly<Record<VehicleKind, { readonly lenX: number; readonly widX: number; readonly style: CarStyle; readonly trailer?: string }>> = {
  car: { lenX: 1, widX: 1, style: { body: "#64748b", roof: "#94a3b8", glass: GLASS } },
  bus: { lenX: 2.3, widX: 1.15, style: { body: "#16a34a", roof: "#22c55e", glass: GLASS } },
  truck: { lenX: 2.8, widX: 1.15, style: { body: "#6d28d9", roof: "#8b5cf6", glass: GLASS }, trailer: "#c7d2fe" },
};

function drawStalled(g: SceneGeometry, x: number, y: number, kind: VehicleKind, angle: number, hazards: boolean): { readonly len: number; readonly wid: number } {
  const spec = STALLED[kind];
  const len = g.carLen * spec.lenX;
  const wid = Math.min(g.laneH * 0.74, g.carWid * spec.widX);
  inFrame(g, x - g.fwd * (len / 2), y, angle, () => {
    if (spec.trailer !== undefined) paintTruck(g.ctx, len, wid, spec.style.body, spec.trailer);
    else paintCar(g.ctx, len, wid, spec.style);
    paintHazards(g.ctx, len, wid, hazards);
  });
  return { len, wid };
}

function drawPolice(g: SceneGeometry, x: number, y: number, angle = 0): void {
  const len = g.carLen * 1.05;
  const wid = g.carWid;
  inFrame(g, x, y, angle, () => {
    paintCar(g.ctx, len, wid, { body: "#f8fafc", roof: "#1e3a8a", glass: GLASS });
    paintLightBar(g.ctx, wid, g.t, "rgb(239,68,68)", "rgb(59,130,246)", 5, len * 0.02);
  });
}

function drawAmbulance(g: SceneGeometry, x: number, y: number): void {
  const len = g.carLen * 1.5;
  const wid = g.carWid * 1.08;
  inFrame(g, x, y, 0, () => {
    const c = g.ctx;
    paintCar(c, len, wid, { body: "#f8fafc", roof: "#e2e8f0", glass: GLASS });
    c.fillStyle = "#dc2626";
    c.fillRect(-len * 0.12, -wid * 0.09, len * 0.24, wid * 0.18); // cross
    c.fillRect(-len * 0.04, -wid * 0.25, len * 0.08, wid * 0.5);
    paintLightBar(c, wid, g.t, "rgb(239,68,68)", "rgb(248,250,252)", 4, len * 0.26);
  });
}

function drawTow(g: SceneGeometry, x: number, y: number, heavy = false): void {
  const len = g.carLen * (heavy ? 2.3 : 1.7);
  const wid = Math.min(g.laneH * 0.78, g.carWid * (heavy ? 1.25 : 1.1));
  inFrame(g, x, y, 0, () => {
    const c = g.ctx;
    paintTruck(c, len, wid, "#f59e0b", "#334155");
    c.fillStyle = "#f59e0b"; // flatbed markings
    c.fillRect(-len * 0.44, -wid * 0.08, len * 0.4, wid * 0.16);
    if (heavy) {
      c.strokeStyle = "#f59e0b"; // crane boom
      c.lineWidth = Math.max(1.5, wid * 0.12);
      c.beginPath();
      c.moveTo(-len * 0.05, 0);
      c.lineTo(-len * 0.5, wid * 0.32);
      c.stroke();
    }
    const on = Math.floor(g.t * 3) % 2 === 0;
    c.fillStyle = on ? "#fde047" : "#a16207";
    c.beginPath();
    c.arc(len * 0.2, 0, Math.max(2, wid * 0.16), 0, Math.PI * 2);
    c.fill();
    if (on) {
      c.fillStyle = "rgba(253,224,71,0.30)";
      c.beginPath();
      c.arc(len * 0.2, 0, wid * 0.8, 0, Math.PI * 2);
      c.fill();
    }
  });
}

/* ── road furniture ─────────────────────────────────────────────────────────── */

function drawCone(g: SceneGeometry, x: number, y: number, r: number): void {
  const c = g.ctx;
  c.fillStyle = "rgba(0,0,0,0.28)";
  c.beginPath();
  c.arc(x + 1, y + 1.5, r, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#f97316";
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#f8fafc";
  c.beginPath();
  c.arc(x, y, r * 0.62, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#f97316";
  c.beginPath();
  c.arc(x, y, r * 0.3, 0, Math.PI * 2);
  c.fill();
}

function drawBarrel(g: SceneGeometry, x: number, y: number, r: number): void {
  const c = g.ctx;
  c.fillStyle = "rgba(0,0,0,0.28)";
  c.beginPath();
  c.arc(x + 1, y + 1.5, r, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#f97316";
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = "#f8fafc";
  c.lineWidth = Math.max(1, r * 0.34);
  for (const k of [0.68, 0.32]) {
    c.beginPath();
    c.arc(x, y, r * k, 0, Math.PI * 2);
    c.stroke();
  }
}

/** A warning triangle set out behind a stopped vehicle: red frame, white face. */
function drawWarningTriangle(g: SceneGeometry, x: number, y: number, s: number): void {
  const c = g.ctx;
  const tip = g.fwd; // points the way traffic is coming FROM, i.e. faces oncoming drivers
  c.save();
  c.translate(x, y);
  c.beginPath();
  c.moveTo(-tip * s, 0);
  c.lineTo(tip * s * 0.7, -s * 0.85);
  c.lineTo(tip * s * 0.7, s * 0.85);
  c.closePath();
  c.fillStyle = "#f8fafc";
  c.fill();
  c.lineWidth = Math.max(1.5, s * 0.32);
  c.strokeStyle = "#dc2626";
  c.lineJoin = "round";
  c.stroke();
  c.restore();
}

/** A yellow diamond caution sign on a post at the road's edge, with a glyph on it. */
function drawCautionSign(g: SceneGeometry, x: number, glyph: string): void {
  const c = g.ctx;
  const s = Math.max(9, Math.min(15, g.laneH * 0.32));
  const y = g.outerEdgeY + g.outward * (s * 0.9);
  c.save();
  c.translate(x, y);
  c.rotate(Math.PI / 4);
  c.fillStyle = "rgba(0,0,0,0.3)";
  c.fillRect(-s * 0.55 + 1, -s * 0.55 + 1.5, s * 1.1, s * 1.1);
  c.fillStyle = "#fbbf24";
  c.fillRect(-s * 0.55, -s * 0.55, s * 1.1, s * 1.1);
  c.strokeStyle = "#1f2937";
  c.lineWidth = 1.2;
  c.strokeRect(-s * 0.45, -s * 0.45, s * 0.9, s * 0.9);
  c.restore();
  c.fillStyle = "#1f2937";
  c.font = `800 ${Math.round(s * 0.82)}px system-ui`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(glyph, x, y + 0.5);
}

/** Cones set in a diagonal taper from the lane edge into the lane, upstream of the obstruction. */
function drawTaper(g: SceneGeometry, xStart: number, y: number, toward: 1 | -1, count: number, spanPx: number): void {
  const r = Math.max(2.2, Math.min(4.4, g.laneH * 0.07));
  for (let i = 0; i < count; i++) {
    const f = count === 1 ? 1 : i / (count - 1);
    drawCone(g, xStart + g.fwd * spanPx * f, y - toward * g.laneH * 0.46 * (1 - f) + toward * g.laneH * 0.0, r);
  }
}

/** A lit arrow board (as on a work or patrol truck) pointing sideways; its chevrons chase. */
function drawArrowBoard(g: SceneGeometry, x: number, y: number, w: number, h: number, toward: 1 | -1): void {
  const c = g.ctx;
  c.fillStyle = "#0f172a";
  rrect(c, x - w / 2, y - h / 2, w, h, 1.5);
  c.fill();
  const step = Math.floor(g.t * 3) % 3;
  for (let i = 0; i < 3; i++) {
    const lit = i <= step;
    c.fillStyle = lit ? "#fbbf24" : "rgba(251,191,36,0.16)";
    const cx = x - w * 0.28 + i * w * 0.28;
    c.beginPath();
    c.moveTo(cx - w * 0.06, y - toward * h * 0.28);
    c.lineTo(cx + w * 0.06, y);
    c.lineTo(cx - w * 0.06, y + toward * h * 0.28);
    c.lineTo(cx - w * 0.02, y);
    c.closePath();
    c.fill();
  }
}

function drawSkid(g: SceneGeometry, x: number, y: number, length: number, angle: number): void {
  const c = g.ctx;
  c.strokeStyle = "rgba(2,6,23,0.55)";
  c.lineWidth = Math.max(1, g.carWid * 0.1);
  for (const off of [-0.22, 0.22]) {
    c.beginPath();
    c.moveTo(x - g.fwd * length, y + off * g.carWid * 1.6 - Math.sin(angle) * length * 0.25);
    c.lineTo(x, y + off * g.carWid * 1.6);
    c.stroke();
  }
}

function drawDebris(g: SceneGeometry, x: number, y: number, spreadX: number, spreadY: number, seed: number, n: number): void {
  const c = g.ctx;
  const palette = ["#94a3b8", "#475569", "#ef4444", "#e2e8f0", "#0f172a", "#38bdf8"];
  for (let i = 0; i < n; i++) {
    const px = x + (hash(seed + i) - 0.5) * spreadX * 2;
    const py = y + (hash(seed + i + 40) - 0.5) * spreadY * 2;
    c.save();
    c.translate(px, py);
    c.rotate(hash(seed + i + 80) * Math.PI);
    c.fillStyle = palette[Math.floor(hash(seed + i + 120) * palette.length)];
    const s = 1.2 + hash(seed + i + 160) * Math.max(1.5, g.carWid * 0.18);
    c.fillRect(-s, -s * 0.45, s * 2, s * 0.9);
    c.restore();
  }
}

/** Rising, fading puffs over a wreck. */
function drawSmoke(g: SceneGeometry, x: number, y: number, size: number, strength: number): void {
  const c = g.ctx;
  for (let i = 0; i < 7; i++) {
    const cycle = wrap(g.t * 0.35 + hash(i * 3) * 2, 1);
    const px = x + (hash(i * 7) - 0.5) * size * 0.9 + Math.sin(g.t + i) * size * 0.08;
    const py = y - g.outward * cycle * size * 1.1;
    c.fillStyle = `rgba(226,232,240,${(1 - cycle) * 0.34 * strength})`;
    c.beginPath();
    c.arc(px, py, size * (0.16 + cycle * 0.34), 0, Math.PI * 2);
    c.fill();
  }
}

/* ── weather ──────────────────────────────────────────────────────────────────── */

const RAIN: Readonly<Record<RainIntensity, { readonly density: number; readonly speed: number; readonly len: number; readonly alpha: number; readonly width: number; readonly tint: number; readonly ripples: number }>> = {
  light: { density: 1 / 2600, speed: 360, len: 7, alpha: 0.34, width: 1, tint: 0.06, ripples: 3 },
  moderate: { density: 1 / 1050, speed: 560, len: 11, alpha: 0.44, width: 1.15, tint: 0.12, ripples: 9 },
  heavy: { density: 1 / 480, speed: 800, len: 16, alpha: 0.56, width: 1.35, tint: 0.2, ripples: 18 },
};

/**
 * Rain over one carriageway: a wet, cool tint on the tarmac, streaks of falling drops in two depth
 * layers (the near layer longer, faster and brighter), and rings spreading where drops land. The
 * drops are deterministic from the clock — nothing is stored per drop — and drawn as one path per
 * layer, so even heavy rain is a couple of strokes a frame.
 */
export function drawRain(g: SceneGeometry, intensity: RainIntensity): void {
  const cfg = RAIN[intensity];
  const c = g.ctx;
  const y0 = g.roadTop;
  const w = g.cssW;
  const h = g.roadH;
  c.save();
  c.beginPath();
  c.rect(0, y0, w, h);
  c.clip();

  const sheen = c.createLinearGradient(0, y0, 0, y0 + h);
  sheen.addColorStop(0, `rgba(30,64,120,${cfg.tint * 0.55})`);
  sheen.addColorStop(1, `rgba(30,64,120,${cfg.tint})`);
  c.fillStyle = sheen;
  c.fillRect(0, y0, w, h);

  const slant = 0.2;
  const total = Math.max(20, Math.round(w * h * cfg.density));
  for (let layer = 0; layer < 2; layer++) {
    const near = layer === 1;
    const len = cfg.len * (near ? 1.5 : 1);
    const speed = cfg.speed * (near ? 1.3 : 0.85);
    c.strokeStyle = `rgba(203,222,255,${cfg.alpha * (near ? 1 : 0.7)})`;
    c.lineWidth = cfg.width * (near ? 1.2 : 0.9);
    c.beginPath();
    const n = Math.round(total * (near ? 0.4 : 0.6));
    for (let i = 0; i < n; i++) {
      const seed = i + layer * 7919;
      const y = wrap(hash(seed + 0.5) * h + g.t * speed, h + len);
      const x = wrap(hash(seed) * w + y * slant, w);
      c.moveTo(x, y0 + y - len);
      c.lineTo(x + len * slant, y0 + y);
    }
    c.stroke();
  }

  c.lineWidth = 1;
  for (let r = 0; r < cfg.ripples; r++) {
    const cycle = wrap(g.t * 0.85 + hash(r * 5) * 3, 1);
    const px = hash(r * 3 + 1) * w;
    const py = g.roadTop + hash(r * 3 + 2) * g.roadH;
    c.strokeStyle = `rgba(203,222,255,${(1 - cycle) * 0.4})`;
    c.beginPath();
    c.ellipse(px, py, 1.5 + cycle * 8, 0.7 + cycle * 3.4, 0, 0, Math.PI * 2);
    c.stroke();
  }
  c.restore();
}

/* ── flood ───────────────────────────────────────────────────────────────────── */

/**
 * Standing, FLOWING water over the flooded lane(s): a shoreline that ripples, a body of water that
 * darkens toward its middle, streaks and glints sliding along the direction of travel, and foam along the
 * edges. Drawn over the closure hatch so the lane reads as under water, with the depth-gauge post and a
 * caution sign at the upstream end.
 */
function drawFlood(g: SceneGeometry, m: SceneMark): void {
  if (m.stretch === null || m.closedLanes.length === 0) return;
  const c = g.ctx;
  const a = g.xPx(m.stretch.fromM);
  const b = g.xPx(m.stretch.toM);
  const left = Math.min(a, b);
  const w = Math.max(30, Math.abs(b - a));
  const grow = ramp(m.phaseFraction, 0, 0.06); // the water rises over the first moments
  for (const lane of m.closedLanes) {
    const top = g.laneCenterY(lane) - g.laneH / 2;
    const inset = g.laneH * 0.06;
    const h = g.laneH - inset * 2;
    const seed = lane * 13 + 1;
    const edge = (x: number, side: number): number => Math.sin(x * 0.11 + seed + side * 2) * 1.8 + Math.sin(x * 0.27 - g.t * 0.9 + side) * 1.1;

    c.save();
    c.beginPath();
    const step = 6;
    for (let x = 0; x <= w; x += step) c.lineTo(left + x, top + inset + edge(left + x, 0) - (1 - grow) * h * 0.4);
    for (let y = 0; y <= h; y += step) c.lineTo(left + w + edge(top + y, 3) * 0.6, top + inset + y);
    for (let x = w; x >= 0; x -= step) c.lineTo(left + x, top + inset + h + edge(left + x, 1) + (1 - grow) * h * 0.4);
    for (let y = h; y >= 0; y -= step) c.lineTo(left + edge(top + y, 2) * 0.6, top + inset + y);
    c.closePath();
    c.clip();

    const body = c.createLinearGradient(0, top, 0, top + g.laneH);
    body.addColorStop(0, "rgba(72,146,181,0.84)");
    body.addColorStop(0.5, "rgba(38,104,142,0.90)");
    body.addColorStop(1, "rgba(72,146,181,0.84)");
    c.fillStyle = body;
    c.fillRect(left - 4, top, w + 8, g.laneH);

    // flowing streaks: sine lines whose phase runs with the traffic, so the water visibly moves
    const lines = Math.max(3, Math.round(g.laneH / 6));
    for (let i = 0; i < lines; i++) {
      const y = top + inset + ((i + 0.5) / lines) * h;
      const lambda = 24 + hash(seed + i) * 26;
      const amp = 1.1 + hash(seed + i + 9) * 1.7;
      const speed = 34 + hash(seed + i + 17) * 34;
      c.strokeStyle = `rgba(226,242,255,${0.16 + hash(seed + i + 3) * 0.2})`;
      c.lineWidth = 1;
      c.beginPath();
      for (let x = 0; x <= w + 4; x += 3) {
        const px = left + x;
        const py = y + Math.sin(((px - g.fwd * g.t * speed) / lambda) * Math.PI * 2) * amp;
        if (x === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.stroke();
    }
    // glints
    for (let i = 0; i < Math.max(4, Math.round(w / 34)); i++) {
      const gx = left + wrap(hash(seed + i * 5) * w + g.fwd * g.t * (22 + hash(i) * 22), w);
      const gy = top + inset + hash(seed + i * 5 + 1) * h;
      const tw = 0.5 + 0.5 * Math.sin(g.t * 3 + i * 1.7);
      c.fillStyle = `rgba(255,255,255,${0.14 + tw * 0.4})`;
      c.beginPath();
      c.ellipse(gx, gy, 2.4 + tw * 1.8, 0.8, 0, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();

    // foam at the shoreline
    c.strokeStyle = "rgba(240,249,255,0.5)";
    c.lineWidth = 1.2;
    c.beginPath();
    for (let x = 0; x <= w; x += step) {
      const px = left + x;
      const py = top + inset + edge(px, 0) - (1 - grow) * h * 0.4;
      if (x === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.stroke();
  }

  drawCautionSign(g, g.xPx(m.stretch.fromM) - g.fwd * (g.laneH * 0.4 + 6), "≋");
  // depth gauge: a striped post at the downstream end
  const gx = g.xPx(m.stretch.toM) + g.fwd * 4;
  const gy = g.outerEdgeY + g.outward * 3;
  c.fillStyle = "#f8fafc";
  c.fillRect(gx - 1.5, Math.min(gy, gy + g.outward * g.laneH * 0.5), 3, g.laneH * 0.5);
  c.fillStyle = "#dc2626";
  for (let i = 0; i < 4; i += 2) c.fillRect(gx - 1.5, Math.min(gy, gy + g.outward * g.laneH * 0.5) + (i * g.laneH * 0.5) / 4, 3, (g.laneH * 0.5) / 4);
}

/* ── scenes by family ────────────────────────────────────────────────────────── */

/** Where a responder slides in from over the early part of a phase (px upstream of its parked spot). */
const arrival = (g: SceneGeometry, f: number, from: number, to: number, far: number): number => -g.fwd * (1 - ramp(f, from, to)) * far;

function drawBreakdown(g: SceneGeometry, m: SceneMark, onShoulder: boolean): void {
  const kind = m.vehicle ?? "car";
  const x = g.xPx(m.xM);
  const laneY = m.lane === null ? g.outerEdgeY + g.outward * g.carWid * 0.15 : g.laneCenterY(m.lane);
  const y = onShoulder ? g.outerEdgeY + g.outward * g.carWid * 0.2 : laneY;
  const blink = Math.floor(g.t * 2.2) % 2 === 0;
  const { len } = drawStalled(g, x, y, kind, onShoulder ? 0.05 : -0.03, blink);
  drawWarningTriangle(g, x - g.fwd * (len + g.carLen * 3.2), y, Math.max(4, g.carWid * 0.42));
  if (!onShoulder) drawTaper(g, x - g.fwd * (len + g.carLen * 2.4), y, g.outward, 3, g.carLen * 1.6);
  if (m.phaseId === "service") {
    const back = x - g.fwd * (len + g.carLen * 1.25) + arrival(g, m.phaseFraction, 0, 0.1, g.carLen * 6);
    drawTow(g, back, y, kind === "truck");
  }
}

function drawCollision(g: SceneGeometry, m: SceneMark): void {
  const x = g.xPx(m.xM);
  const laneY = m.lane === null ? g.roadTop + g.roadH / 2 : g.laneCenterY(m.lane);
  const blocked = m.phaseId === "blocked";
  const tow = m.phaseId === "tow";
  const clearing = m.phaseId === "clearing";
  const multi = m.family === "multi_vehicle_collision";
  const wreckHere = blocked || tow;
  const blink = Math.floor(g.t * 2.2) % 2 === 0;

  if (wreckHere) {
    const styles: readonly CarStyle[] = [
      { body: "#dc2626", roof: "#ef4444", glass: GLASS },
      { body: "#2563eb", roof: "#3b82f6", glass: GLASS },
      { body: "#ca8a04", roof: "#eab308", glass: GLASS },
      { body: "#475569", roof: "#64748b", glass: GLASS },
    ];
    const count = m.family === "minor_collision" ? 2 : m.family === "self_accident" ? 1 : 4;
    const cars: readonly { readonly dx: number; readonly dy: number; readonly a: number }[] = [
      { dx: 0, dy: 0, a: 0.06 },
      { dx: -0.95, dy: 0.12, a: -0.22 },
      { dx: -0.4, dy: -0.62, a: 0.62 },
      { dx: -1.55, dy: -0.35, a: -0.5 },
    ];
    const selfSpin = m.family === "self_accident" ? 0.7 : 0;
    drawSkid(g, x - g.fwd * g.carLen * 0.4, laneY, g.carLen * 3.4, 0.12);
    for (let i = 0; i < count; i++) {
      const car = cars[i];
      const len = g.carLen;
      const cx = x + g.fwd * (car.dx * len - len / 2);
      inFrame(g, cx, laneY + car.dy * g.carWid * (m.family === "minor_collision" ? 0.9 : 1.3), car.a + selfSpin, () => {
        paintCar(g.ctx, len, g.carWid, styles[i % styles.length]);
        paintHazards(g.ctx, len, g.carWid, blink);
      });
    }
    drawDebris(g, x - g.fwd * g.carLen * 0.6, laneY, g.carLen * 1.9, g.carWid * 1.5, m.xM, multi ? 16 : 9);
    if (multi || m.family === "self_accident") drawSmoke(g, x - g.fwd * g.carLen * 0.3, laneY, g.carLen * 1.4, blocked ? 1 : 0.55);
  }

  const back = g.carLen * 2.6;
  if (blocked || tow || clearing) {
    const policeIn = ramp(m.phaseFraction, blocked ? 0.25 : 0, blocked ? 0.45 : 0.08);
    const policeOut = clearing ? ramp(m.phaseFraction, 0.55, 1) : 0;
    if (policeIn > 0 && policeOut < 1) {
      const px = x - g.fwd * (back + g.carLen) + arrival(g, blocked ? m.phaseFraction : 1, 0.25, 0.45, g.carLen * 8) + g.fwd * policeOut * g.carLen * 14;
      drawPolice(g, px, laneY + g.outward * g.laneH * 0.34, 0.1 * g.outward);
    }
  }
  if (blocked && m.family !== "minor_collision") {
    const ax = x - g.fwd * (back + g.carLen * 3.2) + arrival(g, m.phaseFraction, 0.1, 0.3, g.carLen * 9);
    drawAmbulance(g, ax, laneY - g.outward * g.laneH * 0.02);
  }
  if (tow) {
    const heavy = multi;
    drawTow(g, x - g.fwd * (g.carLen * 2.2) + arrival(g, m.phaseFraction, 0, 0.12, g.carLen * 9), laneY, heavy);
    if (multi) drawTow(g, x - g.fwd * (g.carLen * 4.9) + arrival(g, m.phaseFraction, 0.05, 0.2, g.carLen * 11), laneY + g.outward * g.laneH * 0.02, false);
  }
  // cones mark the scene from the moment it exists until it is cleared
  const coneY = laneY;
  drawTaper(g, x - g.fwd * (back + g.carLen * 1.2), coneY, g.outward, 4, g.carLen * 2.2);
  if (clearing) {
    for (let i = 0; i < 3; i++) drawCone(g, x + g.fwd * (i * g.carLen * 0.7 - g.carLen * 0.2), coneY - g.outward * g.laneH * 0.18, Math.max(2.2, g.laneH * 0.06));
  }
}

function drawOverturned(g: SceneGeometry, m: SceneMark): void {
  const x = g.xPx(m.xM);
  const laneY = m.lane === null ? g.roadTop + g.roadH / 2 : g.laneCenterY(m.lane);
  const blocked = m.phaseId === "blocked";
  const tow = m.phaseId === "tow";
  const clearing = m.phaseId === "clearing";
  const blink = Math.floor(g.t * 2.2) % 2 === 0;
  if (blocked || tow) {
    const len = g.carLen * 3;
    const wid = Math.min(g.laneH * 0.9, g.carWid * 1.25);
    drawSkid(g, x - g.fwd * g.carLen * 0.6, laneY, g.carLen * 4.4, 0.2);
    // the trailer, on its side across the lane, with its cargo spilled
    inFrame(g, x - g.fwd * len * 0.5, laneY, 1.32, () => {
      const c = g.ctx;
      c.fillStyle = "rgba(0,0,0,0.32)";
      rrect(c, -len / 2 + 2, -wid / 2 + 3, len, wid, 2.5);
      c.fill();
      c.fillStyle = "#94a3b8";
      rrect(c, -len / 2, -wid / 2, len, wid, 2.5);
      c.fill();
      c.fillStyle = "#64748b"; // underside: axles and wheels showing
      c.fillRect(-len * 0.42, -wid * 0.5, len * 0.84, wid * 0.16);
      c.fillStyle = "#0f172a";
      for (const wx of [-0.3, -0.12, 0.06]) {
        c.beginPath();
        c.arc(len * wx, -wid * 0.42, wid * 0.13, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = "#f59e0b";
      rrect(c, len * 0.32, -wid * 0.4, len * 0.16, wid * 0.8, 2);
      c.fill();
      paintHazards(c, len, wid, blink);
    });
    const spill = ["#dc2626", "#2563eb", "#eab308", "#16a34a", "#a855f7"];
    for (let i = 0; i < 9; i++) {
      const px = x - g.fwd * (g.carLen * 0.3 + hash(m.xM + i) * g.carLen * 3.2);
      const py = laneY + (hash(m.xM + i + 30) - 0.5) * g.laneH * 1.1;
      inFrame(g, px, py, hash(m.xM + i + 60) * Math.PI, () => {
        g.ctx.fillStyle = spill[i % spill.length];
        g.ctx.fillRect(-g.carWid * 0.32, -g.carWid * 0.22, g.carWid * 0.64, g.carWid * 0.44);
      });
    }
    drawDebris(g, x - g.fwd * g.carLen, laneY, g.carLen * 2.4, g.carWid * 1.6, m.xM + 5, 12);
    drawSmoke(g, x - g.fwd * g.carLen * 1.2, laneY, g.carLen * 1.5, blocked ? 0.8 : 0.3);
  }
  const back = g.carLen * 3.2;
  const policeIn = ramp(m.phaseFraction, blocked ? 0.2 : 0, blocked ? 0.4 : 0.08);
  if (policeIn > 0 && !(clearing && m.phaseFraction > 0.6)) {
    drawPolice(g, x - g.fwd * (back + g.carLen) + arrival(g, blocked ? m.phaseFraction : 1, 0.2, 0.4, g.carLen * 8), laneY + g.outward * g.laneH * 0.34, 0.1 * g.outward);
  }
  if (blocked) drawAmbulance(g, x - g.fwd * (back + g.carLen * 3.4) + arrival(g, m.phaseFraction, 0.1, 0.3, g.carLen * 9), laneY);
  if (tow) {
    drawTow(g, x - g.fwd * g.carLen * 2.6 + arrival(g, m.phaseFraction, 0, 0.15, g.carLen * 10), laneY, true);
  }
  drawTaper(g, x - g.fwd * (back + g.carLen * 1.4), laneY, g.outward, 4, g.carLen * 2.4);
  if (clearing) for (let i = 0; i < 3; i++) drawCone(g, x + g.fwd * (i * g.carLen * 0.8), laneY - g.outward * g.laneH * 0.18, Math.max(2.2, g.laneH * 0.06));
}

function drawRoadworks(g: SceneGeometry, m: SceneMark): void {
  if (m.stretch === null || m.closedLanes.length === 0) return;
  const a = g.xPx(m.stretch.fromM);
  const b = g.xPx(m.stretch.toM);
  const left = Math.min(a, b);
  const right = Math.max(a, b);
  const lane = m.closedLanes[0];
  const laneY = g.laneCenterY(lane);
  const top = laneY - g.laneH / 2;
  const c = g.ctx;
  // the work area: a hatched, dusty patch inside the closed lane
  c.save();
  c.beginPath();
  c.rect(left, top + g.laneH * 0.08, Math.max(right - left, 20), g.laneH * 0.84);
  c.clip();
  c.fillStyle = "rgba(120,90,50,0.34)";
  c.fillRect(left, top, right - left + 20, g.laneH);
  c.strokeStyle = "rgba(251,146,60,0.32)";
  c.lineWidth = 3;
  for (let x = left - g.laneH; x < right + 20; x += 11) {
    c.beginPath();
    c.moveTo(x, top + g.laneH);
    c.lineTo(x + g.laneH, top);
    c.stroke();
  }
  c.restore();

  const r = Math.max(2.3, Math.min(4.6, g.laneH * 0.07));
  const span = Math.max(right - left, 20);
  // taper upstream: cones run diagonally from the neighbouring lane's edge into the closed lane
  const taperStart = g.xPx(m.stretch.fromM) - g.fwd * Math.min(g.carLen * 3.2, span * 0.35);
  drawTaper(g, taperStart, laneY, g.outward, 5, Math.min(g.carLen * 3.2, span * 0.35));
  // barrels along the work area's edges
  const barrels = Math.max(2, Math.floor(span / (g.carLen * 1.3)));
  for (let i = 0; i <= barrels; i++) {
    const x = left + (span * i) / barrels;
    drawBarrel(g, x, top + g.laneH * 0.1, r);
    drawBarrel(g, x, top + g.laneH * 0.9, r);
  }
  // barrier across the downstream end
  const endX = g.fwd === 1 ? right : left;
  c.fillStyle = "#f8fafc";
  c.fillRect(endX - 1.5, top + g.laneH * 0.08, 3, g.laneH * 0.84);
  c.fillStyle = "#f97316";
  for (let i = 0; i < 4; i += 2) c.fillRect(endX - 1.5, top + g.laneH * 0.08 + (i * g.laneH * 0.84) / 4, 3, (g.laneH * 0.84) / 4);
  // a work truck with an arrow board at the upstream end, and a couple of workers
  const truckX = g.xPx(m.stretch.fromM) + g.fwd * g.carLen * 1.4;
  inFrame(g, truckX, laneY, 0, () => {
    paintTruck(c, g.carLen * 2, Math.min(g.laneH * 0.7, g.carWid * 1.2), "#eab308", "#facc15");
    const on = Math.floor(g.t * 2) % 2 === 0;
    c.fillStyle = on ? "#fbbf24" : "#a16207";
    c.beginPath();
    c.arc(g.carLen * 0.55, 0, Math.max(2, g.carWid * 0.14), 0, Math.PI * 2);
    c.fill();
  });
  drawArrowBoard(g, truckX - g.fwd * g.carLen * 1.3, laneY, g.carLen * 1.4, Math.max(8, g.laneH * 0.4), g.outward);
  for (let i = 0; i < 3; i++) {
    const wx = left + span * (0.35 + i * 0.22);
    const wy = laneY + (hash(m.xM + i) - 0.5) * g.laneH * 0.4;
    c.fillStyle = "#f97316";
    c.beginPath();
    c.arc(wx, wy, Math.max(2, g.carWid * 0.17), 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#fef08a";
    c.beginPath();
    c.arc(wx, wy, Math.max(1, g.carWid * 0.08), 0, Math.PI * 2);
    c.fill();
  }
  drawCautionSign(g, taperStart - g.fwd * (g.carLen * 1.4), "!");
}

/**
 * Whether an event is drawn as a scene right now (so it does not also get the amber triangle marker).
 * An event that has not started, or that is running but holds nothing on the road (it yielded the
 * closure to the operator's own), gets no scene — a wreck the engine is not honouring would be a lie.
 */
export function hasSceneArt(m: SceneMark): boolean {
  if (m.state !== "active") return false;
  switch (m.family) {
    case "rain":
    case "breakdown_in_lane":
    case "breakdown_shoulder":
      return true;
    case "flood":
    case "scheduled_roadworks":
      return m.closedLanes.length > 0;
    case "minor_collision":
    case "multi_vehicle_collision":
    case "self_accident":
    case "overturned_vehicle":
      return m.closedLanes.length > 0 || m.phaseId === "clearing";
    default:
      return assertNeverFamily(m.family);
  }
}

/**
 * Draw every active scenario event on this carriageway as a scene. Called by drawCarriageway after the
 * traffic and before the labels. Events that have not started are left to the faint pending marker.
 */
export function drawScenes(g: SceneGeometry, marks: readonly SceneMark[]): void {
  for (const m of marks) {
    if (!hasSceneArt(m)) continue;
    switch (m.family) {
      case "flood":
        break; // the water goes UNDER the traffic: drawWater, called earlier by drawCarriageway
      case "scheduled_roadworks":
        drawRoadworks(g, m);
        break;
      case "breakdown_in_lane":
        drawBreakdown(g, m, false);
        break;
      case "breakdown_shoulder":
        drawBreakdown(g, m, true);
        break;
      case "minor_collision":
      case "multi_vehicle_collision":
      case "self_accident":
        drawCollision(g, m);
        break;
      case "overturned_vehicle":
        drawOverturned(g, m);
        break;
      case "rain":
        break; // weather, painted over everything by drawWeather
      default:
        return assertNeverFamily(m.family);
    }
  }
}

/** Weather sits over the traffic and the scenes, under the labels. */
export function drawWeather(g: SceneGeometry, marks: readonly SceneMark[]): void {
  let strongest: RainIntensity | null = null;
  let cap: number | null = null;
  const order: readonly RainIntensity[] = ["light", "moderate", "heavy"];
  for (const m of marks) {
    if (!hasSceneArt(m) || m.family !== "rain" || m.intensity === null) continue;
    if (strongest === null || order.indexOf(m.intensity) > order.indexOf(strongest)) {
      strongest = m.intensity;
      cap = m.capKmh;
    }
  }
  if (strongest !== null) {
    drawRain(g, strongest);
    if (cap !== null) drawSpeedSign(g, cap);
  }
}

/**
 * A speed-limit roundel at the upstream end of the road: what tells the operator rain has capped traffic,
 * now that the engine's orange speed-zone wash (which rain's whole-segment zone would paint across the entire
 * carriageway) is left off for it.
 */
function drawSpeedSign(g: SceneGeometry, kmh: number): void {
  const c = g.ctx;
  const r = Math.max(7, Math.min(13, g.laneH * 0.32));
  // On the first lane line at the upstream end: clear of the canvas's own caption (top-left) and header (top-right).
  const x = g.xPx(0) + g.fwd * (r + 14);
  const y = g.roadTop + g.laneH;
  c.fillStyle = "rgba(0,0,0,0.35)";
  c.beginPath();
  c.arc(x + 1, y + 1.5, r, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#f8fafc";
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
  c.lineWidth = Math.max(2, r * 0.24);
  c.strokeStyle = "#dc2626";
  c.beginPath();
  c.arc(x, y, r - c.lineWidth / 2, 0, Math.PI * 2);
  c.stroke();
  c.fillStyle = "#0f172a";
  c.font = `800 ${Math.round(r * 0.95)}px system-ui`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(String(kmh), x, y + 0.5);
  c.textAlign = "left";
  c.textBaseline = "top";
}

/** Flood water goes UNDER the traffic (a car that has not yet been stopped drives through it). */
export function drawWater(g: SceneGeometry, marks: readonly SceneMark[]): void {
  for (const m of marks) if (m.family === "flood" && hasSceneArt(m)) drawFlood(g, m);
}

function assertNeverFamily(family: never): never {
  throw new Error(`Unhandled scenario family: ${JSON.stringify(family)}`);
}

/* ── zipper lane / counterflow ─────────────────────────────────────────────── */

/**
 * The movable barrier in the median when lanes have been moved between the carriageways: a chain of
 * yellow-and-black segments instead of the fixed white stripe, with the barrier transfer vehicle
 * (yellow, amber beacon) driving along it — the thing that actually moves a zipper lane.
 */
export function drawMovableBarrier(ctx: SceneCtx, cssW: number, y: number, h: number, t: number, fwd: 1 | -1): void {
  const seg = 14;
  for (let x = 0; x < cssW; x += seg) {
    ctx.fillStyle = Math.floor(x / seg) % 2 === 0 ? "#facc15" : "#1f2937";
    rrect(ctx, x, y, seg - 1, h, 1.2);
    ctx.fill();
  }
  const tx = wrap(t * 46 * fwd, cssW + 80) - 40;
  const x = fwd === 1 ? tx : cssW - tx;
  ctx.save();
  ctx.translate(x, y + h / 2);
  ctx.scale(fwd, 1);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  rrect(ctx, -17, -h * 0.9 + 2, 34, h * 1.8, 3);
  ctx.fill();
  ctx.fillStyle = "#eab308";
  rrect(ctx, -18, -h * 0.9, 34, h * 1.8, 3);
  ctx.fill();
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(-14, -h * 0.5, 16, h);
  ctx.fillStyle = "#e2e8f0";
  ctx.fillRect(7, -h * 0.55, 7, h * 1.1);
  const on = Math.floor(t * 3) % 2 === 0;
  ctx.fillStyle = on ? "#fde047" : "#854d0e";
  ctx.beginPath();
  ctx.arc(2, 0, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * The lanes a carriageway has BORROWED from the other, drawn as reversible lanes: an amber wash, solid
 * amber edge, and chevrons running the way this carriageway's traffic goes, with the scheme's name.
 */
export function drawBorrowedLanes(g: SceneGeometry, borrowed: number, label: string): void {
  if (borrowed <= 0) return;
  const c = g.ctx;
  for (let l = 0; l < borrowed; l++) {
    const top = g.laneCenterY(l) - g.laneH / 2;
    c.fillStyle = "rgba(250,204,21,0.11)";
    c.fillRect(0, top, g.cssW, g.laneH);
    const mid = top + g.laneH / 2;
    const size = Math.max(3, Math.min(7, g.laneH * 0.14));
    c.strokeStyle = "rgba(250,204,21,0.5)";
    c.lineWidth = 1.6;
    const spacing = 46;
    const shift = wrap(g.t * 34, spacing) * g.fwd;
    for (let x = -spacing; x < g.cssW + spacing; x += spacing) {
      const px = x + shift + (g.fwd === -1 ? spacing : 0);
      c.beginPath();
      c.moveTo(px - g.fwd * size, mid - size);
      c.lineTo(px, mid);
      c.lineTo(px - g.fwd * size, mid + size);
      c.stroke();
    }
  }
  // solid amber line on the lane edge away from the median, separating the borrowed lanes from the rest
  const edgeY = g.laneCenterY(borrowed - 1) + (g.laneCenterY(borrowed) - g.laneCenterY(borrowed - 1)) / 2;
  c.strokeStyle = "rgba(250,204,21,0.9)";
  c.lineWidth = 2;
  c.setLineDash([]);
  c.beginPath();
  c.moveTo(0, edgeY);
  c.lineTo(g.cssW, edgeY);
  c.stroke();
  if (g.laneH >= 16) {
    c.font = "800 9px system-ui";
    c.textAlign = "left";
    c.textBaseline = "middle";
    c.fillStyle = "rgba(253,224,71,0.95)";
    c.fillText(label, 30, g.laneCenterY(0));
    c.textAlign = "left";
    c.textBaseline = "top";
  }
}
