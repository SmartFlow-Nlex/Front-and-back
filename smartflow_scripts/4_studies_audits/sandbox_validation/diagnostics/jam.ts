import { TrafficSim } from "../../../../../Front-End-Dashboard/app/dashboard/ai-sandbox/simulation";
const DT = 0.05;
for (const perLane of [2400, 3000]) {
  const sim: any = new TrafficSim(
    { length: 1000, laneCount: 4, inflowVehPerHour: perLane * 4, seed: 12345, warmupS: 120 },
    { closedLanes: [false,false,false,false], closurePoint: 1e9, closureEnd: 1e9,
      incidents: [], speedLimitKmh: null, speedZone: [0,0] } as any);
  let overlapTicks = 0, worst = 0, ticks = 0, negX = 0;
  for (let i = 0; i < 600 / DT; i++) {
    sim.step(DT); ticks++;
    negX += sim.vehicles.filter((v:any)=>v.x < -0.01).length;
    let bad = false;
    for (let l = 0; l < 4; l++) {
      const row = sim.vehicles.filter((v:any)=>v.lane===l).sort((a:any,b:any)=>a.x-b.x);
      for (let k = 1; k < row.length; k++) {
        const gap = row[k].x - row[k].length - row[k-1].x;
        if (gap < -0.01) { worst = Math.min(worst, gap); bad = true; }
      }
    }
    if (bad) overlapTicks++;
  }
  const m = sim.metrics();
  console.log(`demand ${perLane}/lane:  overlaps ${(overlapTicks/ticks*100).toFixed(1)}% of ticks  worst=${worst.toFixed(2)}m  ` +
    `negative-x vehicle-ticks=${negX}  density=${m.densityPerKmLane.toFixed(0)}/km/lane  n=${sim.vehicles.length}`);
}
