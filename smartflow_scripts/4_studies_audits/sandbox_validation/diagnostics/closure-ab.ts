import { TrafficSim } from "../../../../../Front-End-Dashboard/app/dashboard/ai-sandbox/simulation";

const DT = 0.05, SECS = 600;

function run(lockstep: boolean, seed: number) {
  const sim: any = new TrafficSim(
    { length: 1000, laneCount: 4, inflowVehPerHour: 4800, seed },
    { closedLanes: [false, true, false, false], closurePoint: 600, closureEnd: 800,
      incidents: [], speedLimitKmh: null, speedZone: [0, 0] } as any,
  );
  let merges = 0, stuck = 0, samples = 0;
  const prevLane = new Map<any, number>();
  for (let i = 0; i < SECS / DT; i++) {
    // "lockstep" arm reproduces the old behaviour: every driver re-evaluates
    // on every tick, with no cadence of their own.
    if (lockstep) for (const v of sim.vehicles) { v.scanSec = 0; v.scanTimer = 0; }
    sim.step(DT);
    for (const v of sim.vehicles) {
      const p = prevLane.get(v);
      if (p !== undefined && p !== v.lane) merges++;
      prevLane.set(v, v.lane);
    }
    const live = new Set(sim.vehicles);
    for (const k of prevLane.keys()) if (!live.has(k)) prevLane.delete(k);
    if (i % 20 === 0) { // once a sim-second
      samples++;
      // vehicles trapped in the closed lane at the taper, barely moving
      stuck += sim.vehicles.filter((v: any) => v.lane === 1 && v.x > 500 && v.x < 600 && v.v < 2).length;
    }
  }
  const m = sim.metrics();
  return { merges, stuckAvg: stuck / samples, speed: m.avgSpeedKmh, thru: m.throughputPerMin, queue: m.longestQueueM };
}

const seeds = [12345, 777, 2024, 90210, 31337];
for (const arm of [true, false]) {
  const rs = seeds.map((s) => run(arm, s));
  const avg = (f: (r: any) => number) => (rs.reduce((p, r) => p + f(r), 0) / rs.length);
  console.log(
    `${arm ? "lockstep (old) " : "own cadence   "}  merges=${avg(r=>r.merges).toFixed(0).padStart(4)}` +
    `  stuck-at-taper=${avg(r=>r.stuckAvg).toFixed(2)}` +
    `  speed=${avg(r=>r.speed).toFixed(1)}km/h` +
    `  thru=${avg(r=>r.thru).toFixed(1)}/min` +
    `  queue=${avg(r=>r.queue).toFixed(0)}m`,
  );
}
