/* Do vehicles ever overlap ON SCREEN?
 *
 * step()'s safety net enforces clearance per INTEGER lane. But visualLane()
 * draws a vehicle mid-manoeuvre at a fractional position between laneFrom and
 * lane, and its integer lane flips the instant MOBIL accepts the move. So a
 * car straddling lanes 2 and 3 is only ever checked against lane 3's
 * occupants — nothing stops it being drawn through a car still in lane 2.
 *
 * This measures what the operator actually sees: two sprites whose lateral
 * separation is under a lane width AND whose longitudinal extents intersect.
 */
import { TrafficSim, visualLane } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/simulation";

const DT = 0.05;
const SECS = 600;
/** Sprites closer than this laterally are drawn in overlapping bands. */
const LATERAL_HIT = 0.75; // lane widths

type Hit = { t: number; overlapM: number; lateral: number; midChange: boolean };

let DUMP = false;
let dumped = 0;
function run(seed: number, inflow: number, withIncident: boolean) {
  const sim: any = new TrafficSim(
    { length: 1000, laneCount: 4, inflowVehPerHour: inflow, seed },
    {
      closedLanes: [false, false, false, false],
      closurePoint: 600, closureEnd: 800,
      incidents: [], speedLimitKmh: null, speedZone: [0, 0],
    } as any,
  );

  let ticks = 0;
  let hitTicks = 0;
  let worst: Hit = { t: 0, overlapM: 0, lateral: 0, midChange: false };
  let midChangeHits = 0;
  let sameLaneHits = 0;

  for (let i = 0; i < SECS / DT; i++) {
    if (withIncident && i === Math.floor(120 / DT)) sim.addIncident(2, 700);
    sim.step(DT);
    ticks++;

    const vs = sim.vehicles as any[];
    let hitThisTick = false;
    for (let a = 0; a < vs.length; a++) {
      for (let b = a + 1; b < vs.length; b++) {
        const A = vs[a], B = vs[b];
        const lateral = Math.abs(visualLane(A) - visualLane(B));
        if (lateral >= LATERAL_HIT) continue;
        // Longitudinal intersection of [x-length, x]
        const overlap = Math.min(A.x, B.x) - Math.max(A.x - A.length, B.x - B.length);
        if (overlap <= 0) continue;
        hitThisTick = true;
        const mid = A.laneShift < 1 || B.laneShift < 1;
        if (mid) midChangeHits++; else sameLaneHits++;
        if (overlap > worst.overlapM) worst = { t: sim.time, overlapM: overlap, lateral, midChange: mid };
        if (DUMP && dumped < 6) {
          dumped++;
          const d = (V: any) => `id${V.id} lane${V.lane}<-${V.laneFrom} shift${V.laneShift.toFixed(2)} vis${visualLane(V).toFixed(2)} x${V.x.toFixed(2)} len${V.length} v${V.v.toFixed(1)}`;
          console.log(`   t=${sim.time.toFixed(2)} overlap=${overlap.toFixed(2)}m lat=${lateral.toFixed(3)}`);
          console.log(`     A: ${d(A)}`);
          console.log(`     B: ${d(B)}`);
        }
      }
    }
    if (hitThisTick) hitTicks++;
  }
  return { ticks, hitTicks, pctTicks: (100 * hitTicks) / ticks, worst, midChangeHits, sameLaneHits };
}

const seeds = [12345, 777, 2024];
for (const [label, inflow, inc] of [
  ["free flow      ", 2400, false],
  ["congested      ", 5200, false],
  ["with incident  ", 5200, true],
] as [string, number, boolean][]) {
  DUMP = label.includes("incident");
  const rs = seeds.map((s) => run(s, inflow, inc));
  const pct = rs.reduce((a, r) => a + r.pctTicks, 0) / rs.length;
  const worst = rs.reduce((a, r) => (r.worst.overlapM > a.overlapM ? r.worst : a), rs[0].worst);
  const mid = rs.reduce((a, r) => a + r.midChangeHits, 0);
  const same = rs.reduce((a, r) => a + r.sameLaneHits, 0);
  console.log(
    `${label} ticks with an overlap ${pct.toFixed(2).padStart(6)}%   worst ${worst.overlapM.toFixed(2).padStart(5)} m` +
    `   (lateral ${worst.lateral.toFixed(2)} lanes, ${worst.midChange ? "MID-CHANGE" : "same lane"})` +
    `   pairs: mid-change ${mid}, same-lane ${same}`,
  );
}
