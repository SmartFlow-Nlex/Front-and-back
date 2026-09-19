import { TrafficSim } from "../../../../../Front-End-Dashboard/app/dashboard/ai-sandbox/simulation";
const DT = 0.05;
const sim: any = new TrafficSim(
  { length: 1000, laneCount: 4, inflowVehPerHour: 9600, seed: 12345, warmupS: 120 },
  { closedLanes: [false,false,false,false], closurePoint: 1e9, closureEnd: 1e9,
    incidents: [], speedLimitKmh: null, speedZone: [0,0] } as any);
for (let i = 0; i < 200 / DT; i++) {
  sim.step(DT);
  if (i % 200 === 0) {  // every 10 s
    const l0 = sim.vehicles.filter((v:any)=>v.lane===0).sort((a:any,b:any)=>a.x-b.x).slice(0,4);
    console.log(`t=${sim.time.toFixed(0).padStart(3)}s  L1 first four: ` +
      l0.map((v:any)=>`x=${v.x.toFixed(1)} v=${(v.v*3.6).toFixed(0)}km/h a=${v.accel.toFixed(2)}`).join(" | "));
  }
}
