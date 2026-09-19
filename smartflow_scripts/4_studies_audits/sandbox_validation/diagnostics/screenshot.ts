import { TrafficSim } from "../../../../../Front-End-Dashboard/app/dashboard/ai-sandbox/simulation";
const DT = 0.05;
// The screenshot's scenario: Km 3.29-11.73 NB, 8.44 km, 4 lanes, 19:00.
const ramps = [
  { x: 150,  onVehPerHour: 200, offFraction: 0, name: "Paso de Blas" },
  { x: 4920, onVehPerHour: 300, offFraction: 0, name: "Meycauayan" },
];
for (const [label, inflow] of [["BEFORE (plaza volume)", 1260], ["AFTER (mainline flow)", 5996]] as [string, number][]) {
  const sim: any = new TrafficSim(
    { length: 8440, laneCount: 4, inflowVehPerHour: inflow, seed: 12345, warmupS: 120, ramps },
    { closedLanes: [false,false,false,false], closurePoint: 1e9, closureEnd: 1e9,
      incidents: [], speedLimitKmh: null, speedZone: [0,0] } as any);
  for (let i = 0; i < 900 / DT; i++) sim.step(DT);
  const m = sim.metrics();
  const occ = [0,1,2,3].map(l => sim.vehicles.filter((v:any)=>v.lane===l).length);
  console.log(`${label}: ${inflow} veh/h`);
  console.log(`  on road ${String(sim.vehicles.length).padStart(4)}   speed ${m.avgSpeedKmh.toFixed(1)} km/h   ` +
    `thru ${m.throughputPerMin.toFixed(0)}/min   density ${m.densityPerKmLane.toFixed(1)}/km/lane`);
  console.log(`  lane occupancy L1..L4: ${occ.map(n=>String(n).padStart(3)).join(" ")}   ` +
    `${occ[0] === 0 && occ[1] === 0 ? "<-- L1+L2 EMPTY" : "all lanes in use"}`);
  console.log(`  unmet demand ${m.unmetVehPerHour.toFixed(0)} veh/h`);
}
