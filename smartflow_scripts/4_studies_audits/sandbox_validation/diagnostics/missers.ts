import { TrafficSim } from "../../../../../Front-End-Dashboard/app/dashboard/ai-sandbox/simulation";
const DT = 0.05;
const ramps = [{ x: 350, onVehPerHour: 600, offFraction: 0.18, name: "A" },
               { x: 750, onVehPerHour: 400, offFraction: 0.25, name: "B" }];
const sim: any = new TrafficSim(
  { length: 1000, laneCount: 4, inflowVehPerHour: 4800, seed: 12345, warmupS: 60, ramps },
  { closedLanes:[false,false,false,false], closurePoint:1e9, closureEnd:1e9,
    incidents:[], speedLimitKmh:null, speedZone:[0,0] } as any);
const missLane = [0,0,0,0]; let made = 0;
const spawnLane = new Map<number, number>();
const missSpawnLane = [0,0,0,0];
for (let i = 0; i < 600 / DT; i++) {
  const before = new Map(sim.vehicles.map((v:any)=>[v.id, {x:v.x, lane:v.lane, e:v.exitAtX}]));
  for (const v of sim.vehicles) if (!spawnLane.has(v.id)) spawnLane.set(v.id, v.lane);
  sim.step(DT);
  for (const v of sim.vehicles) {
    const b = before.get(v.id);
    if (b && b.e === 350 && v.exitAtX !== 350) { missLane[b.lane]++; missSpawnLane[spawnLane.get(v.id) ?? 0]++; }
  }
  for (const [id, b] of before)
    if (!sim.vehicles.some((v:any)=>v.id===id) && Math.abs(b.x-350) < 30) made++;
}
console.log(`made the exit: ${made}`);
console.log(`missed, by the lane they were in at the ramp:  L1=${missLane[0]} L2=${missLane[1]} L3=${missLane[2]} L4=${missLane[3]}`);
console.log(`missed, by the lane they ENTERED the road in:  L1=${missSpawnLane[0]} L2=${missSpawnLane[1]} L3=${missSpawnLane[2]} L4=${missSpawnLane[3]}`);
const occ = [0,1,2,3].map(l => sim.vehicles.filter((v:any)=>v.lane===l).length);
console.log(`lane occupancy now L1..L4: ${occ.join(", ")}`);
