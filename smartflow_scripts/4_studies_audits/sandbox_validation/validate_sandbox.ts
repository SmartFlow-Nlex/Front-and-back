/**
 * AI Sandbox - calibration and validation harness.
 *
 * WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT
 * =================================================
 *
 * The microsimulation behind the AI Sandbox is calibrated on the DEMAND side
 * against gold.fact_traffic_hourly: real hourly volume per interchange per
 * direction, split by vehicle class, over four years. That part is exact -
 * the simulation is fed the corridor's own numbers.
 *
 * It is NOT validated against observed SPEED, because the warehouse does not
 * contain a corridor operating-speed series. This was checked before the
 * harness was written, and every candidate failed:
 *
 *   public.fact_hourly_jams.avg_speed_kmh        7-11 km/h at EVERY hour.
 *   gold.daily_traffic_volume.avg_speed_kmh      mean 8.5, range 1.1-14.1.
 *   gold.ml_weather_speed_forecast.actual_*      mean 8.1, range 1.2-10.4.
 *       All three are speeds measured INSIDE reported jams, not the speed of
 *       the corridor. A motorway does not average 8 km/h at 03:00.
 *
 *   silver.nlex_traffic_volume_clean.avg_speed_kmh
 *       Mean 5.2 km/h, minimum -5 (negative), and 20.6% of the column is <= 0.
 *       Correlation with volume is +0.139 - the WRONG SIGN for a fundamental
 *       diagram, where speed must fall as flow approaches capacity. It rises,
 *       because more traffic produces more jam reports, which is what the
 *       column is really measuring.
 *
 *   bronze.waze_hourly_irregularities.avg_regular_speed_kmh
 *       p50 = 120.9, p85 = 121.0, p95 = 121.0. A constant, i.e. a posted
 *       reference speed, not a measurement. Its avg_speed_kmh companion is
 *       all zeros.
 *
 * Fabricating a speed validation from any of these would produce a chart that
 * looked like evidence and was not. So the speed side is checked against
 * published capacity ranges instead, and the gap is stated as a limitation.
 * Closing it needs loop-detector, probe or toll-transaction travel-time data
 * that the warehouse does not currently hold.
 *
 * Run from the Back-End directory, which owns the tsx and pg installs:
 *   cd Back-End
 *   ./node_modules/.bin/tsx ../smartflow_scripts/4_studies_audits/sandbox_validation/validate_sandbox.ts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
// Resolved through Back-End's install rather than by bare name: this script
// lives outside any package, so a bare "pg" is not resolvable from here.
import { Pool } from "../../../../Back-End/node_modules/pg/lib/index.js";
import {
  replicateSync,
  type ReplicationResult,
} from "../../../../Front-End-Dashboard/app/dashboard/ai-sandbox/simulation";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(HERE, "../../../../Back-End/.env");

/** Reads Back-End/.env directly so this can live outside the server tree. */
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv();
const pool = new Pool(
  env.POSTGRES_URL
    ? {
        connectionString: env.POSTGRES_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 20000,
      }
    : {
        host: env.PG_HOST,
        port: Number(env.PG_PORT || 5432),
        database: env.PG_DATABASE,
        user: env.PG_USER,
        password: env.PG_PASSWORD,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 20000,
      },
);

/* Published freeway capacity, for the one speed-side comparison that can be
 * made honestly. HCM 6th edition: basic freeway segments, and short-term
 * freeway work zones. Passenger-car equivalents per hour per lane. */
const HCM_BASIC_LO = 2000;
const HCM_BASIC_HI = 2400;
const HCM_WORKZONE_LO = 1400;
const HCM_WORKZONE_HI = 1600;

/* Passenger-car equivalent for a heavy vehicle, HCM level terrain. The
 * published capacities are in PASSENGER-CAR equivalents per hour per lane;
 * the simulation counts actual vehicles. Comparing the two directly — which
 * the first version of this harness did — flatters the simulation by however
 * much freight is in the mix, which at 02:00 on this corridor is a third of
 * it. The simulation already models trucks as long and slow, so their effect
 * on flow is in the veh/h figure; the conversion below only restates that
 * figure in the units the published range is quoted in. */
const PCE_HEAVY = 1.5;

/** veh/h -> pc/h for a given heavy-vehicle share. */
const toPcPerHour = (vehPerHour: number, heavyShare: number) =>
  vehPerHour * (1 + heavyShare * (PCE_HEAVY - 1));

const NO_INT = {
  closedLanes: [false, false, false, false],
  closurePoint: 1e9,
  closureEnd: 1e9,
  incidents: [],
  speedLimitKmh: null,
  speedZone: [0, 0] as [number, number],
};

type Hour = { hour: number; vehPerHour: number; mix: Record<1 | 2 | 3, number> };

async function demandProfile(exit: string, direction: string): Promise<Hour[]> {
  const r = await pool.query(
    `SELECT hour, AVG(total)::float v, AVG(class_1)::float c1,
            AVG(class_2)::float c2, AVG(class_3)::float c3
     FROM gold.fact_traffic_hourly
     WHERE exit_canonical = $1 AND direction IS NOT DISTINCT FROM $2 AND total IS NOT NULL
     GROUP BY hour ORDER BY hour`,
    [exit, direction],
  );
  return r.rows.map((x: Record<string, unknown>) => {
    const c1 = Number(x.c1) || 0;
    const c2 = Number(x.c2) || 0;
    const c3 = Number(x.c3) || 0;
    const s = c1 + c2 + c3;
    return {
      hour: Number(x.hour),
      vehPerHour: Math.round(Number(x.v) || 0),
      // Corridor default when an hour has volume but no class split, rather
      // than handing the simulation an empty fleet.
      mix: s > 0 ? { 1: c1 / s, 2: c2 / s, 3: c3 / s } : { 1: 0.781, 2: 0.13, 3: 0.089 },
    } as Hour;
  });
}

const LANES = 4;
const LENGTH = 1000;
const RUNS = 5;
const SECS = 300;

function run(
  vehPerHour: number,
  mix: Record<1 | 2 | 3, number>,
  closed: boolean,
): ReplicationResult {
  return replicateSync(
    {
      length: LENGTH,
      laneCount: LANES,
      inflowVehPerHour: vehPerHour,
      warmupS: 90,
      classProfile: { 1: { share: mix[1] }, 2: { share: mix[2] }, 3: { share: mix[3] } },
    },
    closed
      ? { ...NO_INT, closedLanes: [false, true, false, false], closurePoint: 600, closureEnd: 800 }
      : NO_INT,
    { runs: RUNS, secondsPerRun: SECS },
  );
}

const pad = (n: number | string, w: number) => String(n).padStart(w);

(async () => {
  /* Balintawak deliberately.
   *
   * This harness feeds the plaza's own hourly volume in as the mainline
   * inflow, which is only legitimate at km 0: Balintawak is the corridor's
   * gateway, so everything transacted there IS the through-flow, and nothing
   * has entered or left upstream of it. Anywhere further along the two
   * diverge sharply - at Meycauayan the plaza reads 211 veh/h against a
   * mainline near 3,500 - and the sandbox itself now uses the conservation
   * count in getPlazaFlows() rather than a plaza figure. Validating at km 0
   * keeps this file's inflow exact without needing that machinery. */
  const EXIT = "Balintawak";
  const DIR = "NB";
  const hours = await demandProfile(EXIT, DIR);
  await pool.end();
  if (hours.length === 0) {
    console.log("No demand data for " + EXIT + " " + DIR + ".");
    return;
  }

  const vols = hours.map((h) => h.vehPerHour);
  const mean = vols.reduce((a, b) => a + b, 0) / vols.length;
  const peak = Math.max(...vols);
  const peakHour = hours[vols.indexOf(peak)];

  console.log("=".repeat(78));
  console.log(
    "AI SANDBOX VALIDATION - " + EXIT + " " + DIR + ", " + LANES + " lanes, " + LENGTH + " m",
  );
  console.log(RUNS + " replications x " + SECS + "s per scenario, 90s warm-up discarded");
  console.log("=".repeat(78));
  console.log("");
  console.log(
    "Observed demand: mean " + Math.round(mean) + " veh/h, peak " + peak +
      " at " + pad(peakHour.hour, 2) + ":00",
  );
  console.log(
    "Peaking factor " + (peak / mean).toFixed(2) +
      "  (the sandbox previously assumed a flat 1.60)",
  );

  console.log("");
  console.log("--- DEMAND REPRODUCTION: can the segment serve each real hour? ---");
  console.log("hour   demand   served +/- ci     speed +/- ci    heavy%   unmet  status");
  let saturated = 0;
  for (const h of hours) {
    const r = run(h.vehPerHour, h.mix, false);
    const served = r.throughputPerMin.mean * 60;
    const servedCi = r.throughputPerMin.ci95 * 60;
    const unmet = r.unmetVehPerHour.mean;
    const heavy = (h.mix[2] + h.mix[3]) * 100;
    /* Both conditions, not just the first. Unmet demand alone produced a
     * false positive at 05:00, where 36 veh/h failed to enter during a brief
     * transient while the hour as a whole still served more than it was
     * asked for: the unmet counter and the throughput window cover different
     * spans, so either on its own can mislead. */
    const atCap = unmet > h.vehPerHour * 0.02 && served < h.vehPerHour * 0.98;
    if (atCap) saturated++;
    console.log(
      pad(h.hour, 2) + ":00 " + pad(h.vehPerHour, 8) + "  " +
        pad(served.toFixed(0), 6) + " +/-" + pad(servedCi.toFixed(0), 3) + "  " +
        pad(r.avgSpeedKmh.mean.toFixed(1), 5) + " +/-" + pad(r.avgSpeedKmh.ci95.toFixed(1), 4) + "  " +
        pad(heavy.toFixed(1), 6) + "%  " + pad(unmet.toFixed(0), 5) + "  " +
        (atCap ? "AT CAPACITY" : "serves demand"),
    );
  }
  console.log("");
  console.log(
    "  " + (24 - saturated) + " of 24 hours served in full; " +
      saturated + " reached the capacity of this segment.",
  );

  console.log("");
  console.log("--- CAPACITY vs PUBLISHED FIGURES (the only speed-side check available) ---");
  // Corridor-average mix, so the PCE conversion below uses the same fleet the
  // capacity was measured with.
  const CORRIDOR_MIX = { 1: 0.781, 2: 0.13, 3: 0.089 } as Record<1 | 2 | 3, number>;
  const corridorHeavy = CORRIDOR_MIX[2] + CORRIDOR_MIX[3];
  let capacity = 0;
  for (const perLane of [1800, 2000, 2200, 2400, 2600, 2800]) {
    const r = run(perLane * LANES, CORRIDOR_MIX, false);
    const served = (r.throughputPerMin.mean * 60) / LANES;
    capacity = Math.max(capacity, served);
    console.log(
      "  demand " + pad(perLane, 4) + "/lane -> served " + pad(served.toFixed(0), 4) +
        " veh/h/lane at " + r.avgSpeedKmh.mean.toFixed(0) + " km/h",
    );
  }
  const capacityPc = toPcPerHour(capacity, corridorHeavy);
  const basicOk = capacityPc >= HCM_BASIC_LO && capacityPc <= HCM_BASIC_HI;
  console.log("");
  console.log("  simulated capacity: " + capacity.toFixed(0) + " veh/h/lane at " +
    (corridorHeavy * 100).toFixed(1) + "% heavy");
  console.log("                   =  " + capacityPc.toFixed(0) + " pc/h/lane (PCE " + PCE_HEAVY + ")");
  console.log(
    "  published (HCM basic freeway): " + HCM_BASIC_LO + "-" + HCM_BASIC_HI + " pc/h/lane",
  );
  console.log("  -> " + (basicOk ? "WITHIN the published range" :
    "OUTSIDE by " + (capacityPc > HCM_BASIC_HI
      ? ((capacityPc / HCM_BASIC_HI - 1) * 100).toFixed(1) + "% above"
      : ((1 - capacityPc / HCM_BASIC_LO) * 100).toFixed(1) + "% below")));

  /* How much of that verdict is the PCE assumption rather than the model.
   *
   * Published editions put a heavy vehicle anywhere between 1.2 and 2.0
   * passenger cars depending on terrain and edition, and at 21.9% freight
   * that choice moves the comparison by more than the discrepancy being
   * judged. Reporting a single verdict off a single assumed E_T would be
   * presenting a decision about units as a result about the model. */
  console.log("");
  console.log("  sensitivity to the PCE assumption (the verdict turns on it):");
  for (const et of [1.2, 1.5, 2.0]) {
    const pc = capacity * (1 + corridorHeavy * (et - 1));
    const verdict =
      pc > HCM_BASIC_HI ? ((pc / HCM_BASIC_HI - 1) * 100).toFixed(1) + "% above"
      : pc < HCM_BASIC_LO ? ((1 - pc / HCM_BASIC_LO) * 100).toFixed(1) + "% below"
      : "within";
    console.log("    E_T = " + et.toFixed(1) + " -> " + pad(pc.toFixed(0), 4) + " pc/h/lane  (" + verdict + ")");
  }

  /* One free parameter, two published bands.
   *
   * Time headway is the only thing tuned here, and it moves both capacities
   * together: bringing the basic figure down into range pushes the work-zone
   * figure below its own. They cannot both be satisfied, which is a real
   * property of this model rather than a setting left wrong, and chasing both
   * with one knob would be fitting to two numbers, not calibrating. */
  console.log("");
  console.log("  NOTE: headway is the single tuned parameter and it moves the basic and");
  console.log("  work-zone capacities together. Pulling the basic figure inside its band");
  console.log("  pushes the work-zone figure below its own, so only one can be satisfied.");
  console.log("  Left where the work-zone check passes, since that is the case the sandbox");
  console.log("  is actually used for. Further tuning would be curve-fitting, not calibration.");

  console.log("");
  console.log("--- WORK-ZONE CAPACITY: one lane of four closed, at the observed peak hour ---");
  const wz = run(peak, peakHour.mix, true);
  const wzPerLane = (wz.throughputPerMin.mean * 60) / (LANES - 1);
  const wzHeavy = peakHour.mix[2] + peakHour.mix[3];
  const wzPc = toPcPerHour(wzPerLane, wzHeavy);
  const wzOk = wzPc >= HCM_WORKZONE_LO && wzPc <= HCM_WORKZONE_HI;
  console.log(
    "  served " + wzPerLane.toFixed(0) + " veh/h/lane through " + (LANES - 1) +
      " open lanes at " + wz.avgSpeedKmh.mean.toFixed(1) +
      " +/- " + wz.avgSpeedKmh.ci95.toFixed(1) + " km/h",
  );
  console.log("             =  " + wzPc.toFixed(0) + " pc/h/lane at " +
    (wzHeavy * 100).toFixed(1) + "% heavy");
  console.log(
    "  published (HCM short-term work zone): " + HCM_WORKZONE_LO + "-" + HCM_WORKZONE_HI + " pc/h/lane",
  );
  console.log("  -> " + (wzOk ? "WITHIN the published range" :
    "OUTSIDE by " + (wzPc > HCM_WORKZONE_HI
      ? ((wzPc / HCM_WORKZONE_HI - 1) * 100).toFixed(1) + "% above"
      : ((1 - wzPc / HCM_WORKZONE_LO) * 100).toFixed(1) + "% below")));

  console.log("");
  console.log("--- CHEAPEST HOUR TO CLOSE A LANE ---");
  console.log("(the operational question the measured demand profile makes answerable)");
  const costs: { hour: number; dSpeed: number; ci: number; dThru: number }[] = [];
  for (const h of hours) {
    const base = run(h.vehPerHour, h.mix, false);
    const shut = run(h.vehPerHour, h.mix, true);
    costs.push({
      hour: h.hour,
      dSpeed: shut.avgSpeedKmh.mean - base.avgSpeedKmh.mean,
      // Two independent means, so the interval on their difference is the
      // root of the sum of squares, not either one alone.
      ci: Math.sqrt(base.avgSpeedKmh.ci95 ** 2 + shut.avgSpeedKmh.ci95 ** 2),
      dThru: (shut.throughputPerMin.mean - base.throughputPerMin.mean) * 60,
    });
  }
  const ranked = [...costs].sort((a, b) => b.dSpeed - a.dSpeed);
  const show = (c: { hour: number; dSpeed: number; ci: number; dThru: number }) =>
    console.log(
      "    " + pad(c.hour, 2) + ":00   " + pad(c.dSpeed.toFixed(1), 6) +
        " +/- " + c.ci.toFixed(1) + " km/h   " + pad(c.dThru.toFixed(0), 7) + " veh/h",
    );
  console.log("  cheapest (least speed lost):");
  ranked.slice(0, 4).forEach(show);
  console.log("  most expensive:");
  ranked.slice(-4).forEach(show);

  console.log("");
  console.log("=".repeat(78));
  console.log("LIMITATION: the warehouse holds no observed corridor speed (see this file's");
  console.log("header for the four columns checked and why each one fails). The speed side");
  console.log("is therefore compared against published capacity ranges, not against NLEX");
  console.log("measurements. Demand is calibrated exactly; speed is bounded, not validated.");
  console.log("=".repeat(78));
})();
