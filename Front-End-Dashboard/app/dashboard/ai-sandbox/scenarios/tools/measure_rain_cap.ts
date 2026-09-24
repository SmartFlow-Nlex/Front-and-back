/**
 * What a whole-segment speed cap does to the engine's capacity and average speed — the measurement quoted in
 * ASSUMPTIONS.RAIN_SPEED_KMH's evidence. Read-only use of simulation.ts; nothing is written anywhere.
 *
 *   cd Back-End
 *   ./node_modules/.bin/tsx ../Front-End-Dashboard/app/dashboard/ai-sandbox/scenarios/tools/measure_rain_cap.ts
 *
 * Method: 4 lanes, 1 km, no ramps, 60 s warm-up, 1,500 simulated seconds, statistics averaged over samples taken
 * every 10 s from t = 900 s, three seeds. Demand is per lane: 1,500 veh/h (busy, not saturated, so the cap acts
 * on speed) and 3,000 veh/h (saturating, so admitted flow is the road's capacity as the engine sees it). The
 * caps are the rain caps in ASSUMPTIONS, plus 90 / 75 / 60 (the invented values they replaced) for reference,
 * against no cap. Takes about a minute.
 */
import { TrafficSim } from "../../simulation";
import { ASSUMPTIONS } from "../assumptions";

const DT = 0.05;
const RUN_S = 1500;
const SAMPLE_FROM_S = 900;
const SEEDS = [11, 23, 37];
const LANES = 4;
const LENGTH_M = 1000;
const rain = ASSUMPTIONS.RAIN_SPEED_KMH.value;
const CAPS: readonly (number | null)[] = [null, ...new Set([rain.light, rain.moderate, rain.heavy]), 90, 75, 60];

type Reading = { readonly flowPerLane: number; readonly speedKmh: number };

function measure(perLaneDemand: number, capKmh: number | null): Reading {
  let flow = 0;
  let speed = 0;
  for (const seed of SEEDS) {
    const inflow = perLaneDemand * LANES;
    const sim = new TrafficSim(
      { length: LENGTH_M, laneCount: LANES, inflowVehPerHour: inflow, seed, warmupS: 60 },
      capKmh === null ? {} : { speedLimitKmh: capKmh, speedZone: [0, LENGTH_M] },
    );
    let next = SAMPLE_FROM_S;
    let unmet = 0;
    let speeds = 0;
    let n = 0;
    for (let i = 0; i < Math.round(RUN_S / DT); i++) {
      sim.step(DT);
      if (sim.time >= next) {
        const m = sim.metrics();
        unmet += m.unmetVehPerHour;
        speeds += m.avgSpeedKmh;
        n++;
        next += 10;
      }
    }
    flow += (inflow - unmet / n) / LANES;
    speed += speeds / n;
  }
  return { flowPerLane: flow / SEEDS.length, speedKmh: speed / SEEDS.length };
}

for (const perLane of [1500, 3000]) {
  console.log(`\ndemand ${perLane} veh/h/lane, ${LANES} lanes`);
  console.log("cap km/h | admitted veh/h/lane | avg km/h | vs no cap (flow, speed)");
  let base: Reading | null = null;
  for (const cap of CAPS) {
    const r = measure(perLane, cap);
    if (cap === null) base = r;
    const pct = (a: number, b: number): string => `${(((a - b) / b) * 100).toFixed(1)}%`;
    const versus = base === null || cap === null ? "" : `${pct(r.flowPerLane, base.flowPerLane)}, ${pct(r.speedKmh, base.speedKmh)}`;
    console.log(`${String(cap ?? "none").padStart(8)} | ${r.flowPerLane.toFixed(0).padStart(19)} | ${r.speedKmh.toFixed(1).padStart(8)} | ${versus}`);
  }
}
