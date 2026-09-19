import { TrafficSim } from "../../../../../Front-End-Dashboard/app/dashboard/ai-sandbox/simulation";
const DT = 0.05, CP = 600;
function run(seed: number) {
  const sim: any = new TrafficSim(
    { length: 1000, laneCount: 4, inflowVehPerHour: 4800, seed },
    { closedLanes: [false, true, false, false], closurePoint: CP, closureEnd: 800,
      incidents: [], speedLimitKmh: null, speedZone: [0, 0] } as any,
  );
  let stalledTicks = 0, overlapTicks = 0, worst = 0, ticks = 0;
  const dwell = new Map<any, number>(); const dwells: number[] = [];
  for (let i = 0; i < 600 / DT; i++) {
    sim.step(DT); ticks++;
    // TRAPPED = stopped, in the closed lane, upstream of the taper. Excludes
    // traffic downstream of the works, which the previous metric wrongly counted.
    const trapped = sim.vehicles.filter((v: any) => v.lane === 1 && v.x < CP + 1 && v.x > CP - 120 && v.v < 1);
    stalledTicks += trapped.length;
    for (const v of trapped) dwell.set(v, (dwell.get(v) ?? 0) + DT);
    for (const [k, d] of dwell) if (!trapped.includes(k)) { dwells.push(d); dwell.delete(k); }
    for (let l = 0; l < 4; l++) {
      const row = sim.vehicles.filter((v: any) => v.lane === l).sort((a: any, b: any) => a.x - b.x);
      for (let k = 1; k < row.length; k++) {
        const gap = row[k].x - row[k].length - row[k - 1].x;
        if (gap < -0.01) { worst = Math.min(worst, gap); overlapTicks++; l = 4; break; }
      }
    }
  }
  const d = [...dwells, ...dwell.values()].sort((a, b) => a - b);
  return { stalled: stalledTicks / ticks, overlapPct: overlapTicks / ticks * 100, worst,
           maxDwell: d[d.length - 1] ?? 0, p95: d[Math.floor(d.length * 0.95)] ?? 0 };
}
const rs = [12345, 777, 2024, 90210, 31337].map(run);
const avg = (f: (r: any) => number) => rs.reduce((p, r) => p + f(r), 0) / rs.length;
console.log(`stalled in closed lane at taper: mean=${avg(r=>r.stalled).toFixed(2)} vehicles`);
console.log(`  worst single wait: p95=${avg(r=>r.p95).toFixed(1)}s  max=${avg(r=>r.maxDwell).toFixed(1)}s`);
console.log(`overlaps (any lane): ${avg(r=>r.overlapPct).toFixed(2)}% of ticks  worst=${Math.min(...rs.map(r=>r.worst)).toFixed(2)} m`);
