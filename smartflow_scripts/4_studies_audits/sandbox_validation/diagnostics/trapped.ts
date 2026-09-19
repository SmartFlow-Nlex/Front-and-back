import { TrafficSim } from "../../../../../Front-End-Dashboard/app/dashboard/ai-sandbox/simulation";
const DT = 0.05, SECS = 600;
function run(lockstep: boolean, seed: number) {
  const sim: any = new TrafficSim(
    { length: 1000, laneCount: 4, inflowVehPerHour: 4800, seed },
    { closedLanes: [false, true, false, false], closurePoint: 600, closureEnd: 800,
      incidents: [], speedLimitKmh: null, speedZone: [0, 0] } as any,
  );
  const enteredClosed = new Map<any, number>(); // vehicle -> sim time it was first in lane 1
  let escaped = 0, reachedTaper = 0; const dwell: number[] = [];
  for (let i = 0; i < SECS / DT; i++) {
    if (lockstep) for (const v of sim.vehicles) { v.scanSec = 0; v.scanTimer = 0; }
    sim.step(DT);
    for (const v of sim.vehicles) {
      if (v.lane === 1 && !enteredClosed.has(v)) enteredClosed.set(v, sim.time);
      if (v.lane !== 1 && enteredClosed.has(v)) {
        dwell.push(sim.time - enteredClosed.get(v)!); escaped++; enteredClosed.delete(v);
      }
      // still in the closed lane AT the taper = it never got out
      if (v.lane === 1 && v.x >= 599) reachedTaper++;
    }
    const live = new Set(sim.vehicles);
    for (const k of enteredClosed.keys()) if (!live.has(k)) enteredClosed.delete(k);
  }
  const d = dwell.sort((a,b)=>a-b);
  return { escaped, reachedTaper, p50: d[Math.floor(d.length*0.5)] ?? 0, p95: d[Math.floor(d.length*0.95)] ?? 0, max: d[d.length-1] ?? 0 };
}
const seeds = [12345, 777, 2024, 90210, 31337];
for (const arm of [true, false]) {
  const rs = seeds.map(s => run(arm, s));
  const avg = (f:(r:any)=>number) => rs.reduce((p,r)=>p+f(r),0)/rs.length;
  console.log(`${arm?"lockstep (old)":"own cadence   "}  escaped-closed-lane=${avg(r=>r.escaped).toFixed(0)}` +
    `  still-in-lane-at-taper(ticks)=${avg(r=>r.reachedTaper).toFixed(0)}` +
    `  dwell p50=${avg(r=>r.p50).toFixed(1)}s p95=${avg(r=>r.p95).toFixed(1)}s max=${avg(r=>r.max).toFixed(1)}s`);
}
