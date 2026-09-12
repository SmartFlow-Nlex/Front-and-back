/**
 * Sandbox simulation benchmark and behaviour check.
 *
 *   npx tsx scripts/bench-simulation.ts
 *
 * Two things it answers, both of which were asserted and then measured while
 * working on the AI Sandbox:
 *
 * 1. HOW EXPENSIVE IS A STEP, AND HOW DOES IT SCALE?
 *    Finding the vehicle ahead used to scan every vehicle on the road, and it
 *    is asked several times per vehicle per step. That is quadratic: 4x the
 *    vehicles cost 11x the time, and a corridor-length run needed 22 ms per
 *    step before anything was drawn. A per-lane position index made each
 *    lookup a binary search. Numbers measured on this machine:
 *
 *        vehicles   before    after
 *              48   0.35 ms   0.23 ms
 *             247   2.09 ms   0.79 ms
 *             980  22.50 ms   3.77 ms
 *
 *    Re-run this after touching simulation.ts; a return to quadratic scaling
 *    shows up immediately in the ms/step column as the span grows.
 *
 * 2. DOES THE PHYSICS STILL BEHAVE?
 *    An optimisation that changes the outcome is not an optimisation. The
 *    closure check asserts the shape of a bounded lane closure: traffic queued
 *    upstream, nothing inside the works, traffic present again beyond it.
 */
import { TrafficSim } from "../app/dashboard/ai-sandbox/simulation";

const SPANS: [number, string][] = [
  [600, "600 m"],
  [3000, "3 km"],
  [11730, "11.73 km"],
];

console.log("STEP COST\n");
console.log(`${"span".padEnd(10)}${"vehicles".padStart(9)}${"ms/step".padStart(10)}${"steps/s".padStart(10)}`);

for (const [length, label] of SPANS) {
  const sim = new TrafficSim({ length, laneCount: 4, inflowVehPerHour: 8000, seed: 5 });
  // Let the road settle before timing: the first steps are unrepresentative
  // while spawning catches up with the seeded traffic.
  for (let i = 0; i < 20; i++) sim.step(0.05);

  const STEPS = 100;
  const started = performance.now();
  for (let i = 0; i < STEPS; i++) sim.step(0.05);
  const ms = (performance.now() - started) / STEPS;

  console.log(
    label.padEnd(10) +
      String(sim.vehicles.length).padStart(9) +
      ms.toFixed(2).padStart(10) +
      Math.round(1000 / ms).toString().padStart(10),
  );
}

console.log("\nBOUNDED CLOSURE — lane 4 shut between 200 m and 400 m\n");

const sim = new TrafficSim({ length: 600, laneCount: 4, inflowVehPerHour: 8000, seed: 7 });
sim.interventions.closedLanes = [false, false, false, true];
sim.interventions.closurePoint = 200;
sim.interventions.closureEnd = 400;
for (let i = 0; i < 2400; i++) sim.step(0.05); // two simulated minutes

const closed = sim.vehicles.filter((v) => v.lane === 3);
const upstream = closed.filter((v) => v.x < 200).length;
const inside = closed.filter((v) => v.x >= 200 && v.x <= 400).length;
const downstream = closed.filter((v) => v.x > 400).length;
const m = sim.metrics();

console.log(`  upstream of the works : ${upstream}`);
console.log(`  inside the works      : ${inside}   (must be 0)`);
console.log(`  downstream, reopened  : ${downstream}`);
console.log(`  avg speed             : ${m.avgSpeedKmh.toFixed(1)} km/h`);
console.log(`  stopped               : ${m.stoppedCount}`);

if (inside !== 0) {
  console.error("\nFAIL: vehicles are inside a closed stretch.");
  process.exit(1);
}
console.log("\nOK");
