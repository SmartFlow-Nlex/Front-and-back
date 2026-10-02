import type { Vehicle } from "./simulation";

/* ══════════════════════════════════════════════════════════════════════════════
   FACILITIES — toll plazas and service areas as PLACES, not lines

   An interchange used to be a point on the road. A vehicle leaving at
   Meycauayan was deleted the instant it reached the km-post in the outer lane,
   and one joining appeared there out of nothing. So the toll plaza, which is
   where NLEX actually queues, did not exist in the sandbox at all: nothing could
   congest it, and an operator who wanted to put a breakdown "at the toll gate"
   had nowhere to put it.

   A facility is a small road network hanging off the carriageway, built from
   single-file lanes ("paths"): a deceleration taper off the outer lane, a ramp,
   a fan of booth lanes with a booth on each, the lanes converging again, and a
   road away. Vehicles drive it under the SAME car-following model as the
   mainline (the host's IDM, not a copy of it), stop at a booth for as long as
   paying takes, pick the shortest queue, take turns where lanes converge, and
   merge back onto the expressway only into a gap that is actually there.

   Three couplings to the mainline, and they are the reason this exists:
     - a ramp that is full holds its exiting traffic in the outer lane, so a
       plaza queue SPILLS BACK onto the expressway instead of disappearing;
     - a vehicle on a taper still physically occupies the outer lane, so the
       traffic behind it in that lane sees it and slows ("shadows", below);
     - a vehicle merging from an on-ramp needs a gap the driver behind it can
       accept, which is what makes a junction a bottleneck.

   COORDINATES. `u` is metres along travel, the same axis as the engine's `x`.
   The cross-section is in LANE UNITS measured outward from the centre of the
   outer lane: 0 is that lane's centre, 0.5 the carriageway edge, and facility
   lane k sits at slotW(k). The canvas is anisotropic — distance along the road
   is true to scale, the cross-section is exaggerated — and lane units are what
   the renderer already draws the cross-section in, so a facility lines up with
   the road it hangs off by construction. A path's LENGTH is physical: a
   sideways move of one lane unit counts as LANE_M metres.
══════════════════════════════════════════════════════════════════════════════ */

export type FacilityKind = "exit_ramp" | "entry_ramp" | "service_area" | "barrier";

export type FacilitySpec = {
  id: string;
  kind: FacilityKind;
  /** What the operator calls it, e.g. "Meycauayan Toll Plaza (exit)". */
  name: string;
  /** Start of its footprint along travel, metres from the segment's entry end. */
  x: number;
  /** Booths at a plaza, pumps at a service area. 0 on an untolled ramp. */
  booths: number;
  /** Mean seconds a vehicle stands at a booth or pump. */
  serviceSec: number;
  /** entry_ramp: vehicles per hour arriving from the local road. */
  arrivalsVehPerHour?: number;
  /** exit_ramp / service_area: share of passing traffic that turns in, 0–1. */
  turnFraction?: number;
  /** What the booths do: take payment, or issue a ticket. Null when untolled. */
  tollMode?: "pay" | "ticket" | null;
  /** The km-post it represents, for labels. */
  km?: number;
  /** The km-post of the interchange it belongs to, from the exit list: where the
   *  road would otherwise draw that interchange as a plain ramp wedge. */
  interchangeKm?: number;
  /** Where the numbers came from, in words an operator can check. */
  basis?: string;
  /** How the incident logs name this place (sub_location), for finding where events happen. */
  recordNames?: string[];
};

/* ── Geometry, in metres and lane units ─────────────────────────────────────── */

/** Metres per lane unit of sideways movement. */
export const LANE_M = 3.5;
/** Spacing of facility lanes. Narrower than a carriageway lane: a booth lane is
 *  a single file at walking pace, and the gutter it lives in is borrowed space. */
export const FAC_LANE = 0.5;
/* Verge between the carriageway edge and the first facility lane — chosen so
 * that lane sits exactly ONE LANE outside the outer lane (slotW(0) = 1.0). An
 * acceleration lane is then, to the carriageway, simply the lane beyond the
 * outer one, and merging from it is an ordinary lane change: the renderer
 * already draws that slide, and the engine already knows how to judge it. */
export const VERGE = 0.25;
/** Lateral centre of facility lane k. */
export const slotW = (k: number) => 0.5 + VERGE + (k + 0.5) * FAC_LANE;

const TAPER_M = 75; // diverge / merge taper
const RAMP_M = 40; // ramp between the taper and the plaza
const FAN_M = 50; // ramp fanning out into booth lanes (long enough that a truck turning in does not cut across the next lane)
const QUEUE_M = 42; // booth-lane storage ahead of the booth: about six cars
const ISLAND_M = 12; // booth island, past the stop line
/* Booth lanes converging again, STAGGERED: one booth lane is the trunk, and
 * the others join it one at a time further along, each holding its own lane
 * until its turn. Every junction is then a two-way zip between vehicles that
 * have already got going, which is how a plaza's departure taper is laid out.
 * Bringing every lane into one point instead put everyone in single file at
 * walking pace a few metres past the islands, and a four-booth plaza could
 * only empty itself at about 1,000 veh/h — below what its own booths clear. */
const CONV_PER_JOIN_M = 30;
/** Length of the staggered converge for n booth lanes: one stretch per lane that joins. */
const convM = (n: number) => Math.max(25, CONV_PER_JOIN_M * (n - 1));
const OFF_M = 38; // the curve away from (or in from) the local road
/* Acceleration lane. The merge can happen anywhere along it, the way a driver
 * does it: get up to speed, find a gap, move across. The first version merged
 * at one fixed point at the end of a 60 m lane, so drivers arrived there at
 * 7 m/s, needed a 60 m gap behind them to get in at all, waited for one, and
 * backed the queue up into the booths — the merge, not the booths, was setting
 * the plaza's capacity. */
const ACC_M = 180;
/** Not before this far along it: clear of the lanes converging behind. */
const ACC_MIN_S = 15;
/* Where the end of the lane starts to matter. Seen from the start, IDM brakes
 * for a line 120 m out at 20 m/s, so every driver crawled the whole lane at
 * 9 m/s and then needed an 85 m gap to get in at that speed. A driver gets up
 * to speed first and only watches the end once it is near. */
const ACC_END_LOOK_M = 95;
/** Over this last stretch a driver accepts tighter and tighter gaps. */
const ACC_URGENT_M = 90;
const DECEL_M = 30; // service area: deceleration lane before the forecourt
const PUMP_IN_M = 45;
const PUMP_M = 36; // a pump lane, pump at PUMP_STOP_M
const PUMP_STOP_M = 24;
const PUMP_OUT_M = 45;
const BFAN_M = 100; // barrier plaza: lanes fanning into booths, and back — a real plaza flares over 100 m or more
const BQUEUE_M = 60;
const BISLAND_M = 14;
/** Narrowest booth lane a barrier plaza is built with, lane units. */
const BARRIER_PITCH = 0.44;

/** Most booths a ramp plaza is drawn with. The widest NLEX ramp plaza mapped in
 *  OpenStreetMap (San Fernando's exit) has seven lanes; eight leaves room. */
export const MAX_RAMP_BOOTHS = 8;
/** Most booths a barrier plaza is drawn with: Bocaue's southbound plaza is mapped with 24 lanes. */
export const MAX_BARRIER_BOOTHS = 24;

/* How long a barrier's lanes take to fan out into its booths, and back. A
 * plaza with four times as many booths as lanes flares over a long stretch; a
 * short fan drew every car crabbing sideways across the carriageway. */
const barrierFanM = (booths: number) => Math.max(BFAN_M, Math.min(260, BFAN_M + 7 * Math.max(0, booths - 6)));

/** Where the booth line stands, metres into a facility's footprint — what is placed at a plaza's real km. */
export function boothLineAtM(kind: FacilityKind, booths: number): number {
  switch (kind) {
    case "exit_ramp":
      return booths > 0 ? TAPER_M + RAMP_M + FAN_M + QUEUE_M : TAPER_M + RAMP_M;
    case "entry_ramp":
      return booths > 0 ? OFF_M + FAN_M + QUEUE_M : OFF_M;
    case "service_area":
      return TAPER_M + DECEL_M + PUMP_IN_M + PUMP_STOP_M;
    case "barrier":
      return barrierFanM(booths) + BQUEUE_M;
  }
}
/** Pumps at a service area: four lanes, one pump each. */
export const SERVICE_PUMPS = 4;

/* ── Rates ──────────────────────────────────────────────────────────────────── */

/** What one payment booth clears in an hour — the operator's figure, the same
 *  one the traffic optimiser staffs booths with (traffic-prescriptive.service.ts). */
export const PAY_BOOTH_VEH_PER_HOUR = 350;

/* Seconds a saturated booth loses between one vehicle leaving and the next
 * reaching the stop line: waiting for the one in front to clear, then rolling
 * up a vehicle length from standstill. Measured on this engine with the
 * corridor's default fleet (diagnostics/boothprobe.ts: 5.9 s behind a car's
 * worth of move-up, 8.2 s for a truck, 6.2 s overall), not assumed. It is what
 * turns "350 an hour" into a time at the booth — about 4 s, which is an RFID
 * read and the barrier lifting, NLEX having gone cashless — and getting it
 * wrong would make a plaza's capacity a side effect of the car-following model
 * instead of the operator's number. A heavier fleet moves up slower, so the
 * same plaza clears less in a freight hour, as a real one does. */
export const BOOTH_MOVE_UP_S = 6.2;

/** Mean seconds at the booth that make a saturated booth clear `vehPerHour`. */
export function boothDwellFor(vehPerHour: number): number {
  return Math.max(1.5, 3600 / Math.max(1, vehPerHour) - BOOTH_MOVE_UP_S);
}

/* Service areas. The warehouse has no record of who stops at a service area or
 * for how long, so these two are ASSUMPTIONS, stated wherever they are shown:
 * about 1 in 100 passing vehicles pulls in, and stays three and a half minutes
 * (refuel and pay). Four pumps at that dwell serve ~69 vehicles an hour, so the
 * forecourt runs busy but clear at ordinary flow and only queues when the
 * mainline does. */
export const SERVICE_STOP_SHARE = 0.01;
export const SERVICE_DWELL_S = 210;

/** How far into a service area's footprint its pumps stand — the point that sits at the station's km-post. */
export const SERVICE_PUMPS_AT_M = TAPER_M + DECEL_M + PUMP_IN_M + PUMP_STOP_M;

/** Along-travel length of a facility's footprint, for laying several out. */
export function footprintM(kind: FacilityKind, booths: number): number {
  switch (kind) {
    case "exit_ramp":
      return booths > 0
        ? TAPER_M + RAMP_M + FAN_M + QUEUE_M + ISLAND_M + convM(booths) + OFF_M
        : TAPER_M + RAMP_M * 2 + OFF_M;
    case "entry_ramp":
      return booths > 0
        ? OFF_M + FAN_M + QUEUE_M + ISLAND_M + convM(booths) + ACC_M
        : OFF_M + RAMP_M + ACC_M;
    case "service_area":
      return TAPER_M + DECEL_M + PUMP_IN_M + PUMP_M + PUMP_OUT_M + ACC_M;
    case "barrier":
      return barrierFanM(booths) * 2 + BQUEUE_M + BISLAND_M;
  }
}

/* ── Runtime types ──────────────────────────────────────────────────────────── */

export type Pt = { u: number; w: number };

export type PathRole =
  | "diverge" | "ramp" | "fan" | "booth" | "converge" | "leave"
  | "approach" | "accel"
  | "pumpIn" | "pump" | "pumpOut"
  | "barrierIn" | "barrierOut";

/** One single-file lane inside a facility. */
export type FPath = {
  id: number;
  role: PathRole;
  pts: Pt[];
  /** Cumulative physical length at each point, metres. */
  cum: number[];
  len: number;
  /** Paths a vehicle may continue onto. Empty when the path ends elsewhere. */
  next: number[];
  prev: number[];
  /** "paths": continue onto `next`; "leave": off onto the local road;
   *  "mainline": back onto the carriageway in `joinLane`. */
  end: "paths" | "leave" | "mainline";
  joinLane?: number;
  /** A booth or pump: where the front bumper stops to be served. */
  stop?: number;
  /** Which station the stop belongs to, and which station's queue this path
   *  feeds (a fan lane feeds the booth it leads to). -1 for neither. */
  station: number;
  group: number;
  vMax: number;
  /** How far before its end this lane is already close enough to the lane it
   *  joins to be in a vehicle's way there. 0 for a lane that does not move across. */
  conflictD: number;
  /** The longest conflictD of any lane running into the same junction: how
   *  early everyone heading there has to start taking turns. */
  zipLook: number;
  /** A barrier's out-fan lanes only: for each other lane fanning into the same
   *  mainline lane, how far before the end the two first come within a
   *  vehicle's width of each other. */
  crowdD?: Map<number, number>;
};

export type Station = {
  index: number;
  kind: "booth" | "pump";
  path: number;
  /** Where the stop line is. */
  u: number;
  w: number;
  /** Event ids holding it shut. Shut while any are. */
  closedBy: string[];
  served: number;
};

export type FacState = {
  fid: string;
  path: number;
  /** Metres along the current path, front bumper. */
  s: number;
  /** Successor chosen at a split, if any yet. */
  next: number | null;
  served: boolean;
  serving: boolean;
  serviceLeft: number;
  /** Seconds spent stopped at the end of an acceleration lane, unable to merge. */
  waited: number;
  enteredAt: number;
  /** When it first came to a stand in a queue, for the wait statistics. */
  queuedAt: number | null;
  /** Served at a booth or pump on this visit. */
  paid: boolean;
  /** Responders are not charged and do not stop to pay. */
  exempt: boolean;
  /** Broken down or crashed here; going nowhere until the scene is released. */
  stuck: boolean;
  /** Responders: the station they are heading for. */
  target: number | null;
  /** Sideways slide when squeezing out of a closed booth lane. */
  wFrom: number;
  wShift: number;
  /* Pose, for drawing and for the mainline to see it by. */
  u: number;
  w: number;
  du: number;
  dw: number;
  /** Where its rear bumper is. On a curve the body is not where the nose is. */
  tu: number;
  tw: number;
  /** The lane it came off, so the rear can be placed on it while it crosses. */
  prevPath: number | null;
  /** Mainline lane this vehicle still physically occupies, or -1. */
  shadowLane: number;
};

export type Facility = {
  spec: FacilitySpec;
  paths: FPath[];
  stations: Station[];
  /** Exit-type: where it leaves the outer lane, and the path it leaves onto. */
  divergeX: number | null;
  divergePath: number | null;
  /** Entry-type: the path arrivals from the local road start on. */
  spawnPath: number | null;
  /** Barrier: the fan-in paths open to each mainline lane. */
  laneEntries: number[][] | null;
  /** Along-travel extent of the footprint. */
  u0: number;
  u1: number;
  /** Lateral extent, lane units. The renderer sizes the gutter from wMax. */
  wMin: number;
  wMax: number;
  /** Spacing of its lanes, lane units. Sets how wide its vehicles are drawn,
   *  and how close two of them may pass side by side. */
  pitch: number;
  agents: Vehicle[];
  /** Arrivals from the local road waiting to get onto the approach. */
  pending: number;
  acc: number;
  /** Recent services: when, and how long that vehicle waited to be served. */
  log: { t: number; wait: number }[];
};

/** What the facility layer needs from the simulation it is attached to. */
export interface FacilityHost {
  readonly laneCount: number;
  readonly s0: number;
  readonly minClear: number;
  now(): number;
  rng(): number;
  /** The host's own IDM, desired speed capped at v0. gap null = clear road.
   *  `T` overrides the driver's time headway — see STOP_LINE_T. */
  idm(v: Vehicle, gap: number | null, leadV: number, v0: number, T?: number): number;
  /** Mainline vehicles in `lane` nearest ahead of (nose >= x) and behind x. Live, not the step-old index. */
  neighbours(lane: number, x: number): { ahead: Vehicle | null; behind: Vehicle | null };
  /** May `v`, alongside `lane` with its nose at x, move across into it now?
   *  `urgency` 0 is an ordinary lane change; 1 is out of lane and nosing in. */
  joinSafe(v: Vehicle, lane: number, x: number, urgency: number): boolean;
  /** A fresh arrival off the local road, drawn from the simulation's own fleet mix. */
  newVehicle(u: number): Vehicle;
  /** Put `v` back on the carriageway with its nose at x. False if there is no
   *  room. `slide`: it is moving across from the lane just outside the outer
   *  one, so it arrives mid lane change rather than already in the lane. */
  admit(v: Vehicle, lane: number, x: number, from: Facility, slide?: boolean): boolean;
  /** `v` has driven away down the local road. */
  leave(v: Vehicle, from: Facility): void;
  /** Where the simulated stretch ends, along travel (m). A plaza may run past it. */
  readonly length: number;
  /** `v` has gone past the end of the stretch still inside `from`: on beyond what is simulated. */
  pastEnd(v: Vehicle, from: Facility): void;
  /** Emissions for metres driven (and seconds idled) inside a facility. */
  emit(v: Vehicle, dist: number, dt: number): void;
}

/* ── Path construction ──────────────────────────────────────────────────────── */

function sCurve(u0: number, w0: number, u1: number, w1: number, n = 12): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const e = t * t * (3 - 2 * t);
    pts.push({ u: u0 + (u1 - u0) * t, w: w0 + (w1 - w0) * e });
  }
  return pts;
}

function line(u0: number, w0: number, u1: number, w1: number): Pt[] {
  return [{ u: u0, w: w0 }, { u: u1, w: w1 }];
}

/** Straight in its own lane until `uTurn`, then an S-curve to w1 by u1. */
function holdThenCurve(u0: number, w0: number, uTurn: number, u1: number, w1: number): Pt[] {
  if (Math.abs(w1 - w0) < 1e-9) return line(u0, w0, u1, w1);
  return uTurn > u0 + 1e-6 ? [{ u: u0, w: w0 }, ...sCurve(uTurn, w0, u1, w1)] : sCurve(u0, w0, u1, w1);
}

/** Heading along the road, turning to head straight out (away from it). */
function arcOut(u0: number, w0: number, du: number, dw: number, n = 10): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const th = (i / n) * (Math.PI / 2);
    pts.push({ u: u0 + du * Math.sin(th), w: w0 + dw * (1 - Math.cos(th)) });
  }
  return pts;
}

/** Heading straight in (towards the road), turning to run along it. */
function arcIn(u0: number, w0: number, du: number, dw: number, n = 10): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const th = (i / n) * (Math.PI / 2);
    pts.push({ u: u0 + du * (1 - Math.cos(th)), w: w0 + dw * (1 - Math.sin(th)) });
  }
  return pts;
}

class Builder {
  paths: FPath[] = [];
  stations: Station[] = [];

  /* The staggered converge. `slots` are the booth lanes in the order they
   * join, the first being the trunk; returns, for each, the path a vehicle
   * leaving that booth drives onto. Everything ends on `exit`. */
  stagger(uConv: number, len: number, slots: number[], exit: FPath, vMax: number): FPath[] {
    const n = slots.length;
    const trunkW = slotW(slots[0]);
    if (n === 1) {
      const only = this.add("converge", line(uConv, trunkW, uConv + len, trunkW), vMax);
      this.link(only, exit);
      return [only];
    }
    const at = (j: number) => uConv + (len * j) / (n - 1); // junction j, j = 1..n-1
    const out: FPath[] = [];
    // The trunk, cut at each junction so each cut has two lanes running into it.
    let trunk = this.add("converge", line(uConv, trunkW, at(1), trunkW), vMax);
    out.push(trunk);
    for (let j = 1; j < n; j++) {
      const into = j < n - 1 ? this.add("converge", line(at(j), trunkW, at(j + 1), trunkW), vMax) : exit;
      const join = this.add("converge", holdThenCurve(uConv, slotW(slots[j]), at(j - 1), at(j), trunkW), vMax);
      this.link(trunk, into);
      this.link(join, into);
      out.push(join);
      if (into !== exit) trunk = into;
    }
    return out;
  }

  add(role: PathRole, pts: Pt[], vMax: number, end: FPath["end"] = "paths"): FPath {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i].u - pts[i - 1].u, (pts[i].w - pts[i - 1].w) * LANE_M));
    }
    const p: FPath = {
      id: this.paths.length, role, pts, cum, len: cum[cum.length - 1],
      next: [], prev: [], end, station: -1, group: -1, vMax, conflictD: 0, zipLook: 0,
    };
    this.paths.push(p);
    return p;
  }

  link(a: FPath, b: FPath) {
    a.next.push(b.id);
    b.prev.push(a.id);
  }

  station(kind: Station["kind"], p: FPath, stopAt: number, feeders: FPath[] = []) {
    const index = this.stations.length;
    const at = poseAt(p, stopAt);
    p.stop = stopAt;
    p.station = index;
    p.group = index;
    for (const f of feeders) f.group = index;
    this.stations.push({ index, kind, path: p.id, u: at.u, w: at.w, closedBy: [], served: 0 });
  }
}

/** Position and direction a path's front bumper is at, `s` metres along it. */
export function poseAt(p: FPath, s: number): { u: number; w: number; du: number; dw: number } {
  const ss = Math.max(0, Math.min(p.len, s));
  let lo = 0;
  let hi = p.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p.cum[mid] <= ss) lo = mid;
    else hi = mid;
  }
  const seg = p.cum[hi] - p.cum[lo] || 1e-9;
  const t = (ss - p.cum[lo]) / seg;
  const a = p.pts[lo];
  const b = p.pts[hi];
  return { u: a.u + (b.u - a.u) * t, w: a.w + (b.w - a.w) * t, du: (b.u - a.u) / seg, dw: (b.w - a.w) / seg };
}

function buildFacility(spec: FacilitySpec, laneCount: number): Facility {
  const B = new Builder();
  const x0 = spec.x;
  let divergeX: number | null = null;
  let divergePath: number | null = null;
  let spawnPath: number | null = null;
  let laneEntries: number[][] | null = null;
  let wMin = 0;
  let wMax = slotW(0) + FAC_LANE / 2;
  let pitch = FAC_LANE;

  if (spec.kind === "exit_ramp") {
    const n = Math.max(0, Math.min(MAX_RAMP_BOOTHS, Math.round(spec.booths)));
    let u = x0;
    const div = B.add("diverge", sCurve(u, 0, u + TAPER_M, slotW(0)), 22);
    divergeX = u;
    divergePath = div.id;
    u += TAPER_M;
    if (n === 0) {
      const ramp = B.add("ramp", line(u, slotW(0), u + RAMP_M * 2, slotW(0)), 18);
      u += RAMP_M * 2;
      const off = B.add("leave", arcOut(u, slotW(0), OFF_M, 3), 14, "leave");
      B.link(div, ramp);
      B.link(ramp, off);
    } else {
      const ramp = B.add("ramp", line(u, slotW(0), u + RAMP_M, slotW(0)), 15);
      B.link(div, ramp);
      u += RAMP_M;
      const wOut = slotW(n - 1);
      const uConv = u + FAN_M + QUEUE_M + ISLAND_M;
      const uLeave = uConv + convM(n);
      const off = B.add("leave", arcOut(uLeave, wOut, OFF_M, 3), 14, "leave");
      // Outermost lane first: it is the one the road away leaves from.
      const order = Array.from({ length: n }, (_, i) => n - 1 - i);
      const convs = B.stagger(uConv, convM(n), order, off, 11);
      for (let b = 0; b < n; b++) {
        const fan = B.add("fan", sCurve(u, slotW(0), u + FAN_M, slotW(b)), 10);
        const booth = B.add("booth", line(u + FAN_M, slotW(b), uConv, slotW(b)), 8);
        B.link(ramp, fan);
        B.link(fan, booth);
        B.link(booth, convs[order.indexOf(b)]);
        B.station("booth", booth, QUEUE_M, [fan]);
      }
      wMax = slotW(n - 1) + FAC_LANE / 2;
    }
  } else if (spec.kind === "entry_ramp") {
    const n = Math.max(0, Math.min(MAX_RAMP_BOOTHS, Math.round(spec.booths)));
    let u = x0;
    let feed: FPath;
    if (n === 0) {
      const approach = B.add("approach", arcIn(u, slotW(0), OFF_M, 3), 12);
      spawnPath = approach.id;
      u += OFF_M;
      const ramp = B.add("ramp", line(u, slotW(0), u + RAMP_M, slotW(0)), 18);
      B.link(approach, ramp);
      u += RAMP_M;
      feed = ramp;
    } else {
      const wIn = slotW(n - 1);
      const approach = B.add("approach", arcIn(u, wIn, OFF_M, 3), 12);
      spawnPath = approach.id;
      u += OFF_M;
      const uBooth = u + FAN_M;
      const uConv = uBooth + QUEUE_M + ISLAND_M;
      const uAcc = uConv + convM(n);
      const accel = B.add("accel", line(uAcc, slotW(0), uAcc + ACC_M, slotW(0)), 24);
      // Innermost lane first: it runs on into the acceleration lane.
      const order = Array.from({ length: n }, (_, i) => i);
      const convs = B.stagger(uConv, convM(n), order, accel, 12);
      for (let b = 0; b < n; b++) {
        const fan = B.add("fan", sCurve(u, wIn, uBooth, slotW(b)), 10);
        const booth = B.add("booth", line(uBooth, slotW(b), uConv, slotW(b)), 8);
        B.link(approach, fan);
        B.link(fan, booth);
        B.link(booth, convs[order.indexOf(b)]);
        B.station("booth", booth, QUEUE_M, [fan]);
      }
      accel.end = "mainline";
      accel.joinLane = laneCount - 1;
      wMax = slotW(n - 1) + FAC_LANE / 2;
      feed = accel;
    }
    if (n === 0) {
      const accel = B.add("accel", line(u, slotW(0), u + ACC_M, slotW(0)), 24, "mainline");
      accel.joinLane = laneCount - 1;
      B.link(feed, accel);
    }
  } else if (spec.kind === "service_area") {
    const k = Math.max(1, Math.min(SERVICE_PUMPS, Math.round(spec.booths) || SERVICE_PUMPS));
    let u = x0;
    const div = B.add("diverge", sCurve(u, 0, u + TAPER_M, slotW(0)), 22);
    divergeX = u;
    divergePath = div.id;
    u += TAPER_M;
    const decel = B.add("ramp", line(u, slotW(0), u + DECEL_M, slotW(0)), 12);
    B.link(div, decel);
    u += DECEL_M;
    const uPump = u + PUMP_IN_M;
    const uOut = uPump + PUMP_M;
    const uAcc = uOut + PUMP_OUT_M;
    const accel = B.add("accel", line(uAcc, slotW(0), uAcc + ACC_M, slotW(0)), 22);
    for (let p = 0; p < k; p++) {
      const pin = B.add("pumpIn", sCurve(u, slotW(0), uPump, slotW(p)), 6);
      const pump = B.add("pump", line(uPump, slotW(p), uOut, slotW(p)), 5);
      const pout = B.add("pumpOut", sCurve(uOut, slotW(p), uAcc, slotW(0)), 8);
      B.link(decel, pin);
      B.link(pin, pump);
      B.link(pump, pout);
      B.link(pout, accel);
      B.station("pump", pump, PUMP_STOP_M, [pin]);
    }
    accel.end = "mainline";
    accel.joinLane = laneCount - 1;
    wMax = slotW(k - 1) + FAC_LANE / 2;
  } else {
    /* Barrier plaza: the whole carriageway fans out into booths and back.
     *
     * Each booth belongs to one mainline lane and is fed only from it, so no
     * two fan lanes ever cross — a vehicle in L3 can reach the booths in front
     * of L3, as it can on the road. The plaza bulges a little
     * past the outer edge because a real barrier is wider than the road it
     * serves; it never reaches past the inner edge, which is the median. */
    const L = laneCount;
    const m = Math.max(L + 1, Math.min(MAX_BARRIER_BOOTHS, Math.round(spec.booths)));
    const wIn = -(L - 1) - 0.5 + 0.18;
    /* Wide enough that neighbouring booth lanes are drawn apart. Squeezed into
     * the road's own width, twelve booths across four lanes were 0.39 of a lane
     * each and vehicles in adjacent booths were drawn through one another. */
    // A wide plaza packs its booths a little closer so it does not take over the
    // canvas, but never so close that two vehicles side by side touch.
    const target = Math.max(0.3, Math.min(BARRIER_PITCH, (L + 4) / m));
    const wOut = Math.max(0.5 + VERGE + 0.7, wIn + m * target);
    pitch = (wOut - wIn) / m;
    const boothW = (b: number) => wIn + (b + 0.5) * pitch;
    /* Booths in equal blocks per lane, in order across the plaza. Assigning
     * each booth to the lane nearest it gave the outer lane every booth in
     * the bulge — six of twelve, all funnelling back into one lane — while the
     * other three lanes had two each and saturated them: twelve booths cleared
     * 3,100 veh/h. In blocks, nothing crosses and every lane gets its share. */
    const laneOf = (b: number) => Math.min(L - 1, Math.floor((b * L) / m));
    const laneW = (l: number) => l - (L - 1);
    const fanM = barrierFanM(m);
    const uB = x0 + fanM;
    const uI = uB + BQUEUE_M + BISLAND_M;
    const uE = uI + fanM;
    laneEntries = Array.from({ length: L }, () => [] as number[]);
    for (let b = 0; b < m; b++) {
      const l = laneOf(b);
      const fanIn = B.add("barrierIn", sCurve(x0, laneW(l), uB, boothW(b)), 13);
      const booth = B.add("booth", line(uB, boothW(b), uI, boothW(b)), 9);
      const fanOut = B.add("barrierOut", sCurve(uI, boothW(b), uE, laneW(l)), 18, "mainline");
      fanOut.joinLane = l;
      B.link(fanIn, booth);
      B.link(booth, fanOut);
      B.station("booth", booth, BQUEUE_M, [fanIn]);
      laneEntries[l].push(fanIn.id);
    }
    wMin = wIn - pitch / 2;
    wMax = wOut;
  }

  // Where each lane starts to crowd the one it runs into: walk back from its
  // end until it is a full lane-width clear of where it finishes.
  for (const p of B.paths) {
    const wEnd = p.pts[p.pts.length - 1].w;
    let d = 0;
    for (let i = p.pts.length - 1; i >= 0; i--) {
      if (Math.abs(p.pts[i].w - wEnd) >= CONFLICT_W) break;
      d = p.len - p.cum[i];
    }
    p.conflictD = d >= p.len - 1e-6 && Math.abs(p.pts[0].w - wEnd) < 1e-6 ? 0 : d;
  }
  /* A barrier's booth lanes fan back into each mainline lane side by side,
   * drawing together all the way. Two of them crowd each other not where they
   * meet but where they first come within a vehicle's width of each other — with
   * six booths to a lane, as at Bocaue, that is soon after the booths. Taking
   * turns has to start there: begun near the lane, a bus leaving an outer booth
   * caught up a truck from an inner one, drew level, and drove through it. */
  if (laneEntries) {
    const crowd = Math.min(0.42, 0.85 * pitch) * 1.1 + 0.02;
    const byLane = new Map<number, FPath[]>();
    for (const p of B.paths) if (p.role === "barrierOut" && p.joinLane != null) byLane.set(p.joinLane, [...(byLane.get(p.joinLane) ?? []), p]);
    for (const group of byLane.values()) {
      for (const p of group) {
        p.crowdD = new Map();
        for (const q of group) {
          if (q === p) continue;
          for (let d = Math.min(p.len, q.len); d > 0; d -= 2) {
            if (Math.abs(poseAt(p, p.len - d).w - poseAt(q, q.len - d).w) < crowd) { p.crowdD.set(q.id, d); break; }
          }
        }
      }
    }
  }
  // A straight trunk crowds nobody, but it is crowded by the lane joining it,
  // so it has to start taking turns as early as that lane does.
  const junctionOf = (p: FPath) =>
    p.end === "mainline" ? `lane:${p.joinLane}` : p.next.length === 1 && B.paths[p.next[0]].prev.length > 1 ? `path:${p.next[0]}` : null;
  const deepest = new Map<string, number>();
  for (const p of B.paths) {
    const k = junctionOf(p);
    if (k) deepest.set(k, Math.max(deepest.get(k) ?? 0, p.conflictD, ...(p.crowdD?.values() ?? [])));
  }
  for (const p of B.paths) {
    const k = junctionOf(p);
    p.zipLook = k ? (deepest.get(k) ?? 0) + ZIP_MARGIN_M : 0;
  }

  let u0 = Infinity;
  let u1 = -Infinity;
  for (const p of B.paths) for (const q of p.pts) { u0 = Math.min(u0, q.u); u1 = Math.max(u1, q.u); }
  return {
    spec, paths: B.paths, stations: B.stations, divergeX, divergePath, spawnPath, laneEntries,
    u0, u1, wMin, wMax, pitch, agents: [], pending: 0, acc: 0, log: [],
  };
}

/** How far past the carriageway edge a facility reaches, in lane units — for
 *  sizing the canvas before any simulation has been built from it. */
export function specDepth(spec: FacilitySpec, laneCount: number): number {
  return Math.max(0, buildFacility(spec, laneCount).wMax - 0.5);
}

/* ── The engine ─────────────────────────────────────────────────────────────── */

/** Within this distance of a junction, vehicles on converging lanes take turns. */
const MERGE_LOOK_M = 35;
/** A barrier's booths are packed tighter and fan back into lanes over a longer
 *  stretch, so the turn-taking there starts further out. */
const BARRIER_MERGE_LOOK_M = 60;
/* How hard a driver brakes to drop in behind someone converging on the same
 * junction while there is still road before it. Taking turns is negotiated
 * early and gently; treating the other car as a wall in the driver's own lane
 * made the second of two cars leaving neighbouring booths stop dead thirty
 * metres before the lanes even met. Close to the junction the limit goes,
 * because by then there is nothing gentle left to do. */
const ZIP_SOFT_DECEL = 2.5;
/** Sideways distance inside which a lane crowds the one it is joining. */
const CONFLICT_W = 0.45;
/** Start taking turns this far before the lanes start to crowd each other. */
const ZIP_MARGIN_M = 20;
const ZIP_HARD_M = 12;
/** How far before two out-fan lanes come within a vehicle's width of each other their drivers start taking turns. */
const PAIR_LOOK_M = 40;
/** How far a driver looks past the end of their own lane for the queue ahead. */
const LOOK_AHEAD_M = 140;
/** Arrivals held off the canvas before more count as demand that never came. */
const MAX_PENDING = 25;
/** A taper vehicle still occupies the outer lane until it is this far out. */
const SHADOW_W = 0.78;
/** Held at a yield line this long, a driver noses in on a tighter gap. */
const YIELD_PATIENCE_S = 6;
/** Stats window. */
const LOG_S = 600;

/* Headway used against a LINE rather than a vehicle.
 *
 * IDM keeps a time gap (T, about 1.4 s) to whatever it follows. That is right
 * behind a car, and wrong at a stop line: nobody holds 1.4 s of headway to a
 * booth. With the driver's own T the approach was so cautious that a car took
 * 6.6 s to roll up one place in the queue, and a booth meant to clear 350 an
 * hour cleared 256 — the car-following model, not the operator's figure, was
 * setting the plaza's capacity. Against a line the driver simply brakes to
 * stop on it, which is what a small T does. */
const STOP_LINE_T = 0.35;

/* Headway where booth lanes zip back into one.
 *
 * Leaving a plaza, drivers fall in behind whoever got to the junction first
 * at a few metres a second and sit closer than they would at speed — the
 * zipper is tight because everyone in it is slow. Holding the full motorway
 * headway there capped a four-booth plaza at about 1,050 veh/h, so its own
 * exit throttled it below the 1,400 its booths clear; at Harbor Link
 * (1,313 veh/h northbound at peak) that would have been a queue the record
 * does not show, made by the model. */
const ZIP_T = 0.9;
const ZIP_ROLES: ReadonlySet<PathRole> = new Set<PathRole>(["converge", "pumpOut", "barrierOut"]);

/** How wide a facility vehicle is drawn, as a share of its facility's lane pitch. */
export const DRAW_W_FRAC = 0.78;

/** Two vehicles closer than this sideways are in each other's way — a little
 *  more than they are drawn wide, so they are never drawn touching. */
export function lateralClear(f: Facility): number {
  return Math.min(0.42, 0.85 * f.pitch);
}

/** Where a facility vehicle's body is across the road at `u`, on the straight rear-to-front segment it is drawn as. */
function bodyW(fa: FacState, u: number): number {
  const span = fa.u - fa.tu;
  if (span < 1e-6) return fa.w;
  const t = Math.max(0, Math.min(1, (u - fa.tu) / span));
  return fa.tw + (fa.w - fa.tw) * t;
}

export type FacilityStats = {
  id: string;
  name: string;
  kind: FacilityKind;
  /** Vehicles inside the facility right now. */
  inside: number;
  /** Of them, standing still in a queue (not being served). */
  queued: number;
  /** Served over the last ten minutes, as an hourly rate. */
  servedPerHour: number;
  /** Mean wait to reach a booth or pump, last ten minutes, seconds. */
  meanWaitS: number;
  openStations: number;
  stations: number;
  /** Arrivals off the local road still waiting to get on. */
  pending: number;
};

export class FacilityEngine {
  readonly list: Facility[];
  private readonly byId = new Map<string, Facility>();

  constructor(specs: readonly FacilitySpec[], private readonly host: FacilityHost) {
    this.list = specs.map((s) => buildFacility(s, host.laneCount));
    for (const f of this.list) this.byId.set(f.spec.id, f);
  }

  get(id: string): Facility | null {
    return this.byId.get(id) ?? null;
  }

  /** The facility whose diverge starts at the gore `x`. */
  atGore(x: number): Facility | null {
    for (const f of this.list) if (f.divergeX != null && Math.abs(f.divergeX - x) < 0.5) return f;
    return null;
  }

  /** The barrier whose fan-in starts at or behind x and is still ahead of its end. */
  barrierAt(x: number): Facility | null {
    for (const f of this.list) if (f.laneEntries && x >= f.u0 && x < f.u1) return f;
    return null;
  }

  /** The barrier whose fan-in starts within `ahead` metres in front of x. */
  barrierAhead(x: number, ahead: number): Facility | null {
    for (const f of this.list) if (f.laneEntries && f.u0 > x && f.u0 - x <= ahead) return f;
    return null;
  }

  /** The mainline lane a barrier booth is fed from. */
  laneOfStation(f: Facility, station: number): number | null {
    if (!f.laneEntries) return null;
    for (let l = 0; l < f.laneEntries.length; l++) if (f.laneEntries[l].some((id) => f.paths[id].group === station)) return l;
    return null;
  }

  /** Put a vehicle on an entry plaza's approach road, if the start of it is clear. */
  enterFromLocalRoad(f: Facility, v: Vehicle): boolean {
    if (f.spawnPath == null) return false;
    const last = this.lastOn(f, f.spawnPath);
    if (last && last.fac!.s - last.length < this.host.s0 + 6) return false;
    v.v = Math.min(v.v0, 9);
    this.take(f, v, f.spawnPath, 0);
    return true;
  }

  /** Vehicles queued per booth at the booths in front of a mainline lane. */
  laneQueue(f: Facility, lane: number): number {
    const entries = f.laneEntries?.[lane];
    if (!entries || entries.length === 0) return Infinity;
    let n = 0;
    let open = 0;
    for (const id of entries) {
      const g = f.paths[id].group;
      if (g >= 0 && this.isClosed(f, g)) continue;
      open++;
      n += this.load(f, g, id);
    }
    return open > 0 ? n / open : Infinity;
  }

  /** Every vehicle inside any facility, for drawing. */
  allAgents(): Vehicle[] {
    const out: Vehicle[] = [];
    for (const f of this.list) for (const a of f.agents) out.push(a);
    return out;
  }

  /** Facility vehicles still physically across a mainline lane. */
  shadows(): Vehicle[] {
    const out: Vehicle[] = [];
    for (const f of this.list) for (const a of f.agents) if (a.fac && a.fac.shadowLane >= 0) out.push(a);
    return out;
  }

  /* ── Getting in ─────────────────────────────────────────────────────────── */

  private lastOn(f: Facility, pathId: number, except?: Vehicle): Vehicle | null {
    let best: Vehicle | null = null;
    for (const a of f.agents) {
      if (a === except || a.fac!.path !== pathId) continue;
      if (!best || a.fac!.s < best.fac!.s) best = a;
    }
    return best;
  }

  /** Is there room for a vehicle `len` long whose nose is `s` metres onto this path? */
  private roomAt(f: Facility, pathId: number, s: number, len: number, except?: Vehicle): boolean {
    for (const a of f.agents) {
      if (a === except || a.fac!.path !== pathId) continue;
      const lo = a.fac!.s - a.length;
      // Overlap test on [s - len, s] against [lo, a.s], with clearance both ways.
      if (s > lo - this.host.minClear && s - len < a.fac!.s + this.host.minClear) return false;
    }
    return true;
  }

  /** Can a vehicle leaving the outer lane at the gore get onto the ramp right now? */
  roomToDiverge(f: Facility, ahead: number, len: number): boolean {
    if (f.divergePath == null) return false;
    const last = this.lastOn(f, f.divergePath);
    return !last || last.fac!.s - last.length - this.host.minClear >= Math.max(0, ahead);
  }

  /** Barrier: which fan-in lane a vehicle in `lane` would take now, or null if they are all full to the entrance. */
  barrierEntry(f: Facility, lane: number, ahead: number, len: number, target: number | null = null): number | null {
    if (!f.laneEntries) return null;
    const all = f.laneEntries[lane] ?? [];
    // Sent to a scene: that booth lane, shut or not, if it is reachable from here.
    const aimed = target == null ? null : all.find((id) => f.paths[id].group === target) ?? null;
    if (aimed != null) {
      const last = this.lastOn(f, aimed);
      return !last || last.fac!.s - last.length - this.host.minClear >= Math.max(0, ahead) ? aimed : null;
    }
    const options = all;
    let best: { id: number; score: number } | null = null;
    for (const id of options) {
      const p = f.paths[id];
      if (p.group >= 0 && this.isClosed(f, p.group)) continue;
      const last = this.lastOn(f, id);
      if (last && last.fac!.s - last.length - this.host.minClear < Math.max(0, ahead)) continue;
      const score = this.load(f, p.group, id) + this.host.rng() * 0.3;
      if (!best || score < best.score) best = { id, score };
    }
    return best ? best.id : null;
  }

  /* Move a vehicle into the facility, `s` metres onto `pathId`.
   *
   * `from` is where it was being drawn across the road when it left, in lane
   * units, and how far through a lane change it was. A driver who reaches the
   * gore still finishing the move into the outer lane carries on sliding from
   * where they actually are, instead of snapping to the start of the taper. */
  take(f: Facility, v: Vehicle, pathId: number, s: number, from?: { w: number; shift: number }) {
    const p = f.paths[pathId];
    const pose = poseAt(p, s);
    const blend = from && from.shift < 1 ? from : null;
    v.fac = {
      fid: f.spec.id, path: pathId, s: Math.max(0, s), next: null,
      served: false, serving: false, serviceLeft: 0, waited: 0,
      enteredAt: this.host.now(), queuedAt: null, paid: false,
      exempt: v.role === "responder" || v.role === "wreck",
      stuck: false,
      target: v.facTarget && v.facTarget.fid === f.spec.id ? v.facTarget.station : null,
      wFrom: blend ? blend.w : pose.w,
      wShift: blend ? Math.max(0, blend.shift) : 1,
      u: pose.u, w: pose.w, du: pose.du, dw: pose.dw,
      tu: pose.u - v.length, tw: blend ? blend.w : pose.w, prevPath: null, shadowLane: -1,
    };
    v.laneShift = 1;
    v.laneFrom = v.lane;
    f.agents.push(v);
    this.chooseIfSplit(f, v);
    this.updatePose(f, v);
  }

  /* ── Station state ──────────────────────────────────────────────────────── */

  private isClosed(f: Facility, station: number): boolean {
    const st = f.stations[station];
    return !!st && st.closedBy.length > 0;
  }

  /** Shut a booth or pump on behalf of an event. Idempotent per event. */
  closeStation(fid: string, station: number, by: string) {
    const st = this.byId.get(fid)?.stations[station];
    if (st && !st.closedBy.includes(by)) st.closedBy.push(by);
  }

  /** Release an event's hold on a booth or pump. */
  openStation(fid: string, station: number, by: string) {
    const st = this.byId.get(fid)?.stations[station];
    if (st) st.closedBy = st.closedBy.filter((x) => x !== by);
  }

  /** Release every hold an event has, everywhere. */
  openAllFor(by: string) {
    for (const f of this.list) for (const st of f.stations) st.closedBy = st.closedBy.filter((x) => x !== by);
  }

  /* Strand vehicles at a station — the breakdown or crash AT the booth.
   *
   * Taken from whoever is there: the vehicle at the stop line, then the ones
   * queued behind it, in that order, so the scene is made of the traffic that
   * was in the plaza. Only if the lane is empty is one brought in — it is then
   * placed at the stop line itself, never on top of anyone. */
  strandAt(fid: string, station: number, want: number, sceneKey: string, synth: (u: number) => Vehicle, crashed = true): Vehicle[] {
    const f = this.byId.get(fid);
    const st = f?.stations[station];
    if (!f || !st) return [];
    const p = f.paths[st.path];
    const inLane = f.agents
      .filter((a) => a.fac!.path === p.id && !a.fac!.stuck && a.role === "traffic")
      .sort((a, b) => b.fac!.s - a.fac!.s)
      .slice(0, Math.max(1, want));
    const out: Vehicle[] = [];
    for (const a of inLane) {
      this.makeStuck(a, sceneKey, crashed);
      out.push(a);
    }
    if (out.length === 0 && this.roomAt(f, p.id, p.stop ?? p.len * 0.5, 4.6)) {
      const v = synth(st.u);
      this.take(f, v, p.id, p.stop ?? p.len * 0.5);
      this.makeStuck(v, sceneKey, crashed);
      out.push(v);
    }
    this.closeStation(fid, station, sceneKey);
    return out;
  }

  /* Strand vehicles on the approach — a crash on the ramp itself, before the
   * plaza. Single file, so this one stops the whole facility. */
  strandOnApproach(fid: string, want: number, sceneKey: string, synth: (u: number) => Vehicle, crashed = true): Vehicle[] {
    const f = this.byId.get(fid);
    if (!f) return [];
    const role: PathRole = f.spec.kind === "entry_ramp" ? "approach" : f.spec.kind === "barrier" ? "barrierIn" : "ramp";
    const candidates = f.paths.filter((p) => p.role === role);
    if (candidates.length === 0) return [];
    const ids = new Set(candidates.map((p) => p.id));
    const there = f.agents
      .filter((a) => ids.has(a.fac!.path) && !a.fac!.stuck && a.role === "traffic")
      .sort((a, b) => b.fac!.s - a.fac!.s)
      .slice(0, Math.max(1, want));
    for (const a of there) this.makeStuck(a, sceneKey, crashed);
    if (there.length === 0) {
      const p = candidates[Math.floor(candidates.length / 2)];
      const s = p.len * 0.6;
      if (this.roomAt(f, p.id, s, 4.6)) {
        const v = synth(poseAt(p, s).u);
        this.take(f, v, p.id, s);
        this.makeStuck(v, sceneKey, crashed);
        there.push(v);
      }
    }
    return there;
  }

  /* A collision leaves the vehicle at an angle; a breakdown leaves it
   * straight in its lane with the hazards on — the renderer tells the two
   * apart by whether it has a resting angle. */
  private makeStuck(a: Vehicle, sceneKey: string, crashed: boolean) {
    a.role = "wreck";
    a.v = 0;
    a.accel = 0;
    a.sceneKey = sceneKey;
    a.restAngle = crashed ? (Math.sin(a.id * 12.9898) * 0.5) : undefined;
    a.fac!.stuck = true;
    a.fac!.serving = false;
    a.fac!.exempt = true;
  }

  /** The scene is over: wrecks are recovered and everything drives on. */
  releaseScene(sceneKey: string) {
    for (const f of this.list) {
      for (const a of f.agents) {
        if (a.sceneKey !== sceneKey) continue;
        a.fac!.stuck = false;
        a.fac!.served = true;
        a.fac!.exempt = true;
        a.departing = true;
        // Recovered, not repaired: it leaves at a tow's pace.
        a.v0 = Math.min(a.v0, 10);
        a.aMax = Math.min(a.aMax, 0.9);
      }
    }
    this.openAllFor(sceneKey);
  }

  /** Point a responder already inside a facility at a station. */
  target(v: Vehicle, station: number) {
    if (v.fac) v.fac.target = station;
  }

  /* ── Choosing ───────────────────────────────────────────────────────────── */

  /** Vehicles committed to a station's queue: on its lanes, or heading for them. */
  private load(f: Facility, group: number, pathId: number): number {
    let n = 0;
    for (const a of f.agents) {
      const fa = a.fac!;
      if (group >= 0) {
        if (f.paths[fa.path].group === group) n++;
        else if (fa.next != null && f.paths[fa.next].group === group) n++;
      } else if (fa.path === pathId || fa.next === pathId) n++;
    }
    return n;
  }

  private chooseIfSplit(f: Facility, a: Vehicle) {
    const p = f.paths[a.fac!.path];
    if (p.next.length <= 1) {
      a.fac!.next = p.next[0] ?? null;
      return;
    }
    a.fac!.next = this.choose(f, a, p);
  }

  /* The shortest queue, as a driver sees it: fewest vehicles committed to each
   * booth, a small preference for the booths in front of them over the far
   * side of the plaza, and a coin toss between equals. A responder heading for
   * a scene takes the lane the scene is in, closed or not. */
  private choose(f: Facility, a: Vehicle, p: FPath): number | null {
    const fa = a.fac!;
    if (fa.target != null) {
      for (const id of p.next) if (f.paths[id].group === fa.target || f.paths[id].station === fa.target) return id;
    }
    let best: { id: number; score: number } | null = null;
    for (const id of p.next) {
      const q = f.paths[id];
      if (q.group >= 0 && this.isClosed(f, q.group)) continue;
      const entryW = q.pts[q.pts.length - 1].w;
      const score =
        this.load(f, q.group, id) +
        (0.35 * Math.abs(entryW - fa.w)) / FAC_LANE +
        this.host.rng() * 0.25;
      if (!best || score < best.score) best = { id, score };
    }
    return best ? best.id : null;
  }

  /* ── Stepping ───────────────────────────────────────────────────────────── */

  step(dt: number) {
    for (const f of this.list) this.stepFacility(f, dt);
  }

  private stepFacility(f: Facility, dt: number) {
    const host = this.host;
    const now = host.now();

    // Arrivals off the local road.
    if (f.spawnPath != null) {
      const rate = Math.max(0, f.spec.arrivalsVehPerHour ?? 0);
      f.acc += (rate / 3600) * dt;
      while (f.acc >= 1) {
        f.acc -= 1;
        if (f.pending < MAX_PENDING) f.pending++;
      }
      while (f.pending > 0) {
        const last = this.lastOn(f, f.spawnPath);
        if (last && last.fac!.s - last.length < host.s0 + 6) break;
        const v = host.newVehicle(f.paths[f.spawnPath].pts[0].u);
        v.v = Math.min(v.v0, 9);
        this.take(f, v, f.spawnPath, 0);
        f.pending--;
      }
    }
    if (f.agents.length === 0) return;

    // Who is on which path, front to back.
    const byPath: Vehicle[][] = f.paths.map(() => []);
    for (const a of f.agents) byPath[a.fac!.path].push(a);
    for (const row of byPath) row.sort((x, y) => y.fac!.s - x.fac!.s);

    // Squeeze out of a booth lane that has been shut.
    for (const a of f.agents) this.maybeDivert(f, a, byPath);

    // Accelerations, all from the same instant.
    for (const a of f.agents) {
      const fa = a.fac!;
      const p = f.paths[fa.path];
      if (fa.stuck || fa.serving) { a.accel = 0; continue; }
      if (p.next.length > 1 && fa.target == null) {
        const shut = fa.next != null && f.paths[fa.next].group >= 0 && this.isClosed(f, f.paths[fa.next].group);
        if (fa.next == null || shut) fa.next = this.choose(f, a, p) ?? (shut ? null : fa.next);
      }
      let gap = Infinity;
      let leadV = 0;
      let line = false;
      const consider = (g: number, lv: number, isLine = false) => {
        if (g < gap) { gap = g; leadV = lv; line = isLine; }
      };
      const row = byPath[p.id];
      const i = row.indexOf(a);
      const lead = i > 0 ? row[i - 1] : null;
      if (lead) consider(lead.fac!.s - lead.length - fa.s, lead.v);
      // A booth or pump not yet reached: stop with the front bumper on the line.
      if (p.stop != null && !fa.served && !fa.exempt && fa.s <= p.stop + 0.01) consider(p.stop + host.s0 - fa.s, 0, true);
      // The end of an acceleration lane: anyone still on it has to stop there.
      // (Not where that end lies past the end of the stretch: the driver merges somewhere beyond it.)
      if (p.role === "accel" && p.len - fa.s < ACC_END_LOOK_M && p.pts[p.pts.length - 1].u <= host.length) consider(p.len + host.s0 - fa.s, 0, true);
      // Nowhere open to go: wait at the end of this lane.
      if (p.end === "paths" && p.next.length > 1 && fa.next == null) consider(p.len + host.s0 - fa.s, 0, true);
      // The queue beyond the end of this lane.
      if (!lead) {
        const ahead = this.lookAhead(f, a, p);
        if (ahead) consider(ahead.gap, ahead.v);
      }
      // Lanes converging: take turns by distance to the junction.
      const sib = this.convergeLeader(f, a, p);
      /* Anyone in the way, whatever lane they are nominally in.
       *
       * Lanes that split apart start from the same point, and for the first
       * few metres two vehicles bound for different booths are still nose to
       * tail; lanes that converge do the reverse. Path order says nothing
       * about either, so the rule is the one a driver uses: whoever is in
       * front of me and not yet out of my way. Measured without it, vehicles
       * on neighbouring fan lanes were drawn through each other on three
       * ticks in four. */
      const clear = lateralClear(f);
      for (const b of f.agents) {
        if (b === a || b.fac!.path === fa.path) continue;
        const fb = b.fac!;
        if (fb.u < fa.u || (fb.u === fa.u && b.id > a.id)) continue;
        if (fb.tu - fa.u > LOOK_AHEAD_M) continue;
        /* Already alongside: the two bodies over the stretch of road both
         * cover. Each is drawn as a straight segment, rear to front, so how far
         * apart they are changes linearly along that stretch and is least at
         * one end of it — or nil, if they cross. Sampling the other body at a
         * few points missed exactly that end: in Bocaue's 24-booth plaza, six
         * booth lanes fan back into each lane, and a car came up beside a
         * truck's tail between two of the points and was drawn through it. */
        const lo = Math.max(fa.tu, fb.tu);
        const hi = Math.min(fa.u, fb.u);
        if (hi >= lo) {
          const gapLo = bodyW(fb, lo) - bodyW(fa, lo);
          const gapHi = bodyW(fb, hi) - bodyW(fa, hi);
          if (gapLo * gapHi <= 0 || Math.min(Math.abs(gapLo), Math.abs(gapHi)) < clear * 1.1) {
            consider(Math.min(0, fb.tu - fa.u), b.v);
            continue;
          }
        }
        /* Its body, rear to front, against where THIS driver's lane will have
         * taken them by the time they get there — not where they are now. Two
         * lanes converging are clear of each other until suddenly they are
         * not, and judged on the present a driver only noticed the car in
         * the next lane once they were already alongside it. */
        // Five points along the part still ahead of this driver, with a little
        // lateral margin: a truck's body lies diagonally across a merge curve.
        for (let k = 0; k <= 4; k++) {
          const t = k / 4;
          const bu = fb.tu + (fb.u - fb.tu) * t;
          if (bu <= fa.u) continue;
          const bw = fb.tw + (fb.w - fb.tw) * t;
          if (Math.abs(bw - this.wAhead(f, a, p, bu - fa.u)) >= clear * 1.1) continue;
          consider(bu - fa.u, b.v);
          break;
        }
      }
      /* Still half in the outer lane on a taper: the traffic ahead in that lane
       * is still ahead of it. Without this, a car leaving for the ramp drove
       * on into the back of a slower one that happened to be in front of it,
       * because the ramp it was leaving for was empty. */
      if (fa.shadowLane >= 0 && p.end !== "mainline") {
        const nb = host.neighbours(fa.shadowLane, fa.u);
        if (nb.ahead) consider(nb.ahead.x - nb.ahead.length - fa.u, nb.ahead.v);
      }
      /* Merging onto the carriageway: whoever is already in the lane ahead.
       * One that is still alongside — nose ahead, tail behind — only matters
       * once this vehicle is actually across the line; until then it is a car
       * going past, and braking for it would be braking for nothing. */
      if (p.end === "mainline" && p.joinLane != null) {
        const nb = host.neighbours(p.joinLane, fa.u);
        if (nb.ahead) {
          const g = nb.ahead.x - nb.ahead.length - fa.u;
          if (g >= 0 || fa.w < SHADOW_W) consider(g, nb.ahead.v);
        }
      }
      // Arriving at a scene: stop behind it, and stay.
      const v0 = Math.min(a.v0, p.vMax);
      const T = line ? STOP_LINE_T : ZIP_ROLES.has(p.role) ? Math.min(a.T, ZIP_T) : undefined;
      a.accel = host.idm(a, isFinite(gap) ? Math.max(0.1, gap) : null, leadV, v0, T);
      if (sib) {
        // Taking turns at the junction ahead: gently while there is room to, then firmly.
        let zip = host.idm(a, Math.max(0.1, sib.gap), sib.v, v0, Math.min(a.T, ZIP_T));
        if (!sib.hard) zip = Math.max(zip, -ZIP_SOFT_DECEL);
        a.accel = Math.min(a.accel, zip);
      }
    }

    // Move. A vehicle standing at a booth is still running its engine, and
    // that is most of what a plaza queue costs in CO2.
    for (const a of f.agents) {
      const fa = a.fac!;
      const p = f.paths[fa.path];
      if (fa.wShift < 1) fa.wShift = Math.min(1, fa.wShift + dt / 1.4);
      if (fa.stuck || fa.serving) {
        a.v = 0;
        if (!fa.stuck) host.emit(a, 0, dt);
        continue;
      }
      const acc = Math.max(-8, Math.min(a.aMax, a.accel));
      const vNew = Math.max(0, a.v + acc * dt);
      let s = fa.s + Math.max(0, ((a.v + vNew) / 2) * dt);
      a.v = vNew;
      if (p.stop != null && !fa.served && !fa.exempt && fa.s <= p.stop + 0.01) s = Math.min(s, p.stop);
      if (p.role === "accel") s = Math.min(s, p.len);
      host.emit(a, Math.max(0, s - fa.s), dt);
      fa.s = s;
    }

    // Nobody inside the vehicle ahead in the same lane.
    for (const row of byPath) {
      row.sort((x, y) => y.fac!.s - x.fac!.s);
      for (let i = 1; i < row.length; i++) {
        const lead = row[i - 1];
        const me = row[i];
        const maxS = lead.fac!.s - lead.length - host.minClear;
        if (me.fac!.s > maxS) {
          if (me.fac!.stuck) continue;
          me.fac!.s = Math.max(0, maxS);
          me.v = Math.min(me.v, lead.v);
        }
      }
    }

    // Booths and pumps; yield lines.
    for (const a of f.agents) {
      const fa = a.fac!;
      const p = f.paths[fa.path];
      if (fa.stuck) continue;
      /* A responder at its scene stays there until the scene is released: on
       * the booth line if the lane is otherwise empty (a works crew shutting a
       * booth), or wherever it came to a stand behind the wreck it is for. */
      if (a.role === "responder" && !a.departing && fa.target != null && p.station === fa.target) {
        const behindSomething = p.stop != null && a.v < 0.3 && fa.s > 2;
        if ((p.stop != null && fa.s >= p.stop - 1) || behindSomething) {
          a.v = 0;
          a.accel = 0;
          fa.stuck = true;
          continue;
        }
      }
      if (p.stop != null && !fa.served) {
        if (fa.exempt) {
          if (fa.s >= p.stop - 0.8) fa.served = true;
        } else if (fa.serving) {
          fa.serviceLeft -= dt;
          a.v = 0;
          if (fa.serviceLeft <= 0) {
            fa.serving = false;
            fa.served = true;
            fa.paid = true;
            f.stations[p.station].served++;
          }
        } else if ((fa.s >= p.stop - 0.25 || (fa.s >= p.stop - 0.8 && a.v < 0.8)) && !this.isClosed(f, p.station)) {
          // On the line is arrived, whatever the last few cm/s say: a car that
          // rolls up at walking pace stops and pays, it does not coast in place.
          fa.serving = true;
          fa.serviceLeft = this.serviceTime(f);
          a.v = 0;
          f.log.push({ t: now, wait: fa.queuedAt != null ? now - fa.queuedAt : 0 });
        }
      }
      // Waiting starts the first time it comes to a stand on the way in, wherever that is.
      if (a.v < 0.3 && !fa.serving && !fa.paid && fa.queuedAt == null && f.stations.length > 0) fa.queuedAt = now;
      if (p.role === "accel") {
        // Waiting at the end, unable to get in: patience runs down.
        if (fa.s >= p.len - 1 && a.v < 0.5) fa.waited += dt;
      }
    }

    /* Merging, from anywhere along an acceleration lane.
     *
     * Each step, every driver on one asks the question a driver asks: is there
     * room beside me, and would the car behind have to brake harder than it
     * should? If so they move across — handed to the carriageway mid lane
     * change, so the slide is drawn the way every other lane change is. Front
     * of the lane first, so the driver who has run out of road is not beaten
     * to a gap by the one behind them. */
    const merging = f.agents
      .filter((a) => f.paths[a.fac!.path].role === "accel" && !a.fac!.stuck)
      .sort((x, y) => y.fac!.s - x.fac!.s);
    for (const a of merging) {
      const fa = a.fac!;
      const p = f.paths[fa.path];
      if (fa.s < ACC_MIN_S) continue;
      const lane = p.joinLane ?? host.laneCount - 1;
      // Running out of lane: the gap a driver will take shrinks as the end
      // nears, and once stopped there a while they nose in.
      const urgency = fa.waited > YIELD_PATIENCE_S ? 1 : Math.max(0, Math.min(1, 1 - (p.len - fa.s) / ACC_URGENT_M));
      if (!host.joinSafe(a, lane, fa.u, urgency)) continue;
      if (host.admit(a, lane, fa.u, f, true)) {
        const k = f.agents.indexOf(a);
        if (k >= 0) f.agents.splice(k, 1);
      }
    }

    // Lane ends: onward, away, or back onto the carriageway.
    const ending = f.agents.filter((a) => a.fac!.s >= f.paths[a.fac!.path].len - 1e-9 && !a.fac!.stuck);
    ending.sort((x, y) => (y.fac!.s - f.paths[y.fac!.path].len) - (x.fac!.s - f.paths[x.fac!.path].len));
    // Out of the list the moment they leave it: a vehicle handed back to the
    // carriageway no longer has a facility state, and the next one's room
    // check walks this same list.
    const drop = (a: Vehicle) => {
      const k = f.agents.indexOf(a);
      if (k >= 0) f.agents.splice(k, 1);
    };
    for (const a of ending) {
      const fa = a.fac!;
      const p = f.paths[fa.path];
      const over = fa.s - p.len;
      if (p.end === "paths") {
        const nid = fa.next ?? (p.next.length === 1 ? p.next[0] : this.choose(f, a, p));
        if (nid == null) { fa.s = p.len; a.v = 0; continue; }
        const q = f.paths[nid];
        const last = this.lastOn(f, q.id, a);
        if (last && last.fac!.s - last.length - host.minClear < over) {
          fa.s = p.len;
          a.v = Math.min(a.v, last.v);
          continue;
        }
        fa.prevPath = fa.path;
        fa.path = q.id;
        fa.s = over;
        fa.next = null;
        fa.served = false;
        fa.serving = false;
        fa.waited = 0;
        fa.queuedAt = null;
        this.chooseIfSplit(f, a);
      } else if (p.end === "leave") {
        drop(a);
        host.leave(a, f);
      } else if (p.role === "accel") {
        // Out of acceleration lane: stand at the end until a gap comes.
        fa.s = p.len;
        a.v = 0;
      } else {
        const lane = p.joinLane ?? host.laneCount - 1;
        const x = p.pts[p.pts.length - 1].u + over;
        if (host.admit(a, lane, x, f)) drop(a);
        else { fa.s = p.len; a.v = 0; }
      }
    }

    for (const a of f.agents) this.updatePose(f, a);

    /* Past the far end of the stretch. Plazas are laid out where they are and
     * the window crops them, so an entry's acceleration lane, or the road away
     * from an exit's booths, can run on beyond what is simulated: a vehicle
     * whose tail has gone past the end has merged, or driven off, out there. */
    for (const a of [...f.agents]) {
      if (a.fac!.stuck || Math.min(a.fac!.u, a.fac!.tu) <= host.length) continue;
      drop(a);
      host.pastEnd(a, f);
    }

    /* A vehicle still across the outer lane must not end up inside the one
     * ahead of it there. The carriageway's overlap net only ever pushes the
     * car BEHIND, and a facility vehicle is never pushed by it, so this is the
     * one place that case can be fixed: back along its own lane, by the
     * overlap, matching the speed of what it ran into. */
    for (const a of f.agents) {
      const fa = a.fac!;
      if (fa.shadowLane < 0 || fa.stuck) continue;
      const nb = host.neighbours(fa.shadowLane, fa.u);
      if (!nb.ahead) continue;
      const over = fa.u + host.minClear - (nb.ahead.x - nb.ahead.length);
      if (over <= 0) continue;
      fa.s = Math.max(0, fa.s - over);
      a.v = Math.min(a.v, nb.ahead.v);
      this.updatePose(f, a);
    }

    // Trim the stats window.
    const cut = now - LOG_S;
    while (f.log.length > 0 && f.log[0].t < cut) f.log.shift();
  }

  /* Whatever is beyond the end of this lane: the back of the queue on the lane
   * it continues onto, or that lane's booth if it is empty. Walks forward
   * through single-successor lanes, and stops at a split the driver has not
   * chosen yet — they cannot know which queue they will be in. */
  private lookAhead(f: Facility, a: Vehicle, p: FPath): { gap: number; v: number } | null {
    const fa = a.fac!;
    let dist = p.len - fa.s;
    let pid: number | null = fa.next ?? (p.next.length === 1 ? p.next[0] : null);
    for (let hops = 0; pid != null && dist < LOOK_AHEAD_M && hops < 5; hops++) {
      const q = f.paths[pid];
      const last = this.lastOn(f, q.id);
      if (last) return { gap: dist + last.fac!.s - last.length, v: last.v };
      if (q.stop != null && !fa.exempt) return { gap: dist + q.stop + this.host.s0, v: 0 };
      if (q.role === "accel") return null; // its end is judged on the lane itself
      dist += q.len;
      pid = q.next.length === 1 ? q.next[0] : null;
    }
    return null;
  }

  /** Where this vehicle will be across the road `du` metres further along its way. */
  private wAhead(f: Facility, a: Vehicle, p: FPath, du: number): number {
    const fa = a.fac!;
    if (du <= 0) return fa.w;
    let s = fa.s + du;
    let q = p;
    let nid: number | null = fa.next ?? (p.next.length === 1 ? p.next[0] : null);
    for (let hops = 0; s > q.len && nid != null && hops < 4; hops++) {
      s -= q.len;
      q = f.paths[nid];
      nid = q.next.length === 1 ? q.next[0] : null;
    }
    return poseAt(q, s).w;
  }

  /* Taking turns where lanes converge.
   *
   * Everyone heading for the same junction is ordered by how far they still
   * have to go, as if they were in one queue, and follows whoever is next
   * ahead of them in it. Two vehicles leaving neighbouring booths therefore
   * interleave rather than arriving at the junction together, which is the
   * zip a driver actually does. Ties go to the lower id, so two vehicles can
   * never each be waiting for the other. */
  private convergeLeader(f: Facility, a: Vehicle, p: FPath): { gap: number; v: number; hard: boolean } | null {
    const fa = a.fac!;
    const dA = p.len - fa.s;
    // Never shorter than the stretch over which the lanes crowd each other.
    const look = f.laneEntries ? BARRIER_MERGE_LOOK_M : MERGE_LOOK_M;
    if (dA > Math.max(look, p.zipLook)) return null;
    const key = this.junctionKey(f, p, fa.next);
    if (key == null) return null;
    let best: { gap: number; v: number; hard: boolean } | null = null;
    for (const b of f.agents) {
      if (b === a) continue;
      const fb = b.fac!;
      if (fb.path === fa.path) continue;
      const pb = f.paths[fb.path];
      if (this.junctionKey(f, pb, fb.next) !== key) continue;
      const dB = pb.len - fb.s;
      if (dB > Math.max(look, pb.zipLook)) continue;
      /* In a barrier's out-fan, only with the lanes this one is about to crowd:
         two booths apart, the lanes run side by side for most of the fan, and
         queueing every car behind every other from the booths onwards cut a
         24-booth plaza to fewer vehicles an hour than Bocaue's busiest. */
      const pair = p.crowdD?.get(pb.id);
      if (pair != null && Math.max(dA, dB) > pair + PAIR_LOOK_M) continue;
      if (dB < dA || (dB === dA && b.id < a.id)) {
        const g = dA - dB - b.length;
        /* Firm once either of them is where the lanes actually crowd each
         * other. A car joining from two lanes over is in the trunk's way 22 m
         * before the junction; braking gently until 12 m out let it cut in
         * across the nose of the car it should have gone behind. */
        const hard = dA < ZIP_HARD_M || dA < p.conflictD + 4 || dB < pb.conflictD + 4;
        if (!best || g < best.gap) best = { gap: g, v: b.v, hard };
      }
    }
    return best;
  }

  /** What a lane runs into at its end, if more than one lane runs into it. */
  private junctionKey(f: Facility, p: FPath, chosen: number | null): string | null {
    if (p.end === "mainline") return `lane:${p.joinLane}`;
    if (p.end !== "paths") return null;
    const nid = chosen ?? (p.next.length === 1 ? p.next[0] : null);
    if (nid == null) return null;
    return f.paths[nid].prev.length > 1 ? `path:${nid}` : null;
  }

  /* A booth lane that has been shut, with vehicles still queued in it. They
   * do what drivers do at a plaza when a booth goes dark: ease across into the
   * next lane wherever a car-length opens up. Only behind the stop line, and
   * never into a lane that is itself shut. */
  private maybeDivert(f: Facility, a: Vehicle, byPath: Vehicle[][]) {
    const fa = a.fac!;
    const p = f.paths[fa.path];
    if (p.role !== "booth" || p.station < 0 || !this.isClosed(f, p.station)) return;
    if (fa.stuck || fa.serving || fa.target != null || fa.wShift < 1) return;
    if (p.stop != null && fa.s > p.stop - 1) return;
    const here = f.stations[p.station];
    const sideways = f.stations
      .filter((st) => st.kind === here.kind && Math.abs(st.index - here.index) === 1 && st.closedBy.length === 0)
      .sort(() => this.host.rng() - 0.5);
    for (const st of sideways) {
      const q = f.paths[st.path];
      if (!this.roomAt(f, q.id, fa.s, a.length + 1.5)) continue;
      const old = poseAt(p, fa.s);
      byPath[p.id] = byPath[p.id].filter((x) => x !== a);
      byPath[q.id].push(a);
      byPath[q.id].sort((x, y) => y.fac!.s - x.fac!.s);
      fa.path = q.id;
      fa.prevPath = null;
      fa.wFrom = old.w;
      fa.wShift = 0;
      fa.queuedAt = fa.queuedAt ?? this.host.now();
      return;
    }
  }

  private serviceTime(f: Facility): number {
    // Gamma-like spread around the mean: most transactions near it, a few slow
    // ones (change, a card that will not read), none instantaneous.
    const rng = () => this.host.rng();
    const u1 = Math.max(1e-9, rng());
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng());
    return f.spec.serviceSec * Math.min(2.4, Math.max(0.35, 1 + 0.33 * z));
  }

  private updatePose(f: Facility, a: Vehicle) {
    const fa = a.fac!;
    const p = f.paths[fa.path];
    const pose = poseAt(p, fa.s);
    let w = pose.w;
    if (fa.wShift < 1) {
      const t = fa.wShift;
      w = fa.wFrom + (pose.w - fa.wFrom) * (t * t * (3 - 2 * t));
    }
    fa.u = pose.u;
    fa.w = w;
    fa.du = pose.du;
    fa.dw = pose.dw;
    a.x = pose.u;
    // The rear, along the lane it is on, or the one it came off.
    let ts = fa.s - a.length;
    let tp = p;
    if (ts < 0 && fa.prevPath != null) {
      tp = f.paths[fa.prevPath];
      ts += tp.len;
    }
    if (ts >= 0) {
      const tpose = poseAt(tp, ts);
      fa.tu = tpose.u;
      fa.tw = tpose.w;
    } else {
      // Off the start of the lane it entered on: straight back along its first heading.
      const p0 = poseAt(tp, 0);
      fa.tu = p0.u + ts * p0.du;
      fa.tw = p0.w + ts * p0.dw;
    }
    if (fa.wShift < 1) fa.tw = fa.tw + (w - pose.w);
    const L = this.host.laneCount;
    // In the lane while EITHER end is: a truck leaving on a taper still has
    // its trailer across the outer lane after the cab has cleared it.
    const wIn = Math.min(w, fa.tw);
    const inRoad = wIn < SHADOW_W && Math.max(w, fa.tw) > -(L - 1) - 0.5;
    fa.shadowLane = inRoad ? Math.max(0, Math.min(L - 1, Math.round(L - 1 + Math.min(w, Math.max(fa.tw, -(L - 1)))))) : -1;
    a.lane = fa.shadowLane;
    a.laneFrom = a.lane;
    a.laneShift = 1;
  }

  /* ── Reporting ──────────────────────────────────────────────────────────── */

  stats(): FacilityStats[] {
    const now = this.host.now();
    return this.list.map((f) => {
      const recent = f.log.filter((e) => e.t >= now - LOG_S);
      const span = Math.max(60, Math.min(LOG_S, now));
      const queued = f.agents.filter((a) => a.v < 0.5 && !a.fac!.serving && !a.fac!.stuck).length;
      return {
        id: f.spec.id,
        name: f.spec.name,
        kind: f.spec.kind,
        inside: f.agents.length,
        queued,
        servedPerHour: (recent.length / span) * 3600,
        meanWaitS: recent.length ? recent.reduce((s, e) => s + e.wait, 0) / recent.length : 0,
        openStations: f.stations.filter((s) => s.closedBy.length === 0).length,
        stations: f.stations.length,
        pending: f.pending,
      };
    });
  }
}
