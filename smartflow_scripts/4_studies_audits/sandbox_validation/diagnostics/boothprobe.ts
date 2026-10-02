/* Where does a saturated booth's cycle go? Time from one vehicle finishing to
 * the next starting, split by the class of the vehicle moving up. */
import { TrafficSim } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/simulation";
import { boothDwellFor, type FacilitySpec } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/facilities";
const DT = 0.05;
const spec: FacilitySpec = { id: "e", kind: "entry_ramp", name: "e", x: 300, booths: 1, serviceSec: boothDwellFor(350), arrivalsVehPerHour: 1500, tollMode: "pay" };
const s: any = new TrafficSim({ length: 1200, laneCount: 4, inflowVehPerHour: 1500, seed: 3, warmupS: 0, facilities: [spec] },
  { closedLanes: [false, false, false, false], closurePoint: 1200, closureEnd: 1200, incidents: [], speedLimitKmh: null, speedZone: [0, 0] } as any);
const f = s.fac.list[0];
let lastEnd: number | null = null;
let serving: any = null;
const gaps: Record<number, number[]> = { 1: [], 2: [], 3: [] };
const dwells: number[] = [];
let startT = 0;
for (let i = 0; i < 2400 / DT; i++) {
  s.step(DT);
  const now = s.time;
  const cur = f.agents.find((a: any) => a.fac.serving) ?? null;
  if (serving && cur !== serving) { lastEnd = now; dwells.push(now - startT); serving = null; }
  if (cur && cur !== serving) {
    if (lastEnd != null && now > 200) gaps[cur.vClass].push(now - lastEnd);
    serving = cur; startT = now;
  }
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
for (const c of [1, 2, 3]) console.log(`class ${c}: n=${gaps[c].length} move-up mean ${mean(gaps[c]).toFixed(2)} s`);
const all = [...gaps[1], ...gaps[2], ...gaps[3]];
console.log(`all: move-up ${mean(all).toFixed(2)} s, dwell ${mean(dwells).toFixed(2)} s, cycle ${(mean(all) + mean(dwells)).toFixed(2)} s -> ${(3600 / (mean(all) + mean(dwells))).toFixed(0)} veh/h`);
