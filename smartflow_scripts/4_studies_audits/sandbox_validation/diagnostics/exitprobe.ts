import { TrafficSim } from "../../../../../Front-End-Dashboard/app/dashboard/ai-sandbox/simulation";
const DT = 0.05;
const ramps = [{ x: 350, onVehPerHour: 600, offFraction: 0.18, name: "A" },
               { x: 750, onVehPerHour: 400, offFraction: 0.25, name: "B" }];
const sim: any = new TrafficSim(
  { length: 1000, laneCount: 4, inflowVehPerHour: 4800, seed: 12345, warmupS: 60, ramps },
  { closedLanes:[false,false,false,false], closurePoint:1e9, closureEnd:1e9,
    incidents:[], speedLimitKmh:null, speedZone:[0,0] } as any);
let assigned350 = 0, took350 = 0, missed350 = 0;
const known = new Map<number, number | null>();
for (const v of sim.vehicles) known.set(v.id, v.exitAtX);
for (let i = 0; i < 600 / DT; i++) {
  const before = new Map(sim.vehicles.map((v:any)=>[v.id, {x:v.x, lane:v.lane, e:v.exitAtX}]));
  sim.step(DT);
  for (const v of sim.vehicles) {
    if (!known.has(v.id)) { known.set(v.id, v.exitAtX); if (v.exitAtX === 350) assigned350++; }
    const b = before.get(v.id);
    if (b && b.e === 350 && v.exitAtX !== 350 && v.x >= 350) missed350++;
  }
  for (const [id, b] of before) if (!sim.vehicles.some((v:any)=>v.id===id) && Math.abs(b.x-350)<30) took350++;
}
console.log(`assigned to ramp@350: ${assigned350}`);
console.log(`  took it:  ${took350}`);
console.log(`  missed:   ${missed350}  (${(missed350/Math.max(1,assigned350)*100).toFixed(0)}% of assigned)`);
const inLane3 = sim.vehicles.filter((v:any)=>v.lane===3).length;
console.log(`currently in the exit lane: ${inLane3} of ${sim.vehicles.length}`);
