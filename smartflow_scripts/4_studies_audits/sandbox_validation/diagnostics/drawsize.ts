/* Do vehicles change size on screen when they change lanes?
 *
 * Runs the road, and sizes every sprite the way the canvas does (page.tsx with
 * facilityArt's helpers) for a typical view — 0.6 km across 1,000 px, lanes
 * 110 px tall — under the rule before (sized against whatever gap it has,
 * counted in both lanes for the whole change) and the rule now (one steady
 * size per class, counted in a lane only when drawn close to it). For each
 * lane change: was the car changing, or the one it pulls in behind, drawn
 * smaller than its steady size at any point during it?
 *
 *   ./node_modules/.bin/tsx ../smartflow_scripts/4_studies_audits/sandbox_validation/diagnostics/drawsize.ts [inflow]
 */
import { TrafficSim, visualLane } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/simulation";
import { baseLengthPx, drawnLengthPx, SPRITE_GAP_EATEN } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/facilityArt";

const DT = 0.05;
const inflow = Number(process.argv[2] ?? 4900);
const L = 600, CSS_W = 1000, LANE_H = 110, LANES = 4;
const mToPx = CSS_W / L;
const s: any = new TrafficSim(
  { length: L, laneCount: LANES, inflowVehPerHour: inflow, seed: 3, warmupS: 60 },
  { closedLanes: [false, false, false, false], closurePoint: L, closureEnd: L, incidents: [], speedLimitKmh: null, speedZone: [0, 0] } as any,
);

// k exactly as page.tsx chooses it.
function kFor(n: number): number {
  const trueCarLen = 4.6 * mToPx;
  const spacingPx = CSS_W / Math.max(1, n / LANES);
  const kFloor = Math.max(trueCarLen, Math.max(15, LANE_H * 0.42)) / trueCarLen;
  const trueBusLen = 12 * mToPx;
  return Math.min(kFloor, Math.max(2, spacingPx * 0.9) / trueBusLen, (LANE_H * 0.9) / trueBusLen);
}

type Rule = "before" | "now";
function sizes(vs: any[], rule: Rule, k: number): Map<number, { len: number; base: number }> {
  const reach = rule === "now" ? Math.min(0.95, Math.min(LANE_H * 0.85, 2.6 * mToPx * (Math.min(4.6 * k, 4.6 + SPRITE_GAP_EATEN * 16) / 4.6) * 1.7) / LANE_H + 0.05) : 1;
  const bands = new Map<number, any[]>();
  const put = (b: number, v: any) => (bands.get(b) ?? bands.set(b, []).get(b)!).push(v);
  for (const v of vs) {
    if (rule === "before") {
      put(v.lane, v);
      if (v.laneShift < 1 && v.laneFrom !== v.lane) put(v.laneFrom, v);
    } else {
      const across = visualLane(v);
      for (const b of v.laneFrom !== v.lane ? [v.lane, v.laneFrom] : [v.lane]) if (Math.abs(across - b) < reach) put(b, v);
    }
  }
  const room = new Map<number, number>();
  for (const arr of bands.values()) {
    arr.sort((a, b) => a.x - b.x);
    for (let i = 1; i < arr.length; i++) {
      const g = arr[i].x - arr[i - 1].x;
      if (!(room.get(arr[i].id)! <= g)) room.set(arr[i].id, g);
    }
  }
  const out = new Map<number, { len: number; base: number }>();
  for (const v of vs) {
    const r = room.get(v.id) ?? Infinity;
    if (rule === "before") {
      const base = v.length * mToPx * k;
      const gap = Math.max(0, r - v.length);
      out.set(v.id, { base, len: isFinite(r) ? Math.max(2, Math.min(base, (v.length + gap * SPRITE_GAP_EATEN) * mToPx - 1.5)) : base });
    } else {
      const base = baseLengthPx(v.length, mToPx, k);
      out.set(v.id, { base, len: drawnLengthPx(base, v.length, r, mToPx) });
    }
  }
  return out;
}

const stats: Record<Rule, { changes: number; squeezedDuring: number; frames: number; squeezedFrames: number; carPx: number }> = {
  before: { changes: 0, squeezedDuring: 0, frames: 0, squeezedFrames: 0, carPx: 0 },
  now: { changes: 0, squeezedDuring: 0, frames: 0, squeezedFrames: 0, carPx: 0 },
};
// Open lane changes: changer id -> { leader id in its new lane, squeezed so far per rule }.
const open = new Map<number, { leader: number | null; hit: Record<Rule, boolean> }>();
const lastLane = new Map<number, number>();

for (let i = 0; i < 900 / DT; i++) {
  s.step(DT);
  if (i < 120 / DT) {
    for (const v of s.vehicles) lastLane.set(v.id, v.lane);
    continue;
  }
  const vs = s.vehicles as any[];
  const k = kFor(vs.length);
  const drawn = { before: sizes(vs, "before", k), now: sizes(vs, "now", k) };
  for (const v of vs) {
    const was = lastLane.get(v.id);
    lastLane.set(v.id, v.lane);
    if (was !== undefined && was !== v.lane && !open.has(v.id)) {
      let leader: any = null;
      for (const o of vs) if (o !== v && o.lane === v.lane && o.x > v.x && (!leader || o.x < leader.x)) leader = o;
      open.set(v.id, { leader: leader?.id ?? null, hit: { before: false, now: false } });
    }
  }
  for (const rule of ["before", "now"] as Rule[]) {
    const d = drawn[rule];
    for (const v of vs) {
      const e = d.get(v.id)!;
      stats[rule].frames++;
      if (e.len < e.base - 0.5) stats[rule].squeezedFrames++;
      if (v.vClass === 1 && v.length <= 4.7) stats[rule].carPx = e.base;
    }
    for (const [id, o] of open) {
      for (const who of [id, o.leader]) {
        if (who == null) continue;
        const e = d.get(who);
        if (e && e.len < e.base - 0.5) o.hit[rule] = true;
      }
    }
  }
  // A change is over once the changer is fully across (or has left the road).
  for (const [id, o] of [...open]) {
    const v = vs.find((x) => x.id === id);
    if (v && v.laneShift < 1) continue;
    for (const rule of ["before", "now"] as Rule[]) {
      stats[rule].changes++;
      if (o.hit[rule]) stats[rule].squeezedDuring++;
    }
    open.delete(id);
  }
}

const m = s.metrics();
console.log(`${inflow} veh/h, ${m.avgSpeedKmh.toFixed(0)} km/h — a 0.6 km view, 1,000 px wide, 110 px lanes`);
for (const rule of ["before", "now"] as Rule[]) {
  const st = stats[rule];
  console.log(`  ${rule.padEnd(6)} car drawn ${st.carPx.toFixed(0)} px long; lane changes that resized the changer or the car it pulled in behind: ${((100 * st.squeezedDuring) / Math.max(1, st.changes)).toFixed(0)}% of ${st.changes}; vehicles drawn below their size at any moment: ${((100 * st.squeezedFrames) / Math.max(1, st.frames)).toFixed(1)}%`);
}
