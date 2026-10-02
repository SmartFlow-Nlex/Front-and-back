/* How tight do the gaps get, for drawing?
 *
 * The canvas draws vehicles larger than life, so it needs to know how much of
 * the real gap behind a vehicle a sprite can take without being drawn into the
 * one behind. Two numbers: the gaps at the moment of a lane change (behind the
 * changer, and behind the vehicle it pulls in after — where a size tied to the
 * gap would jump), and the gaps behind every moving vehicle over time.
 *
 *   ./node_modules/.bin/tsx ../smartflow_scripts/4_studies_audits/sandbox_validation/diagnostics/drawgaps.ts [inflow] [length]
 */
import { TrafficSim } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/simulation";

const DT = 0.05;
const inflow = Number(process.argv[2] ?? 4900);
const L = Number(process.argv[3] ?? 600);
const s: any = new TrafficSim(
  { length: L, laneCount: 4, inflowVehPerHour: inflow, seed: 3, warmupS: 60 },
  { closedLanes: [false, false, false, false], closurePoint: L, closureEnd: L, incidents: [], speedLimitKmh: null, speedZone: [0, 0] } as any,
);

const changerGaps: number[] = [];
const leaderGaps: number[] = [];
const allGaps: number[] = [];
const lastLane = new Map<number, number>();
const inBand = (v: any, b: number) => v.lane === b || (v.laneShift < 1 && v.laneFrom === b);

for (let i = 0; i < 900 / DT; i++) {
  s.step(DT);
  const vs = s.vehicles as any[];
  for (const v of vs) {
    const was = lastLane.get(v.id);
    lastLane.set(v.id, v.lane);
    if (was === undefined || was === v.lane || i < 120 / DT) continue;
    // A lane change has just begun: the gaps in the lane it is moving into.
    let follower: any = null;
    let leader: any = null;
    for (const o of vs) {
      if (o === v || !inBand(o, v.lane)) continue;
      if (o.x < v.x && (!follower || o.x > follower.x)) follower = o;
      if (o.x > v.x && (!leader || o.x < leader.x)) leader = o;
    }
    if (follower) changerGaps.push(v.x - v.length - follower.x);
    if (leader) leaderGaps.push(leader.x - leader.length - v.x);
  }
  if (i % 20 === 0 && i > 120 / DT) {
    for (let b = 0; b < 4; b++) {
      const band = vs.filter((o) => inBand(o, b)).sort((p, q) => p.x - q.x);
      for (let k = 1; k < band.length; k++) if (band[k].v > 5) allGaps.push(band[k].x - band[k].length - band[k - 1].x);
    }
  }
}

const pct = (a: number[], p: number) => {
  const b = [...a].sort((x, y) => x - y);
  return b.length ? b[Math.min(b.length - 1, Math.floor((p / 100) * b.length))] : NaN;
};
const show = (label: string, a: number[]) =>
  console.log(`${label.padEnd(44)} n=${String(a.length).padStart(5)}  p5 ${pct(a, 5).toFixed(1).padStart(5)}  p10 ${pct(a, 10).toFixed(1).padStart(5)}  p25 ${pct(a, 25).toFixed(1).padStart(5)}  median ${pct(a, 50).toFixed(1).padStart(5)} m`);
const m = s.metrics();
console.log(`${inflow} veh/h on ${L} m, 4 lanes: ${m.avgSpeedKmh.toFixed(0)} km/h`);
show("gap behind a changer, as it starts", changerGaps);
show("gap behind the vehicle it pulls in after", leaderGaps);
show("gap behind any moving vehicle", allGaps);
