/* Do the toll plazas and service areas behave like places?
 *
 * Five properties, each one a way the facility layer could look right on the
 * canvas and still be wrong:
 *
 *   1. CAPACITY. A saturated booth clears what the operator says a booth
 *      clears (350/h). If it does not, the plaza's capacity is a side effect of
 *      the car-following model, not the operator's number.
 *   2. NO OVERLAP inside a facility, and none between a facility vehicle still
 *      on the carriageway (a taper "shadow") and the traffic in that lane.
 *   3. SPILL-BACK. Shut booths and the queue must come back up the ramp and
 *      onto the expressway, holding vehicles at the gore.
 *   4. ROUND TRIP. A service-area visitor gets served and comes back out onto
 *      the expressway; nobody is lost inside.
 *   5. BARRIER. Every lane goes through booths and comes back out.
 *   6. WIDE PLAZAS, as OpenStreetMap maps them: San Fernando's 7-lane exit at
 *      its real peak share, Bocaue's 24-booth barrier at its recorded peak and
 *      beyond, Meycauayan's 5-lane entry at its peak.
 *
 * Run from Back-End:
 *   ./node_modules/.bin/tsx ../smartflow_scripts/4_studies_audits/sandbox_validation/diagnostics/facility.ts
 */
import { TrafficSim, visualLane } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/simulation";
import {
  PAY_BOOTH_VEH_PER_HOUR,
  boothDwellFor,
  BOOTH_MOVE_UP_S,
  SERVICE_DWELL_S,
  DRAW_W_FRAC,
  type FacilitySpec,
} from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/facilities";

const DT = 0.05;

function sim(specs: FacilitySpec[], inflow: number, seed: number, length = 1200, lanes = 4): any {
  return new TrafficSim(
    { length, laneCount: lanes, inflowVehPerHour: inflow, seed, warmupS: 0, facilities: specs },
    { closedLanes: Array(lanes).fill(false), closurePoint: length, closureEnd: length, incidents: [], speedLimitKmh: null, speedZone: [0, 0] } as any,
  );
}

/* ── overlap, as drawn ───────────────────────────────────────────────────── */
/* How far along the road two bodies (rear-to-nose segments) are drawn inside
 * each other: sample one, ask whether each sample sits within `clear` of the
 * other's centreline at that point. */
function bodyOverlap(A: any, B: any, clear: number): number {
  const inside = (P: any, Q: any) => {
    let n = 0;
    const N = 8;
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      const u = P.tu + (P.u - P.tu) * t;
      const w = P.tw + (P.w - P.tw) * t;
      const lo = Math.min(Q.tu, Q.u), hi = Math.max(Q.tu, Q.u);
      if (u < lo || u > hi || hi - lo < 1e-6) continue;
      const qt = (u - Q.tu) / (Q.u - Q.tu);
      const qw = Q.tw + (Q.w - Q.tw) * qt;
      if (Math.abs(w - qw) < clear) n++;
    }
    return (n / (N + 1)) * Math.abs(P.u - P.tu);
  };
  return Math.max(inside(A, B), inside(B, A));
}

type Seen = { ticks: number; hitTicks: number; worst: number; where: string };
function checkOverlap(s: any, seen: Seen) {
  seen.ticks++;
  let hit = false;
  const L = s.cfg.laneCount;
  for (const f of s.fac.list) {
    const ag = f.agents;
    for (let i = 0; i < ag.length; i++) {
      for (let j = i + 1; j < ag.length; j++) {
        const A = ag[i], B = ag[j];
        let ov = 0;
        if (A.fac.path === B.fac.path) {
          ov = Math.min(A.fac.s, B.fac.s) - Math.max(A.fac.s - A.length, B.fac.s - B.length);
        } else {
          // Drawn overlap: centrelines closer than one drawn vehicle width.
          ov = bodyOverlap(A.fac, B.fac, DRAW_W_FRAC * f.pitch);
        }
        if (ov > 0.05) {
          hit = true;
          if (ov > seen.worst) {
            seen.worst = ov;
            seen.where = `${f.spec.id}: ${f.paths[A.fac.path].role}#${A.fac.path} s=${A.fac.s.toFixed(1)} vs ${f.paths[B.fac.path].role}#${B.fac.path} s=${B.fac.s.toFixed(1)}`;
          }
        }
      }
    }
  }
  // Shadows against the carriageway.
  for (const sh of s.fac.shadows()) {
    for (const v of s.vehicles) {
      if (Math.abs(visualLane(v) - (L - 1 + sh.fac.w)) >= 0.75) continue;
      const ov = Math.min(v.x, sh.x) - Math.max(v.x - v.length, sh.x - sh.length);
      if (ov > 0.05) {
        hit = true;
        if (ov > seen.worst) { seen.worst = ov; seen.where = `shadow ${sh.fac.fid} w=${sh.fac.w.toFixed(2)} vs mainline lane ${v.lane}`; }
      }
    }
  }
  if (hit) seen.hitTicks++;
}

function pct(n: number, d: number) { return d ? ((100 * n) / d).toFixed(2) + "%" : "-"; }

/* ── 1. capacity ─────────────────────────────────────────────────────────── */
function capacity() {
  const dwell = boothDwellFor(PAY_BOOTH_VEH_PER_HOUR);
  console.log(`\n1. CAPACITY  dwell ${dwell.toFixed(2)} s (move-up ${BOOTH_MOVE_UP_S} s) for ${PAY_BOOTH_VEH_PER_HOUR}/h/booth`);
  for (const booths of [1, 2, 4]) {
    // Entry plaza fed far beyond capacity, so every booth always has a queue.
    const spec: FacilitySpec = {
      id: "entry", kind: "entry_ramp", name: "entry", x: 300, booths, serviceSec: dwell,
      arrivalsVehPerHour: booths * PAY_BOOTH_VEH_PER_HOUR * 2.5, tollMode: "pay",
    };
    const s = sim([spec], 1800, 7 + booths);
    const seen: Seen = { ticks: 0, hitTicks: 0, worst: 0, where: "" };
    const WARM = 180, RUN = 1800;
    let served0 = 0;
    for (let i = 0; i < (WARM + RUN) / DT; i++) {
      s.step(DT);
      if (i === Math.round(WARM / DT)) served0 = s.fac.list[0].stations.reduce((n: number, st: any) => n + st.served, 0);
      if (i % 4 === 0) checkOverlap(s, seen);
    }
    const served = s.fac.list[0].stations.reduce((n: number, st: any) => n + st.served, 0) - served0;
    const perBooth = (served / RUN) * 3600 / booths;
    const ok = Math.abs(perBooth - PAY_BOOTH_VEH_PER_HOUR) / PAY_BOOTH_VEH_PER_HOUR < 0.05;
    console.log(`   ${booths} booth(s): ${perBooth.toFixed(0)} veh/h per booth  ${ok ? "ok" : "<-- OFF BY MORE THAN 5%"}   overlap ticks ${pct(seen.hitTicks, seen.ticks)} worst ${seen.worst.toFixed(2)} m ${seen.where}`);
  }
}

/* ── 2+3. an exit plaza at ordinary flow, then with booths shut ─────────── */
function exitPlaza() {
  const dwell = boothDwellFor(PAY_BOOTH_VEH_PER_HOUR);
  const spec: FacilitySpec = {
    id: "exit", kind: "exit_ramp", name: "exit", x: 500, booths: 3, serviceSec: dwell, turnFraction: 0.15, tollMode: "pay",
  };
  const s = sim([spec], 4200, 99);
  const seen: Seen = { ticks: 0, hitTicks: 0, worst: 0, where: "" };
  const f = s.fac.list[0];
  let maxInside = 0, maxHeld = 0, heldTicks = 0;
  const phase = (label: string, secs: number) => {
    maxInside = 0; maxHeld = 0; heldTicks = 0;
    let ticks = 0;
    for (let i = 0; i < secs / DT; i++) {
      s.step(DT);
      ticks++;
      if (i % 4 === 0) checkOverlap(s, seen);
      maxInside = Math.max(maxInside, f.agents.length);
      const held = s.vehicles.filter((v: any) => v.heldAtGore).length;
      maxHeld = Math.max(maxHeld, held);
      if (held > 0) heldTicks++;
    }
    const st = s.facilityStats()[0];
    // Outer-lane queue upstream of the gore: stopped vehicles in the last lane within 400 m before it.
    const outerQ = s.vehicles.filter((v: any) => v.lane === s.cfg.laneCount - 1 && v.x < f.divergeX + 2 && v.x > f.divergeX - 400 && v.v < 2).length;
    console.log(`   ${label.padEnd(26)} inside max ${String(maxInside).padStart(3)}  held at gore max ${String(maxHeld).padStart(2)} (${pct(heldTicks, ticks)} of ticks)  outer-lane queue now ${String(outerQ).padStart(2)}  served ${st.servedPerHour.toFixed(0)}/h  wait ${st.meanWaitS.toFixed(0)} s`);
  };
  console.log(`\n2/3. EXIT PLAZA, 3 booths, 15% turning off 4,200 veh/h (~630/h for 1,050/h of capacity)`);
  phase("open", 600);
  for (const st of f.stations.slice(0, 2)) s.fac.closeStation("exit", st.index, "test");
  phase("two of three booths shut", 600);
  s.fac.openAllFor("test");
  phase("reopened", 600);
  console.log(`   overlap ticks ${pct(seen.hitTicks, seen.ticks)}  worst ${seen.worst.toFixed(2)} m ${seen.where}`);
}

/* ── 4. service area round trip ──────────────────────────────────────────── */
function serviceArea() {
  const spec: FacilitySpec = {
    id: "sa", kind: "service_area", name: "sa", x: 300, booths: 4, serviceSec: SERVICE_DWELL_S, turnFraction: 0.01,
  };
  const s = sim([spec], 4200, 5, 1200);
  const seen: Seen = { ticks: 0, hitTicks: 0, worst: 0, where: "" };
  const f = s.fac.list[0];
  const entered = new Set<number>();
  const returned = new Set<number>();
  for (let i = 0; i < 1800 / DT; i++) {
    s.step(DT);
    if (i % 4 === 0) checkOverlap(s, seen);
    for (const a of f.agents) entered.add(a.id);
    for (const v of s.vehicles) if (entered.has(v.id)) returned.add(v.id);
  }
  const served = f.stations.reduce((n: number, st: any) => n + st.served, 0);
  const inside = f.agents.length;
  const lost = entered.size - returned.size - inside;
  console.log(`\n4. SERVICE AREA, 1% of 4,200 veh/h stopping for ${SERVICE_DWELL_S} s at 4 pumps, 30 min`);
  console.log(`   pulled in ${entered.size}, served ${served}, back on the expressway ${returned.size}, still inside ${inside}, lost ${lost}  ${lost === 0 ? "ok" : "<-- VEHICLES LOST"}`);
  console.log(`   overlap ticks ${pct(seen.hitTicks, seen.ticks)}  worst ${seen.worst.toFixed(2)} m ${seen.where}`);
}

/* ── 5. barrier ──────────────────────────────────────────────────────────── */
function barrier() {
  const dwell = boothDwellFor(PAY_BOOTH_VEH_PER_HOUR);
  const spec: FacilitySpec = { id: "bar", kind: "barrier", name: "bar", x: 500, booths: 12, serviceSec: dwell, tollMode: "pay" };
  const s = sim([spec], 3000, 11, 1200);
  const seen: Seen = { ticks: 0, hitTicks: 0, worst: 0, where: "" };
  const f = s.fac.list[0];
  let completed0 = 0;
  for (let i = 0; i < 1200 / DT; i++) {
    s.step(DT);
    if (i % 4 === 0) checkOverlap(s, seen);
    if (i === Math.round(300 / DT)) completed0 = f.stations.reduce((n: number, st: any) => n + st.served, 0);
  }
  const served = f.stations.reduce((n: number, st: any) => n + st.served, 0) - completed0;
  const m = s.metrics();
  console.log(`\n5. BARRIER, 12 booths across 4 lanes, 3,000 veh/h (capacity ${12 * PAY_BOOTH_VEH_PER_HOUR}/h)`);
  console.log(`   served ${(served / 900 * 3600).toFixed(0)} veh/h through the booths, ${m.throughputPerMin.toFixed(1)}/min leaving the segment, inside now ${f.agents.length}, held at the fan ${s.vehicles.filter((v: any) => v.heldAtGore).length}`);
  console.log(`   overlap ticks ${pct(seen.hitTicks, seen.ticks)}  worst ${seen.worst.toFixed(2)} m ${seen.where}`);
}

/* ── 6. wide plazas ─────────────────────────────────────────────────────── */
function widePlazas() {
  const dwell = boothDwellFor(PAY_BOOTH_VEH_PER_HOUR);
  console.log(`\n6. WIDE PLAZAS (booth lanes as OpenStreetMap maps them)`);
  const cases: { label: string; spec: FacilitySpec; inflow: number; secs: number; L?: number; expect: number }[] = [
    { label: "exit, 7 booths, 29.6% of 3,393/h (San Fernando NB peak)", spec: { id: "w", kind: "exit_ramp", name: "w", x: 300, booths: 7, serviceSec: dwell, turnFraction: 0.296, tollMode: "pay" }, inflow: 3393, secs: 1200, expect: 1004 },
    { label: "entry, 5 booths, 841/h (Meycauayan SB peak)", spec: { id: "w", kind: "entry_ramp", name: "w", x: 300, booths: 5, serviceSec: dwell, arrivalsVehPerHour: 841, tollMode: "pay" }, inflow: 3500, secs: 1200, expect: 841 },
    { label: "barrier, 24 booths, 3,872/h (Bocaue SB peak)", spec: { id: "w", kind: "barrier", name: "w", x: 400, booths: 24, serviceSec: dwell, tollMode: "pay" }, inflow: 3872, secs: 1200, L: 1400, expect: 3872 },
    { label: "barrier, 24 booths, 6,000/h (beyond any hour on record)", spec: { id: "w", kind: "barrier", name: "w", x: 400, booths: 24, serviceSec: dwell, tollMode: "pay" }, inflow: 6000, secs: 1200, L: 1400, expect: 6000 },
  ];
  for (const c of cases) {
    const s = sim([c.spec], c.inflow, 21, c.L ?? 1200);
    const seen: Seen = { ticks: 0, hitTicks: 0, worst: 0, where: "" };
    const f = s.fac.list[0];
    const WARM = 300;
    let served0 = 0, maxHeld = 0, maxPending = 0;
    for (let i = 0; i < c.secs / DT; i++) {
      s.step(DT);
      if (i === Math.round(WARM / DT)) served0 = f.stations.reduce((n: number, st: any) => n + st.served, 0);
      if (i % 4 === 0) {
        checkOverlap(s, seen);
        maxHeld = Math.max(maxHeld, s.vehicles.filter((v: any) => v.heldAtGore).length);
        maxPending = Math.max(maxPending, f.pending);
      }
    }
    const perHour = ((f.stations.reduce((n: number, st: any) => n + st.served, 0) - served0) / (c.secs - WARM)) * 3600;
    const m = s.metrics();
    console.log(`   ${c.label}`);
    console.log(`      served ${perHour.toFixed(0)}/h (asked ${c.expect}/h, booths could take ${c.spec.booths * PAY_BOOTH_VEH_PER_HOUR}/h)  inside ${f.agents.length}  held at gore max ${maxHeld}  waiting off-road max ${maxPending}  mainline ${m.avgSpeedKmh.toFixed(0)} km/h`);
    console.log(`      overlap ticks ${pct(seen.hitTicks, seen.ticks)}  worst ${seen.worst.toFixed(2)} m ${seen.where}`);
  }
}

// `facility.ts basic` runs only 1-4, `facility.ts wide` only the barriers and the wide plazas.
const part = process.argv[2];
if (part !== "wide") {
  capacity();
  exitPlaza();
  serviceArea();
}
if (part !== "basic") {
  barrier();
  widePlazas();
}
