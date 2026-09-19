import { TrafficSim } from "../../../../../Front-End-Dashboard/app/dashboard/ai-sandbox/simulation";

const DT = 0.05;
const sim: any = new TrafficSim(
  { length: 1000, laneCount: 4, inflowVehPerHour: 5200, seed: 12345 },
  { closedLanes: [false, false, false, false], closurePoint: 1e9, closureEnd: 1e9,
    incidents: [], speedLimitKmh: null, speedZone: [0, 0] } as any,
);

// Watch lane changes: record when laneShift resets to 0 and when it reaches 1.
const started = new Map<any, { t: number; cls: number }>();
const durations: Record<number, number[]> = { 1: [], 2: [], 3: [] };
let prev = new Map<any, number>();

for (let step = 0; step < 6000; step++) {   // 300 s
  sim.step(DT);
  const t = sim.time;
  for (const v of sim.vehicles) {
    const before = prev.get(v);
    if (before !== undefined && before >= 1 && v.laneShift < 1) started.set(v, { t, cls: v.vClass });
    if (before !== undefined && before < 1 && v.laneShift >= 1) {
      const s = started.get(v);
      if (s) { durations[s.cls].push(t - s.t); started.delete(v); }
    }
    prev.set(v, v.laneShift);
  }
  const live = new Set(sim.vehicles);
  for (const k of prev.keys()) if (!live.has(k)) { prev.delete(k); started.delete(k); }
}

const stat = (a: number[]) => {
  if (!a.length) return "no samples";
  const s = [...a].sort((x, y) => x - y);
  const mean = a.reduce((p, c) => p + c, 0) / a.length;
  const sd = Math.sqrt(a.reduce((p, c) => p + (c - mean) ** 2, 0) / a.length);
  return `n=${String(a.length).padStart(4)}  mean=${mean.toFixed(2)}s  sd=${sd.toFixed(2)}  min=${s[0].toFixed(2)}  max=${s[s.length-1].toFixed(2)}`;
};

console.log("=== LANE-CHANGE CROSSING TIME, by class ===");
for (const c of [1, 2, 3]) console.log(`  class ${c}: ${stat(durations[c])}`);

console.log("\n=== DRIVER HETEROGENEITY (live fleet) ===");
const vs = sim.vehicles;
const col = (f: (v: any) => number) => {
  const a = vs.map(f);
  const mean = a.reduce((p: number, c: number) => p + c, 0) / a.length;
  const sd = Math.sqrt(a.reduce((p: number, c: number) => p + (c - mean) ** 2, 0) / a.length);
  const s = [...a].sort((x: number, y: number) => x - y);
  return `mean=${mean.toFixed(2)} sd=${sd.toFixed(2)} (cv=${(sd/mean*100).toFixed(0)}%) p5=${s[Math.floor(a.length*0.05)].toFixed(2)} p95=${s[Math.floor(a.length*0.95)].toFixed(2)}`;
};
console.log(`  n live            ${vs.length}`);
console.log(`  desired v0 (km/h) ${col((v:any)=>v.v0*3.6)}`);
console.log(`  actual   v (km/h) ${col((v:any)=>v.v*3.6)}`);
console.log(`  headway  T (s)    ${col((v:any)=>v.T)}`);
console.log(`  aMax (m/s2)       ${col((v:any)=>v.aMax)}`);
console.log(`  politeness        ${col((v:any)=>v.politeness)}`);
console.log(`  lcSec (s)         ${col((v:any)=>v.lcSec)}`);

console.log("\n=== SPEED SPREAD WITHIN CLASS 1 (are cars all identical?) ===");
const c1 = vs.filter((v:any)=>v.vClass===1).map((v:any)=>v.v*3.6).sort((a:number,b:number)=>a-b);
console.log(`  n=${c1.length} slowest=${c1[0]?.toFixed(1)} p25=${c1[Math.floor(c1.length*0.25)]?.toFixed(1)} median=${c1[Math.floor(c1.length*0.5)]?.toFixed(1)} p75=${c1[Math.floor(c1.length*0.75)]?.toFixed(1)} fastest=${c1[c1.length-1]?.toFixed(1)}`);
