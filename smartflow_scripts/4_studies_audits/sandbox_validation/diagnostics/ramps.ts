import { TrafficSim, replicateSync } from "../../../../../Front-End-Dashboard/app/dashboard/ai-sandbox/simulation";
const DT = 0.05;
const NO_INT = { closedLanes: [false,false,false,false], closurePoint: 1e9, closureEnd: 1e9,
  incidents: [], speedLimitKmh: null, speedZone: [0,0] } as any;
const ramps = [
  { x: 350, onVehPerHour: 600, offFraction: 0.18, name: "Paso de Blas" },
  { x: 750, onVehPerHour: 400, offFraction: 0.25, name: "Meycauayan" },
];

// 1) do vehicles actually join and leave?
const sim: any = new TrafficSim(
  { length: 1000, laneCount: 4, inflowVehPerHour: 4800, seed: 12345, warmupS: 60, ramps }, NO_INT);
let joined = 0, left = 0;
const seen = new Set<number>();
for (let i = 0; i < 600 / DT; i++) {
  const before = new Map(sim.vehicles.map((v: any) => [v.id, v.x]));
  sim.step(DT);
  for (const v of sim.vehicles) if (!seen.has(v.id)) { seen.add(v.id); if (v.x > 1) joined++; }
  for (const [id, x] of before) if (!sim.vehicles.some((v: any) => v.id === id) && (x as number) < 990) left++;
}
console.log(`ramp joins observed: ${joined}   (expected ~${Math.round((600+400)*600/3600)})`);
console.log(`mid-segment exits:   ${left}`);
const laneMix = [0,1,2,3].map(l => sim.vehicles.filter((v:any)=>v.lane===l).length);
console.log(`lane occupancy L1..L4: ${laneMix.join(", ")}  (exit lane should be busiest)`);

// 2) replications with a confidence interval
const f = (s: any, u: string) => `${s.mean.toFixed(1)} ± ${s.ci95.toFixed(1)} ${u}`;
console.log("\n--- 10 replications, no closure ---");
const base = replicateSync({ length: 1000, laneCount: 4, inflowVehPerHour: 4800, warmupS: 60, ramps },
  NO_INT, { runs: 10, secondsPerRun: 300 });
console.log(`  speed      ${f(base.avgSpeedKmh, "km/h")}`);
console.log(`  throughput ${f(base.throughputPerMin, "/min")}`);
console.log(`  unmet      ${f(base.unmetVehPerHour, "veh/h")}`);

console.log("\n--- 10 replications, L2 closed ---");
const closed = replicateSync({ length: 1000, laneCount: 4, inflowVehPerHour: 4800, warmupS: 60, ramps },
  { ...NO_INT, closedLanes: [false,true,false,false], closurePoint: 600, closureEnd: 800 },
  { runs: 10, secondsPerRun: 300 });
console.log(`  speed      ${f(closed.avgSpeedKmh, "km/h")}`);
console.log(`  throughput ${f(closed.throughputPerMin, "/min")}`);
const d = closed.avgSpeedKmh.mean - base.avgSpeedKmh.mean;
const se = Math.sqrt(base.avgSpeedKmh.ci95 ** 2 + closed.avgSpeedKmh.ci95 ** 2);
console.log(`\n  effect of the closure on speed: ${d.toFixed(1)} ± ${se.toFixed(1)} km/h  ` +
  `→ ${Math.abs(d) > se ? "SIGNIFICANT" : "not distinguishable from noise"}`);
