/**
 * Calibrates the AI Sandbox's rain headway factors against the simulation itself.
 *
 * WHY. Rain in the sandbox has two published effects (see RAIN in
 * Front-End-Dashboard/app/dashboard/ai-sandbox/simulation.ts):
 *   - free-flow speed x0.96 / x0.94 / x0.93 (SHRP 2-L08, 65 mi/h column), applied
 *     directly to each driver's desired speed;
 *   - capacity -2.01 / -7.24 / -14.13 % (HCM 2010 Exhibit 10-15 averages), which
 *     the model can only deliver through drivers' time headway.
 *
 * A headway factor solved from the textbook IDM equilibrium undershoots: the full
 * simulation has lane changing, a truck mix and reaction lag, so its saturated
 * discharge falls by only about three-quarters of the target. This script instead
 * bisects each factor until the SIMULATED capacity loss equals the HCM figure.
 *
 * SETUP. 4 lanes, 1 km, 12,000 veh/h offered (well above capacity, so the road is
 * the bottleneck — the unmet demand at the entry confirms it), 180 s warm-up, then
 * throughput averaged over 600 s, over four random seeds per evaluation.
 *
 * RUN (from Front-End-Dashboard):
 *   npx tsx ../smartflow_scripts/4_studies_audits/rain_headway_calibration.mts
 * and copy the printed factors into RAIN[...].headwayFactor.
 */
const { TrafficSim, RAIN } = await import(
  new URL("../../Front-End-Dashboard/app/dashboard/ai-sandbox/simulation.ts", import.meta.url).href
);

const SEEDS = [11, 23, 37, 51];
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function capacity(level: string, seed: number): number {
  const sim = new TrafficSim(
    { length: 1000, laneCount: 4, inflowVehPerHour: 12000, seed, warmupS: 120 },
    { weather: level },
  );
  for (let t = 0; t < 180; t += 0.1) sim.step(0.1);
  let tp = 0;
  let n = 0;
  for (let i = 0; i < 6000; i++) {
    sim.step(0.1);
    if (i % 50 === 0) {
      tp += sim.metrics().throughputPerMin * 60;
      n++;
    }
  }
  return tp / n;
}

const dry = avg(SEEDS.map((s) => capacity("dry", s)));
console.log(`dry capacity ${dry.toFixed(0)} veh/h (4 lanes)`);

const result: Record<string, number> = {};
for (const lvl of ["light", "moderate", "heavy"]) {
  const target = 1 - RAIN[lvl].capacityLossPct / 100;
  let lo = 1.0;
  let hi = 1.7;
  for (let it = 0; it < 8; it++) {
    const k = (lo + hi) / 2;
    RAIN[lvl].headwayFactor = k;
    const ratio = avg(SEEDS.map((s) => capacity(lvl, s))) / dry;
    if (ratio > target) lo = k;
    else hi = k;
  }
  result[lvl] = (lo + hi) / 2;
  RAIN[lvl].headwayFactor = result[lvl];
  const check = avg(SEEDS.map((s) => capacity(lvl, s))) / dry;
  console.log(
    `${lvl.padEnd(9)} headway x${result[lvl].toFixed(3)} -> ${((check - 1) * 100).toFixed(2)}% capacity (HCM ${(-RAIN[lvl].capacityLossPct).toFixed(2)}%)`,
  );
}
console.log("RESULT", JSON.stringify(result));
