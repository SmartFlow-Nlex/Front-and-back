/* A barrier plaza fed beyond its booths: where do vehicles stand, and how busy is each booth? */
import { TrafficSim } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/simulation";
import { boothDwellFor, type FacilitySpec } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/facilities";
const DT = 0.05;
const inflow = Number(process.argv[2] ?? 3800), L = Number(process.argv[3] ?? 900), x = Number(process.argv[4] ?? 300);
const spec: FacilitySpec = { id: "bar", kind: "barrier", name: "bar", x, booths: 12, serviceSec: boothDwellFor(350), tollMode: "pay" };
const s: any = new TrafficSim({ length: L, laneCount: 4, inflowVehPerHour: inflow, seed: 11, warmupS: 0, facilities: [spec] },
  { closedLanes: [false, false, false, false], closurePoint: L, closureEnd: L, incidents: [], speedLimitKmh: null, speedZone: [0, 0] } as any);
const f = s.fac.list[0];
const count: Record<string, number> = {}, stand: Record<string, number> = {};
let n = 0; let served0: number[] = [];
for (let i = 0; i < 1200 / DT; i++) {
  s.step(DT);
  if (i === Math.round(300 / DT)) served0 = f.stations.map((st: any) => st.served);
  if (i > 300 / DT) {
    n++;
    for (const a of f.agents) { const r = f.paths[a.fac.path].role; count[r] = (count[r] ?? 0) + 1; if (a.v < 0.5 && !a.fac.serving) stand[r] = (stand[r] ?? 0) + 1; }
  }
}
const per = f.stations.map((st: any, k: number) => ((st.served - served0[k]) / 900) * 3600);
console.log(`inflow ${inflow}, window ${L} m, plaza at ${x}: served ${per.reduce((a: number, b: number) => a + b, 0).toFixed(0)}/h; per booth (inner->outer): ${per.map((v: number) => v.toFixed(0)).join(" ")}`);
console.log(`booth lane of each booth: ${f.stations.map((st: any) => f.paths[st.path + 1]?.joinLane ?? "?").join(" ")}`);
for (const r of Object.keys(count)) console.log(`  ${r.padEnd(11)} avg on it ${(count[r] / n).toFixed(1).padStart(5)}  standing ${((stand[r] ?? 0) / n).toFixed(1).padStart(5)}`);
const held = s.vehicles.filter((v: any) => v.heldAtGore).length;
console.log(`  held on the mainline at the fan now: ${held}; unmet demand ${s.metrics().unmetVehPerHour.toFixed(0)}/h`);
