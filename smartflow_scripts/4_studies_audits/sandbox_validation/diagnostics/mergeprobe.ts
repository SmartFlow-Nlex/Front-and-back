/* How do drivers get from an entry plaza onto the expressway?
 *
 * For each vehicle that comes off an acceleration lane: where along it they
 * merged, at what speed, and whether they first had to stop at its end and for
 * how long. A lane that works is merged off at speed along its length; a lane
 * that does not ends in a stopped queue waiting for a gap that never comes.
 *
 *   ./node_modules/.bin/tsx ../smartflow_scripts/4_studies_audits/sandbox_validation/diagnostics/mergeprobe.ts [inflow] [arrivals] [booths]
 */
import { TrafficSim } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/simulation";
import { boothDwellFor, type FacilitySpec } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/facilities";

const DT = 0.05;
const inflow = Number(process.argv[2] ?? 3300);
const arrivals = Number(process.argv[3] ?? 400);
const booths = Number(process.argv[4] ?? 3);
const L = 1200;
const spec: FacilitySpec = { id: "e", kind: "entry_ramp", name: "e", x: 250, booths, serviceSec: boothDwellFor(350), arrivalsVehPerHour: arrivals, tollMode: "pay" };
const s: any = new TrafficSim({ length: L, laneCount: 4, inflowVehPerHour: inflow, seed: 9, warmupS: 0, facilities: [spec] },
  { closedLanes: [false, false, false, false], closurePoint: L, closureEnd: L, incidents: [], speedLimitKmh: null, speedZone: [0, 0] } as any);
const f = s.fac.list[0];
const accel = f.paths.find((p: any) => p.role === "accel");

type Track = { stoppedAtEnd: number; lastS: number; lastV: number; onAccel: boolean };
const track = new Map<number, Track>();
const merges: { s: number; v: number; waited: number }[] = [];
let t = 0;
for (let i = 0; i < 1800 / DT; i++) {
  s.step(DT);
  t += DT;
  const here = new Set<number>();
  for (const a of f.agents) {
    if (a.fac.path !== accel.id) continue;
    here.add(a.id);
    const tr = track.get(a.id) ?? { stoppedAtEnd: 0, lastS: 0, lastV: 0, onAccel: true };
    if (a.v < 0.5 && accel.len - a.fac.s < 10) tr.stoppedAtEnd += DT;
    tr.lastS = a.fac.s;
    tr.lastV = a.v;
    track.set(a.id, tr);
  }
  // Gone from the acceleration lane since last step: merged (it is now a mainline vehicle).
  for (const [id, tr] of [...track]) {
    if (here.has(id)) continue;
    if (t > 300 && s.vehicles.some((v: any) => v.id === id)) merges.push({ s: tr.lastS, v: tr.lastV, waited: tr.stoppedAtEnd });
    track.delete(id);
  }
}
const n = merges.length;
const pct = (a: number[], p: number) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor((p / 100) * b.length))] : NaN; };
const stopped = merges.filter((m) => m.waited > 0.5);
console.log(`${inflow} veh/h on the road, ${arrivals} veh/h joining through ${booths} booths — ${n} merges in 25 min (acceleration lane ${accel.len.toFixed(0)} m)`);
console.log(`  merged at: ${(100 * merges.filter((m) => m.s < accel.len * 0.5).length / Math.max(1, n)).toFixed(0)}% in the first half of the lane, speed median ${pct(merges.map((m) => m.v * 3.6), 50).toFixed(0)} km/h`);
console.log(`  had to stop at the end first: ${(100 * stopped.length / Math.max(1, n)).toFixed(0)}%; of those, waited median ${pct(stopped.map((m) => m.waited), 50).toFixed(1)} s, longest ${Math.max(0, ...stopped.map((m) => m.waited)).toFixed(1)} s`);
console.log(`  still on the lane at the end: ${track.size}, waiting off-road ${f.pending}`);
