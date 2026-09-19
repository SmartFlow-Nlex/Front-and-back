import { TrafficSim } from "../../../../../Front-End-Dashboard/app/dashboard/ai-sandbox/simulation";
const DT = 0.05;
const ramps = [
  { x: 350, onVehPerHour: 600, offFraction: 0.18, name: "Paso de Blas" },
  { x: 750, onVehPerHour: 400, offFraction: 0.25, name: "Meycauayan" },
];
const sim: any = new TrafficSim(
  { length: 1000, laneCount: 4, inflowVehPerHour: 4800, seed: 12345, warmupS: 60, ramps },
  { closedLanes: [false,false,false,false], closurePoint: 1e9, closureEnd: 1e9,
    incidents: [], speedLimitKmh: null, speedZone: [0,0] } as any);
const joinsAt: Record<string, number> = { "350": 0, "750": 0 };
const exitsAt: Record<string, number> = { "350": 0, "750": 0, end: 0 };
const seen = new Set<number>();
for (const v of sim.vehicles) seen.add(v.id);            // prefilled fleet
for (let i = 0; i < 600 / DT; i++) {
  const prev = new Map(sim.vehicles.map((v: any) => [v.id, v.x]));
  sim.step(DT);
  for (const v of sim.vehicles) {
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    // A ramp joiner appears AT the ramp; a mainline spawn appears at x≈0.
    for (const r of ramps) if (Math.abs(v.x - r.x) < 5) joinsAt[String(r.x)]++;
  }
  for (const [id, x] of prev) {
    if (sim.vehicles.some((v: any) => v.id === id)) continue;
    const at = x as number;
    if (at > 990) exitsAt.end++;
    else { let best = "end"; for (const r of ramps) if (Math.abs(at - r.x) < 30) best = String(r.x); exitsAt[best]++; }
  }
}
const want = (vph: number) => Math.round(vph * 600 / 3600);
console.log(`joins  @km0.35: ${joinsAt["350"]} (wanted ~${want(600)})   @km0.75: ${joinsAt["750"]} (wanted ~${want(400)})`);
console.log(`exits  @km0.35: ${exitsAt["350"]}   @km0.75: ${exitsAt["750"]}   ran full length: ${exitsAt.end}`);
const through = exitsAt["350"] + exitsAt["750"] + exitsAt.end;
console.log(`off-ramp share: ${(exitsAt["350"]/through*100).toFixed(0)}% then ${(exitsAt["750"]/(through-exitsAt["350"])*100).toFixed(0)}%  (configured 18% then 25%)`);
