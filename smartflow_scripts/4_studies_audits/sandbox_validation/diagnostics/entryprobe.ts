/* A saturated 4-booth entry plaza: where do vehicles stand? */
import { TrafficSim } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/simulation";
import { boothDwellFor, type FacilitySpec } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/facilities";
const DT = 0.05;
const booths = Number(process.argv[2] ?? 4);
const mainline = Number(process.argv[3] ?? 1800);
const spec: FacilitySpec = { id: "e", kind: "entry_ramp", name: "e", x: 300, booths, serviceSec: boothDwellFor(350), arrivalsVehPerHour: booths * 350 * 2.5, tollMode: "pay" };
const s: any = new TrafficSim({ length: 1200, laneCount: 4, inflowVehPerHour: mainline, seed: 3, warmupS: 0, facilities: [spec] },
  { closedLanes: [false, false, false, false], closurePoint: 1200, closureEnd: 1200, incidents: [], speedLimitKmh: null, speedZone: [0, 0] } as any);
const f = s.fac.list[0];
const count: Record<string, number> = {};
const stopped: Record<string, number> = {};
let n = 0, served0 = 0, merged = 0;
const seen = new Set<number>();
for (let i = 0; i < 1500 / DT; i++) {
  s.step(DT);
  if (i === Math.round(300 / DT)) { served0 = f.stations.reduce((k: number, st: any) => k + st.served, 0); }
  if (i > 300 / DT) {
    n++;
    for (const a of f.agents) {
      const r = f.paths[a.fac.path].role;
      count[r] = (count[r] ?? 0) + 1;
      if (a.v < 0.5 && !a.fac.serving) stopped[r] = (stopped[r] ?? 0) + 1;
    }
    for (const v of s.vehicles) if (v.spawnTime > 300 && v.x > 900 && !seen.has(v.id)) { seen.add(v.id); }
  }
}
const served = f.stations.reduce((k: number, st: any) => k + st.served, 0) - served0;
console.log(`${booths} booths, mainline ${mainline}/h: served ${(served / 1200 * 3600).toFixed(0)}/h`);
for (const r of Object.keys(count)) console.log(`  ${r.padEnd(10)} avg on it ${(count[r] / n).toFixed(1).padStart(5)}  avg standing ${((stopped[r] ?? 0) / n).toFixed(1).padStart(5)}`);
