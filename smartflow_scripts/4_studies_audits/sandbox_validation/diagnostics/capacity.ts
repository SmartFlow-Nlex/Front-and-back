import { TrafficSim } from "../../../../../Front-End-Dashboard/app/dashboard/ai-sandbox/simulation";
const DT = 0.05;
// Ramp demand up and find where the road stops delivering it.
console.log("demand/lane   served/lane   speed   density/lane   note");
for (const perLane of [600, 900, 1200, 1500, 1800, 2100, 2400, 3000]) {
  const inflow = perLane * 4;
  const sim: any = new TrafficSim(
    { length: 1000, laneCount: 4, inflowVehPerHour: inflow, seed: 12345, warmupS: 120 },
    { closedLanes: [false,false,false,false], closurePoint: 1e9, closureEnd: 1e9,
      incidents: [], speedLimitKmh: null, speedZone: [0,0] } as any);
  const t0 = performance.now();
  for (let i = 0; i < 900 / DT; i++) sim.step(DT);
  const m = sim.metrics();
  const served = m.throughputPerMin * 60 / 4;
  console.log(
    `${String(perLane).padStart(8)}  ${served.toFixed(0).padStart(11)}   ` +
    `${m.avgSpeedKmh.toFixed(1).padStart(5)}  ${m.densityPerKmLane.toFixed(1).padStart(10)}   ` +
    `${served < perLane * 0.93 ? "DEMAND DROPPED" : ""}  (${((performance.now()-t0)/1000).toFixed(1)}s)`);
}
