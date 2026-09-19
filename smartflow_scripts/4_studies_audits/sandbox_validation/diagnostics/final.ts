import { TrafficSim } from "../../../../../Front-End-Dashboard/app/dashboard/ai-sandbox/simulation";
const DT = 0.05;
function mk(seed: number, closed: boolean) {
  return new TrafficSim(
    { length: 1000, laneCount: 4, inflowVehPerHour: closed ? 4800 : 5200, seed },
    { closedLanes: [false, closed, false, false], closurePoint: 600, closureEnd: 800,
      incidents: [], speedLimitKmh: null, speedZone: [0, 0] } as any,
  ) as any;
}
function run(seed: number, closed: boolean) {
  const sim = mk(seed, closed);
  let heavyInL1 = 0, ticks = 0, overlap = 0;
  const lcDur: Record<number, number[]> = { 1: [], 2: [], 3: [] };
  const started = new Map<any, { t: number; c: number }>(); const prev = new Map<any, number>();
  for (let i = 0; i < 600 / DT; i++) {
    sim.step(DT); ticks++;
    heavyInL1 += sim.vehicles.filter((v: any) => v.lane === 0 && v.vClass !== 1).length;
    for (const v of sim.vehicles) {
      const b = prev.get(v);
      if (b !== undefined && b >= 1 && v.laneShift < 1) started.set(v, { t: sim.time, c: v.vClass });
      if (b !== undefined && b < 1 && v.laneShift >= 1) {
        const st = started.get(v); if (st) { lcDur[st.c].push(sim.time - st.t); started.delete(v); }
      }
      prev.set(v, v.laneShift);
    }
    const live = new Set(sim.vehicles);
    for (const k of prev.keys()) if (!live.has(k)) { prev.delete(k); started.delete(k); }
    for (let l = 0; l < 4; l++) {
      const row = sim.vehicles.filter((v: any) => v.lane === l).sort((a: any, b: any) => a.x - b.x);
      for (let k = 1; k < row.length; k++) if (row[k].x - row[k].length - row[k-1].x < -0.01) { overlap++; l = 4; break; }
    }
  }
  const m = sim.metrics();
  return { heavyInL1: heavyInL1 / ticks, overlapPct: overlap / ticks * 100, lcDur,
           speed: m.avgSpeedKmh, thru: m.throughputPerMin, queue: m.longestQueueM, co2: m.co2RatePerMin };
}
const seeds = [12345, 777, 2024, 90210, 31337];
for (const closed of [false, true]) {
  const rs = seeds.map(s => run(s, closed));
  const avg = (f: (r: any) => number) => rs.reduce((p, r) => p + f(r), 0) / rs.length;
  const all: Record<number, number[]> = { 1: [], 2: [], 3: [] };
  for (const r of rs) for (const c of [1,2,3]) all[c].push(...r.lcDur[c]);
  console.log(`\n--- ${closed ? "L2 CLOSED at km 0.6" : "FREE FLOW (no closure)"} ---`);
  console.log(`  speed=${avg(r=>r.speed).toFixed(1)}km/h  thru=${avg(r=>r.thru).toFixed(1)}/min  queue=${avg(r=>r.queue).toFixed(0)}m  co2=${avg(r=>r.co2).toFixed(2)}kg/min`);
  console.log(`  heavy vehicles in L1 (must be 0 with no closure): ${avg(r=>r.heavyInL1).toFixed(3)} avg`);
  console.log(`  overlaps: ${avg(r=>r.overlapPct).toFixed(2)}% of ticks`);
  for (const c of [1,2,3]) {
    const a = all[c]; if (!a.length) { console.log(`  lane-change class ${c}: none`); continue; }
    const mean = a.reduce((x,y)=>x+y,0)/a.length;
    console.log(`  lane-change class ${c}: n=${String(a.length).padStart(4)} mean=${mean.toFixed(2)}s  range ${Math.min(...a).toFixed(2)}-${Math.max(...a).toFixed(2)}s`);
  }
}
