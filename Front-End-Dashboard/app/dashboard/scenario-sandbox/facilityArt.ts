import type { Vehicle, VehicleClass, ResponderKind } from "./simulation";
import type { Facility, FacilityEngine, FacilityStats, FPath } from "./facilities";
import { DRAW_W_FRAC, poseAt } from "./facilities";
import type { EventSite } from "./scenarios/adapter";
import { drawPerson, type SceneGeometry } from "./sceneArt";

/* ══════════════════════════════════════════════════════════════════════════════
   DRAWING THE PLACES

   A toll plaza used to be a cyan line across the road and a wedge off its edge.
   Now it is drawn as what it is: a ramp leaving the outer lane, a fan of booth
   lanes with a booth on an island beside each, a canopy over the booth line,
   the lanes coming together again, and the road away. A service area gets its
   forecourt, pump islands, canopy and shop. Everything is drawn from the same
   geometry the vehicles drive on (facilities.ts), so a car is never drawn off
   the asphalt it is on.

   Drawn in three layers so depth reads correctly: the ground (asphalt,
   markings, islands, pumps), then the vehicles, then the canopies and labels
   over them — a car at a booth is UNDER the canopy, which is what makes the
   canopy read as a roof rather than a stripe.
══════════════════════════════════════════════════════════════════════════════ */

/* HOW BIG TO DRAW A VEHICLE — on the road and in the plazas alike.
 *
 * Sprites are drawn larger than life (k, often 4-8x) so a car is still a car
 * when half a kilometre is on screen, but where they are drawn is true scale,
 * so an enlarged sprite eats into the real gap behind it. Two rules came
 * before this one and each failed on screen:
 *
 *   - Capped at the full room behind it, a sprite filled the gap to the
 *     vehicle behind down to a 1.5 px seam, and the road read as vehicles
 *     drawn into each other although the engine kept them all apart.
 *   - Capped so it keeps 30% of whatever gap it has, a vehicle changed size
 *     every time the gap behind it did — at nearly every lane change, since
 *     a car changing lanes moves into a tighter gap than the one it left.
 *
 * So each class has ONE size, chosen for the gaps lane changes leave: three
 * lane changes in four start with more than SPRITE_GAP_REF_M behind the
 * changer and ahead of it (diagnostics/drawgaps.ts — 15.6 m and 20.8 m at
 * the quarter mark, 4,900 veh/h on four lanes), and a sprite that keeps 30%
 * of that gap visible fits them all without changing at all. Only a tighter
 * gap — a standing queue, an abrupt cut-in — squeezes a sprite, and then by
 * no more than it needs. */
export const SPRITE_GAP_EATEN = 0.7;
export const SPRITE_GAP_REF_M = 16;
const CAR_REF_M = 4.6;
/** Below this a car stops being a car; on long stretches the size floor wins and squeezing does the rest. */
const LEGIBLE_CAR_PX = 14;
/** A squeezed sprite keeps at least this length-to-width ratio, or it reads as a vehicle turned sideways. */
const MIN_SPRITE_ASPECT = 1.2;

/** How many metres of road a car's sprite stands for, at this zoom. */
function carSpriteM(mToPx: number, k: number): number {
  return Math.min(CAR_REF_M * k, Math.max(CAR_REF_M + SPRITE_GAP_EATEN * SPRITE_GAP_REF_M, LEGIBLE_CAR_PX / Math.max(1e-6, mToPx)));
}
/** The one factor every vehicle's width is drawn at — the car's — so a bus is never narrower than a car. */
export function spriteWidthScale(mToPx: number, k: number): number {
  return carSpriteM(mToPx, k) / CAR_REF_M;
}
/** A vehicle's steady drawn length (px): smaller ones in proportion to a car, longer ones a car plus their extra length. */
export function baseLengthPx(lengthM: number, mToPx: number, k: number): number {
  const carM = carSpriteM(mToPx, k);
  const m = lengthM <= CAR_REF_M ? lengthM * (carM / CAR_REF_M) : Math.min(lengthM * k, carM + (lengthM - CAR_REF_M));
  return m * mToPx;
}
/** Squeezed only where the real gap behind it is tighter than its size was chosen for, keeping 30% of that gap visible. */
export function drawnLengthPx(basePx: number, lengthM: number, roomM: number, mToPx: number): number {
  if (!isFinite(roomM)) return Math.max(2, basePx);
  const gapM = Math.max(0, roomM - lengthM);
  return Math.max(2, Math.min(basePx, (lengthM + gapM * SPRITE_GAP_EATEN) * mToPx - 1.5));
}
/** Full width unless squeezed so short it would read as sideways; never under 6 px. */
export function drawnWidthPx(baseWidthPx: number, lengthPx: number): number {
  return Math.min(baseWidthPx, Math.max(Math.min(6, baseWidthPx), lengthPx / MIN_SPRITE_ASPECT));
}

/** What a facility vehicle looks like for one frame — from the live engine or a recording. */
export type FacAgentView = {
  id: number;
  fid: string;
  /** Nose and rear, along the road (m) and across it (lane units). */
  u: number;
  w: number;
  tu: number;
  tw: number;
  v: number;
  accel: number;
  vClass: VehicleClass;
  length: number;
  role: Vehicle["role"];
  responderKind?: ResponderKind;
  serving: boolean;
  stuck: boolean;
  spawnTime: number;
  restAngle?: number;
};

export type FacilityView = {
  /** The geometry. Fixed for the life of a simulation, so a recording reuses the live one. */
  list: readonly Facility[];
  agents: readonly FacAgentView[];
  /** Which stations are shut, by facility id. */
  closed: ReadonlyMap<string, ReadonlySet<number>>;
  /** Which stations have someone being served right now. */
  busy: ReadonlyMap<string, ReadonlySet<number>>;
  stats: ReadonlyMap<string, FacilityStats> | null;
};

/** The live view of an engine, `alphaS` seconds on from its last step (drawing only). */
export function facilityView(engine: FacilityEngine, stats: FacilityStats[] | null, alphaS = 0): FacilityView {
  const agents: FacAgentView[] = [];
  const closed = new Map<string, Set<number>>();
  const busy = new Map<string, Set<number>>();
  for (const f of engine.list) {
    const c = new Set<number>();
    for (const st of f.stations) if (st.closedBy.length > 0) c.add(st.index);
    closed.set(f.spec.id, c);
    const b = new Set<number>();
    for (const a of f.agents) {
      const fa = a.fac;
      if (!fa) continue;
      const p = f.paths[fa.path];
      if (fa.serving && p.station >= 0) b.add(p.station);
      // Carried forward along its own lane by the time since the last step, so
      // it moves every frame instead of every third one.
      const moving = !fa.serving && !fa.stuck && alphaS > 0;
      const ds = moving ? Math.max(0, a.v + 0.5 * a.accel * alphaS) * alphaS : 0;
      let u = fa.u;
      let w = fa.w;
      let tu = fa.tu;
      let tw = fa.tw;
      if (ds > 0 && fa.s + ds <= p.len) {
        const n = poseAt(p, fa.s + ds);
        const lateral = fa.wShift < 1 ? fa.w - poseAt(p, fa.s).w : 0;
        tu += n.u - u;
        tw += n.w + lateral - w;
        u = n.u;
        w = n.w + lateral;
      }
      agents.push({
        id: a.id, fid: f.spec.id, u, w, tu, tw, v: a.v, accel: a.accel, vClass: a.vClass, length: a.length,
        role: a.role, responderKind: a.responderKind, serving: fa.serving, stuck: fa.stuck,
        spawnTime: a.spawnTime, restAngle: a.restAngle,
      });
    }
    busy.set(f.spec.id, b);
  }
  return {
    list: engine.list,
    agents,
    closed,
    busy,
    stats: stats ? new Map(stats.map((s) => [s.id, s])) : null,
  };
}

export type FacGeom = {
  ctx: CanvasRenderingContext2D;
  /** Along the road (m) to screen x — mirrored southbound. */
  xPx: (u: number) => number;
  /** Across the road (lane units outward from the outer lane's centre) to screen y. */
  yOf: (w: number) => number;
  laneH: number;
  /** Pixels per lane unit PAST the road edge — the gutter's own scale (see gutterLanePx). */
  gutterPx: number;
  mToPx: number;
  fwd: 1 | -1;
  /** +1 when outward is down the screen, -1 when up. */
  out: 1 | -1;
  asphalt: string;
  dayFraction: number;
  t: number;
  cssW: number;
  cssH: number;
  /** Screen y of the carriageway edge on the facility side, and of the far edge of the gutter. */
  roadEdgeY: number;
  gutterEdgeY: number;
  /** Inner edge of the carriageway (the median side), so a barrier plaza can cover the road. */
  roadInnerY: number;
};

const BRAND: Record<string, { body: string; band: string; text: string }> = {
  Petron: { body: "#1d4ed8", band: "#dc2626", text: "#ffffff" },
  Shell: { body: "#facc15", band: "#dc2626", text: "#7f1d1d" },
  Caltex: { body: "#dc2626", band: "#1e3a8a", text: "#ffffff" },
  Total: { body: "#dc2626", band: "#2563eb", text: "#ffffff" },
  Phoenix: { body: "#ea580c", band: "#facc15", text: "#ffffff" },
};

const brandOf = (f: Facility) => {
  const m = /^(Petron|Shell|Caltex|Total|Phoenix)/i.exec(f.spec.basis ?? "");
  const key = m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : "";
  return BRAND[key] ?? { body: "#0f766e", band: "#f59e0b", text: "#ffffff" };
};

/** Pixels per lane unit at a lateral position: the road's scale on it, the gutter's past its edge. */
const scaleAt = (g: FacGeom, w: number) => (w <= 0.5 ? g.laneH : g.gutterPx);

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const x0 = Math.min(x, x + w);
  const y0 = Math.min(y, y + h);
  const ww = Math.abs(w);
  const hh = Math.abs(h);
  const rad = Math.max(0, Math.min(r, ww / 2, hh / 2));
  ctx.beginPath();
  ctx.moveTo(x0 + rad, y0);
  ctx.arcTo(x0 + ww, y0, x0 + ww, y0 + hh, rad);
  ctx.arcTo(x0 + ww, y0 + hh, x0, y0 + hh, rad);
  ctx.arcTo(x0, y0 + hh, x0, y0, rad);
  ctx.arcTo(x0, y0, x0 + ww, y0, rad);
  ctx.closePath();
}

function tracePath(g: FacGeom, p: FPath) {
  const c = g.ctx;
  c.beginPath();
  p.pts.forEach((q, i) => {
    const x = g.xPx(q.u);
    const y = g.yOf(q.w);
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  });
}

/** Clip to the carriageway and its gutter, so a road leaving the canvas fades at the gutter's far edge. */
function clipToFacilitySide(g: FacGeom) {
  const top = Math.min(g.roadInnerY, g.gutterEdgeY);
  const bottom = Math.max(g.roadInnerY, g.gutterEdgeY);
  g.ctx.beginPath();
  g.ctx.rect(0, top, g.cssW, bottom - top);
  g.ctx.clip();
}

/* ── ground ────────────────────────────────────────────────────────────────── */

export function drawFacilityGround(g: FacGeom, view: FacilityView): void {
  const c = g.ctx;
  c.save();
  clipToFacilitySide(g);
  for (const f of view.list) {
    const barrier = !!f.laneEntries;
    // Booth lanes live in the gutter (or, at a barrier, mostly on the road): size by where they are.
    const pitchPx = f.pitch * scaleAt(g, f.stations.length ? f.stations[Math.floor(f.stations.length / 2)].w : 1);

    // The plaza apron where a barrier bulges past the road edge.
    if (barrier && f.wMax > 0.5) {
      const p0 = f.u0;
      const p1 = f.u1;
      const bulgeIn = p0 + (p1 - p0) * 0.28;
      const bulgeOut = p1 - (p1 - p0) * 0.28;
      c.fillStyle = g.asphalt;
      c.beginPath();
      c.moveTo(g.xPx(p0), g.yOf(0.5));
      c.lineTo(g.xPx(bulgeIn), g.yOf(f.wMax));
      c.lineTo(g.xPx(bulgeOut), g.yOf(f.wMax));
      c.lineTo(g.xPx(p1), g.yOf(0.5));
      c.closePath();
      c.fill();
    }

    // Asphalt: every lane stroked at its own width, so curves and fans join up
    // into one surface without any of them being drawn twice in a different tone.
    c.strokeStyle = g.asphalt;
    c.lineCap = "round";
    c.lineJoin = "round";
    for (const p of f.paths) {
      const mid = p.pts[Math.floor(p.pts.length / 2)].w;
      c.lineWidth = Math.max(3, f.pitch * scaleAt(g, mid) * (barrier ? 1.12 : 1.04));
      tracePath(g, p);
      c.stroke();
    }

    /* An acceleration lane runs alongside the outer lane behind a broken line
     * — the line drivers may cross — and ends in a taper, not a wall. */
    for (const p of f.paths) {
      if (p.role !== "accel") continue;
      const a = p.pts[0].u;
      const b = p.pts[p.pts.length - 1].u;
      const taper = Math.min(45, (b - a) * 0.3);
      c.fillStyle = g.asphalt;
      /* Up against the outer lane, as an acceleration lane is. Every other
       * plaza lane keeps a verge between itself and the carriageway, and here
       * that verge drew the lane as a separate road running alongside with a
       * dark strip in between — nowhere, to the eye, to join. Paved, it is part
       * of the road, with only the broken line to cross. */
      const xa = g.xPx(a);
      const xb = g.xPx(b);
      const yEdge = g.yOf(0.5);
      const yLane = g.yOf(p.pts[0].w);
      c.fillRect(Math.min(xa, xb), Math.min(yEdge, yLane), Math.abs(xb - xa), Math.abs(yLane - yEdge));
      c.beginPath();
      c.moveTo(g.xPx(b - 2), g.yOf(0.5));
      c.lineTo(g.xPx(b - 2), g.yOf(p.pts[0].w + f.pitch / 2));
      c.lineTo(g.xPx(b + taper), g.yOf(0.5));
      c.closePath();
      c.fill();
      c.strokeStyle = `rgba(255,255,255,${(0.5 + 0.2 * g.dayFraction).toFixed(2)})`;
      c.lineWidth = 1.2;
      c.setLineDash([5, 7]);
      c.beginPath();
      c.moveTo(g.xPx(a), g.yOf(0.5));
      c.lineTo(g.xPx(b + taper), g.yOf(0.5));
      c.stroke();
      c.setLineDash([]);
    }

    // Edge lines along the outside of the ramps: what makes a strip of grey
    // read as a road with a kerb rather than a smear.
    if (!barrier) {
      c.strokeStyle = `rgba(255,255,255,${(0.42 + 0.2 * g.dayFraction).toFixed(2)})`;
      c.lineWidth = 1;
      for (const p of f.paths) {
        if (p.role === "booth" || p.role === "pump") continue;
        c.beginPath();
        p.pts.forEach((q, i) => {
          const x = g.xPx(q.u);
          const y = g.yOf(q.w + (f.pitch / 2) * 0.98);
          if (i === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        });
        c.stroke();
      }
    }

    // Gore: the painted wedge where a ramp leaves or joins the outer lane.
    for (const p of f.paths) {
      if (p.role !== "diverge") continue;
      const startU = p.pts[0].u;
      const span = Math.min(60, Math.abs(p.pts[p.pts.length - 1].u - p.pts[0].u) * 0.6);
      const dir = 1;
      c.fillStyle = "rgba(226,232,240,0.16)";
      c.beginPath();
      c.moveTo(g.xPx(startU + dir * span * 0.25), g.yOf(0.5));
      c.lineTo(g.xPx(startU + dir * span), g.yOf(0.5));
      c.lineTo(g.xPx(startU + dir * span), g.yOf(0.5 + (f.pitch * 0.5)));
      c.closePath();
      c.fill();
    }

    // Booth lanes: dashed dividers through the queuing area, and an island with
    // its booth at the stop line.
    const stations = f.stations;
    const closed = view.closed.get(f.spec.id);
    const busy = view.busy.get(f.spec.id);
    for (const st of stations) {
      const p = f.paths[st.path];
      const stopU = st.u;
      // Divider on the inner side of this lane, from the start of the lane to the island.
      c.strokeStyle = "rgba(255,255,255,0.38)";
      c.lineWidth = 1;
      c.setLineDash([6, 6]);
      c.beginPath();
      c.moveTo(g.xPx(p.pts[0].u), g.yOf(st.w - f.pitch / 2));
      c.lineTo(g.xPx(stopU - 3), g.yOf(st.w - f.pitch / 2));
      c.stroke();
      c.setLineDash([]);

      // The island: a kerbed strip between lanes, from just before the stop line
      // to the end of the booth lane.
      const islandLen = Math.max(12, p.pts[p.pts.length - 1].u - stopU + 4);
      const ix0 = g.xPx(stopU - 3);
      const ix1 = g.xPx(stopU - 3 + islandLen);
      const lanePx = f.pitch * scaleAt(g, st.w);
      const iw = Math.max(2.5, lanePx * 0.2);
      for (const side of [-1, 1]) {
        // An island on each side of the lane; the outer one is shared with the next lane.
        if (side === 1 && stations.some((o) => o.kind === st.kind && Math.abs(o.w - (st.w + f.pitch)) < 1e-6)) continue;
        const yc = g.yOf(st.w + (side * f.pitch) / 2);
        c.fillStyle = "#cbd5e1";
        rr(c, Math.min(ix0, ix1), yc - iw / 2, Math.abs(ix1 - ix0), iw, iw / 2);
        c.fill();
        c.fillStyle = "#f59e0b";
        c.fillRect(Math.min(ix0, ix1), yc - iw / 2, Math.max(1.5, Math.abs(ix1 - ix0) * 0.08), iw);
      }

      if (st.kind === "booth") {
        // The booth itself, on the island on the driver's side.
        const bx = g.xPx(stopU);
        const by = g.yOf(st.w - f.pitch / 2);
        const sz = Math.max(5, Math.min(lanePx * 0.42, 12));
        const shut = closed?.has(st.index) ?? false;
        const serving = busy?.has(st.index) ?? false;
        c.fillStyle = "#e2e8f0";
        rr(c, bx - sz / 2, by - sz / 2, sz, sz, 2);
        c.fill();
        c.strokeStyle = "rgba(15,23,42,0.7)";
        c.lineWidth = 0.8;
        c.stroke();
        // The lane signal over the booth: green open, amber transacting, red X shut.
        const ly = g.yOf(st.w);
        const lx = g.xPx(stopU + 2.5);
        const lr = Math.max(2, Math.min(lanePx * 0.14, 4));
        c.fillStyle = shut ? "#ef4444" : serving ? "#f59e0b" : "#22c55e";
        c.beginPath();
        c.arc(lx, ly, lr, 0, Math.PI * 2);
        c.fill();
        if (shut) {
          // Cones across the lane mouth as well, so a shut booth is obvious at a glance.
          c.strokeStyle = "#ffffff";
          c.lineWidth = Math.max(1, lr * 0.45);
          c.beginPath();
          c.moveTo(lx - lr * 0.6, ly - lr * 0.6);
          c.lineTo(lx + lr * 0.6, ly + lr * 0.6);
          c.moveTo(lx + lr * 0.6, ly - lr * 0.6);
          c.lineTo(lx - lr * 0.6, ly + lr * 0.6);
          c.stroke();
          const coneU = p.pts[0].u + 4;
          for (let k = 0; k < 3; k++) {
            const cy = g.yOf(st.w - f.pitch * 0.3 + k * f.pitch * 0.3);
            const cx = g.xPx(coneU);
            const cs = Math.max(2, Math.min(lanePx * 0.16, 4));
            c.fillStyle = "#f97316";
            c.beginPath();
            c.moveTo(cx, cy - cs);
            c.lineTo(cx + cs * 0.8, cy + cs * 0.7);
            c.lineTo(cx - cs * 0.8, cy + cs * 0.7);
            c.closePath();
            c.fill();
          }
        }
      } else {
        // A pump: a dispenser on the island beside the bay, hose side towards the car.
        const px = g.xPx(stopU - 1.5);
        const py = g.yOf(st.w - f.pitch / 2);
        const sz = Math.max(4, Math.min(lanePx * 0.34, 10));
        const shut = closed?.has(st.index) ?? false;
        const brand = brandOf(f);
        c.fillStyle = shut ? "#64748b" : brand.body;
        rr(c, px - sz / 2, py - sz * 0.55, sz, sz * 1.1, 1.5);
        c.fill();
        c.fillStyle = shut ? "#ef4444" : brand.band;
        c.fillRect(px - sz / 2, py - sz * 0.55, sz, Math.max(1, sz * 0.28));
      }
    }

    // Service area: the shop at the far corner of the forecourt.
    if (f.spec.kind === "service_area" && stations.length > 0) {
      const last = stations[stations.length - 1];
      const p = f.paths[last.path];
      const uShop0 = p.pts[p.pts.length - 1].u + 14;
      const uShop1 = uShop0 + 26;
      const w0 = last.w - f.pitch * 0.45;
      const w1 = last.w + f.pitch * 0.42;
      const x0 = g.xPx(uShop0);
      const x1 = g.xPx(uShop1);
      const y0 = g.yOf(w0);
      const y1 = g.yOf(w1);
      const brand = brandOf(f);
      c.fillStyle = "rgba(0,0,0,0.28)";
      rr(c, Math.min(x0, x1) + 2, Math.min(y0, y1) + 2, Math.abs(x1 - x0), Math.abs(y1 - y0), 3);
      c.fill();
      c.fillStyle = "#e7e5e4";
      rr(c, Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0), 3);
      c.fill();
      c.fillStyle = brand.body;
      c.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.max(2, Math.abs(y1 - y0) * 0.22));
      if (Math.abs(x1 - x0) > 34 && Math.abs(y1 - y0) > 12) {
        c.fillStyle = "#334155";
        c.font = "700 8px system-ui";
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText("SHOP", (x0 + x1) / 2, (y0 + y1) / 2 + Math.abs(y1 - y0) * 0.1);
      }
    }
  }
  c.restore();
}

/* ── vehicles ──────────────────────────────────────────────────────────────── */

/** Draws one vehicle sprite with its nose at the origin, pointing along +x. */
export type SpriteFn = (agent: FacAgentView, len: number, wid: number, braking: boolean) => void;

export type DrawnVehicle = { id: number; left: number; right: number; top: number; bottom: number; kmh: number; vClass: VehicleClass; born: number };

/**
 * Every facility vehicle, along its lane and turned to face where it is going.
 * `k` is the same enlargement the carriageway uses, so a car on a ramp is the
 * same size as a car on the road; it is capped by the room behind it, as on the
 * road, so a queue at a booth is drawn as separate cars and not a solid bar.
 */
/** `roadRoom`: for a plaza vehicle still on the carriageway, how far ahead of the road traffic behind it it is (m). */
export function drawFacilityVehicles(g: FacGeom, view: FacilityView, k: number, roadRoom: ReadonlyMap<number, number>, sprite: SpriteFn): DrawnVehicle[] {
  const c = g.ctx;
  const hits: DrawnVehicle[] = [];
  const widthM: Record<number, number> = { 1: 1.9, 2: 2.5, 3: 2.6 };
  const widScale = 1.7;
  const pitchOf = new Map(view.list.map((f) => [f.spec.id, f.pitch]));

  // Room behind each vehicle: distance to the nearest vehicle behind it that is
  // laterally in the same place, measured along the road.
  const room = new Map<number, number>();
  for (const a of view.agents) {
    const pitch = pitchOf.get(a.fid) ?? 0.5;
    let best = Infinity;
    for (const b of view.agents) {
      if (b === a || b.fid !== a.fid || b.u >= a.u) continue;
      if (Math.abs(b.w - a.tw) > pitch * DRAW_W_FRAC) continue;
      best = Math.min(best, a.u - b.u);
    }
    room.set(a.id, best);
  }

  c.save();
  clipToFacilitySide(g);
  for (const a of view.agents) {
    const pitch = pitchOf.get(a.fid) ?? 0.5;
    const nx = g.xPx(a.u);
    const ny = g.yOf(a.w);
    let tx = g.xPx(a.tu);
    let ty = g.yOf(a.tw);
    if (Math.hypot(nx - tx, ny - ty) < 0.5) {
      tx = nx - g.fwd;
      ty = ny;
    }
    const ang = Math.atan2(ny - ty, nx - tx);
    const len = drawnLengthPx(baseLengthPx(a.length, g.mToPx, k), a.length, Math.min(room.get(a.id) ?? Infinity, roadRoom.get(a.id) ?? Infinity), g.mToPx);
    const wid = drawnWidthPx(Math.max(2, Math.min(pitch * DRAW_W_FRAC * scaleAt(g, a.w), widthM[a.vClass] * g.mToPx * spriteWidthScale(g.mToPx, k) * widScale)), len);
    const braking = a.accel < -0.6 || a.v < 3;
    c.save();
    c.translate(nx, ny);
    c.rotate(ang);
    sprite(a, len, wid, braking);
    c.restore();
    /* Someone standing beside it: the driver of a vehicle that has stopped
       for good, a responder beside a parked truck. On the island side, away
       from the moving lanes, which is where a person at a plaza stands. */
    if (a.stuck && (a.role === "wreck" || a.role === "responder")) {
      const mid = { x: nx - Math.cos(ang) * len * 0.5, y: ny - Math.sin(ang) * len * 0.5 };
      const side = g.yOf(a.w - pitch * 0.5) - g.yOf(a.w);
      const pg = { ctx: c, laneH: Math.max(14, scaleAt(g, a.w) * 1.4), t: g.t } as unknown as SceneGeometry;
      drawPerson(pg, mid.x, mid.y + side * 0.95, a.role === "wreck" ? "civilian" : "responder", a.id);
    }
    const ex = Math.cos(ang) * len;
    const ey = Math.sin(ang) * len;
    hits.push({
      id: a.id,
      left: Math.min(nx, nx - ex) - wid / 2,
      right: Math.max(nx, nx - ex) + wid / 2,
      top: Math.min(ny, ny - ey) - wid / 2,
      bottom: Math.max(ny, ny - ey) + wid / 2,
      kmh: a.v * 3.6,
      vClass: a.vClass,
      born: a.spawnTime,
    });
  }
  c.restore();
  return hits;
}

/* ── roofs and labels ──────────────────────────────────────────────────────── */

const fmtWait = (s: number) => (s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

/** A scenario event at a plaza, as the overlay labels it. */
export type SiteMark = { site: EventSite; name: string; text: string; state: "pending" | "active"; secondsUntilStart: number | null };

export function drawFacilityOverlay(g: FacGeom, view: FacilityView, highlight: string | null, marks: readonly SiteMark[] = []): void {
  const c = g.ctx;
  c.save();
  clipToFacilitySide(g);
  for (const f of view.list) {
    if (f.stations.length === 0) continue;
    const pitch = f.pitch;
    const ws = f.stations.map((s) => s.w);
    const wLo = Math.min(...ws) - pitch * 0.62;
    const wHi = Math.max(...ws) + pitch * 0.62;
    const stopU = f.stations[0].u;
    if (f.spec.kind === "service_area") {
      // Forecourt canopy over the pumps, in the brand's colour.
      const brand = brandOf(f);
      const x0 = g.xPx(stopU - 14);
      const x1 = g.xPx(stopU + 8);
      const y0 = g.yOf(wLo);
      const y1 = g.yOf(wHi);
      c.fillStyle = "rgba(248,250,252,0.30)";
      rr(c, Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0), 3);
      c.fill();
      c.strokeStyle = brand.body;
      c.lineWidth = Math.max(2, g.gutterPx * 0.08);
      c.stroke();
      c.fillStyle = brand.band;
      c.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.max(2, g.gutterPx * 0.07));
    } else {
      // Toll canopy: a band across every booth lane at the booth line.
      const x0 = g.xPx(stopU - 4);
      const x1 = g.xPx(stopU + 7);
      const y0 = g.yOf(wLo);
      const y1 = g.yOf(wHi);
      c.fillStyle = "rgba(226,232,240,0.26)";
      rr(c, Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0), 2);
      c.fill();
      c.strokeStyle = "rgba(14,165,233,0.85)";
      c.lineWidth = Math.max(1.5, g.gutterPx * 0.05);
      c.stroke();
    }
    if (highlight === f.spec.id) {
      const pad = 0.35;
      const x0 = g.xPx(f.u0);
      const x1 = g.xPx(f.u1);
      const y0 = g.yOf(Math.min(f.wMin, 0.5) - (f.laneEntries ? pad : 0));
      const y1 = g.yOf(f.wMax + pad * 0.5);
      c.strokeStyle = "#facc15";
      c.lineWidth = 2;
      c.setLineDash([7, 5]);
      rr(c, Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0), 8);
      c.stroke();
      c.setLineDash([]);
    }
  }
  c.restore();

  // Scenario events at a booth, pump or ramp: what is happening there, over the place itself.
  for (const m of marks) {
    const f = view.list.find((x) => x.spec.id === m.site.facilityId);
    if (!f) continue;
    const st = m.site.kind === "approach" ? null : f.stations[m.site.stations[0] ?? 0] ?? null;
    const ramp = f.paths.find((p) => p.role === (f.spec.kind === "entry_ramp" ? "approach" : f.laneEntries ? "barrierIn" : "ramp"));
    const at = st ? { u: st.u, w: st.w } : ramp ? poseAt(ramp, ramp.len * 0.6) : { u: (f.u0 + f.u1) / 2, w: f.wMax };
    const x = g.xPx(at.u);
    const y = g.yOf(at.w);
    if (m.state === "pending" && m.secondsUntilStart != null && m.secondsUntilStart <= 12) {
      // The moment before: a ring tightening on the spot, so the eye is there when it happens.
      const k = 1 - m.secondsUntilStart / 12;
      const r = Math.max(8, g.gutterPx * (1.2 - 0.7 * k));
      c.strokeStyle = `rgba(251,146,60,${(0.35 + 0.5 * Math.abs(Math.sin(g.t * 5))).toFixed(2)})`;
      c.lineWidth = 2.5;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.stroke();
    }
    const text = `${m.name} · ${m.text}`;
    c.font = "700 10px system-ui";
    const tw = c.measureText(text).width + 12;
    const tx = Math.max(2, Math.min(g.cssW - tw - 2, x - tw / 2));
    const ty = g.out > 0 ? Math.min(g.cssH - 36, y + g.gutterPx * 0.45) : Math.max(1, y - g.gutterPx * 0.45 - 16);
    c.fillStyle = m.state === "active" ? "rgba(220,38,38,0.94)" : "rgba(234,88,12,0.92)";
    rr(c, tx, ty, tw, 15, 4);
    c.fill();
    c.fillStyle = "#ffffff";
    c.textAlign = "left";
    c.textBaseline = "top";
    c.fillText(text, tx + 6, ty + 2.5);
  }

  // Labels sit in the gutter's outer band, unclipped so they are never cut by the canvas edge.
  // Two plazas close together stack their labels rather than print one over the other.
  const taken: { x: number; y: number; w: number }[] = [];
  for (const f of view.list) {
    const st = view.stats?.get(f.spec.id) ?? null;
    const at = f.stations.length > 0 ? f.stations[0].u : (f.u0 + f.u1) / 2;
    const parts: string[] = [];
    if (f.spec.kind === "service_area") {
      parts.push(`Service area: ${f.spec.name}`);
      if (st) parts.push(`${st.inside} in · ${st.openStations}/${st.stations} pumps`);
    } else {
      const toll = f.stations.length > 0;
      parts.push(`${f.spec.name}${f.spec.km != null ? ` · Km ${f.spec.km.toFixed(2)}` : ""}`);
      if (toll && st) {
        parts.push(`${st.openStations}/${st.stations} booths`);
        parts.push(st.queued > 0 ? `${st.queued} queued` : "no queue");
        if (st.meanWaitS >= 5) parts.push(`wait ${fmtWait(st.meanWaitS)}`);
      }
    }
    const text = parts.join("  ·  ");
    c.font = "600 10.5px system-ui";
    const w = c.measureText(text).width + 12;
    const x = Math.max(2, Math.min(g.cssW - w - 2, g.xPx(at) - w / 2));
    let y = g.out > 0 ? Math.min(g.cssH - 17, g.gutterEdgeY - 17) : Math.max(1, g.gutterEdgeY + 1);
    while (taken.some((t) => Math.abs(t.y - y) < 17 && x < t.x + t.w + 4 && t.x < x + w + 4)) y += g.out > 0 ? -18 : 18;
    taken.push({ x, y, w });
    const congested = !!st && st.queued >= 6;
    const shut = !!st && st.openStations < st.stations;
    c.fillStyle = shut ? "rgba(254,202,202,0.95)" : congested ? "rgba(253,230,138,0.95)" : "rgba(125,211,252,0.92)";
    rr(c, x, y, w, 16, 4);
    c.fill();
    c.fillStyle = shut ? "#7f1d1d" : congested ? "#713f12" : "#04283a";
    c.textAlign = "left";
    c.textBaseline = "top";
    c.fillText(text, x + 6, y + 3);
  }
}

/** How far past the carriageway edge the facilities on a road reach, in lane units. 0 when there are none. */
export function facilityDepth(list: readonly Facility[] | undefined): number {
  if (!list || list.length === 0) return 0;
  let d = 0;
  for (const f of list) d = Math.max(d, f.wMax - 0.5);
  return d;
}

/* The gutter's own lateral scale.
 *
 * Drawn at the road's lane height, a booth lane on a tall canvas was 44 px
 * wide and a plaza's ramps swooped through hundreds of pixels to change lane:
 * the road is exaggerated sideways to make lanes legible, and that same
 * exaggeration made a 300 m plaza look like a roller coaster. Past the road
 * edge the scale is capped instead. A barrier plaza is the exception — its
 * booths stand ON the road, fed straight from its lanes, so it keeps the
 * road's scale or its booth lanes would not line up with the lanes feeding
 * them. */
export const GUTTER_LANE_PX_MAX = 46;
export function gutterLanePx(laneH: number, hasBarrier: boolean): number {
  return hasBarrier ? laneH : Math.min(laneH, GUTTER_LANE_PX_MAX);
}
export function hasBarrier(list: readonly Facility[] | undefined): boolean {
  return !!list && list.some((f) => !!f.laneEntries);
}

/** Pixels a facility label needs beyond the drawn facility. */
export const FACILITY_LABEL_PX = 20;
