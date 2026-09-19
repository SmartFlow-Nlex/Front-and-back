import { TrafficSim } from "../../../../../Front-End-Dashboard/app/dashboard/ai-sandbox/simulation";
const DT = 0.05;
const sim: any = new TrafficSim(
  { length: 1000, laneCount: 4, inflowVehPerHour: 9600, seed: 12345, warmupS: 120 },
  { closedLanes: [false,false,false,false], closurePoint: 1e9, closureEnd: 1e9,
    incidents: [], speedLimitKmh: null, speedZone: [0,0] } as any);
let ok = 0, fail = 0;
const realSpawn = sim.spawn.bind(sim);
sim.spawn = (lane: number, c: any) => { const r = realSpawn(lane, c); if (r) ok++; else fail++; return r; };
let maxAcc = 0;
for (let i = 0; i < 600 / DT; i++) { sim.step(DT); maxAcc = Math.max(maxAcc, sim.spawnAccumulator); }
console.log(`demand 9600 veh/h over 600 s = ${(9600*600/3600).toFixed(0)} vehicles wanted`);
console.log(`spawn() calls: ${ok} placed, ${fail} refused  (${(ok/(ok+fail)*100).toFixed(0)}% placed)`);
console.log(`spawnAccumulator peaked at ${maxAcc.toFixed(1)}  (backlog waiting to enter)`);
console.log(`on road now: ${sim.vehicles.length}`);
const byLane = [0,1,2,3].map(l => sim.vehicles.filter((v:any)=>v.lane===l).length);
console.log(`lane occupancy L1..L4: ${byLane.join(", ")}`);
const entry = [0,1,2,3].map(l => {
  const xs = sim.vehicles.filter((v:any)=>v.lane===l).map((v:any)=>v.x);
  return xs.length ? Math.min(...xs).toFixed(1) : "-";
});
console.log(`nearest vehicle to the entrance, per lane: ${entry.join(", ")} m`);
