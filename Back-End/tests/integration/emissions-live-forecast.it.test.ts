/* TC-IT-11  Emissions / Total CO2 matches the database
 * TC-IT-12  Overview / Live counts match the live feed
 * TC-IT-13  Traffic / Forecasts come from the forecast tables
 * TC-IT-14  Traffic / Forecast accuracy is scored on archived forecasts
 *
 * 11: GET /api/emissions/analytics -> kpis.totalCo2T; "<gold emissions table>"
 *     = gold.fact_emissions_hourly, column co2_tonnes (the sheet's co2_kg is
 *     compared in tonnes, as the tile shows it).
 * 12: The Overview hero, Live Map and corridor strip all derive their counts in
 *     the browser from GET /api/map-comparison/real-time with
 *     lib/corridor-status.ts (corridorStatusFromFeed + tallyExitStatuses); the
 *     server also serves GET /api/dashboard/corridor-status/full. "<live Waze
 *     table>" = silver.fact_waze_jams (last_seen_at, level, speed_kmh,
 *     nlex_exit_id), 60-minute window.
 * 13: data.congestion of GET /api/traffic/forecast comes from
 *     services/traffic.service.ts getMLPredictiveCongestion(); "<congestion
 *     forecast table>" = gold.ml_congestion_forecast when it has rows, else
 *     gold.ml_predictive_congestion (services/forecast-source.ts).
 * 14: congestion live score (getCongestionLiveScore, view
 *     gold.v_congestion_forecast_score over gold.ml_congestion_forecast_log)
 *     and the volume forecast card's MASE (getMLModelMetrics,
 *     gold.ml_model_metrics). */
import { dbUnavailable, q, closeAll } from "./readonly-db.js";
import { start, stop, get } from "./http.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getMLPredictiveCongestion, getCongestionLiveScore, getMLModelMetrics } from "../../src/services/traffic.service.js";
import { createRequire } from "node:module";

// Front-End-Dashboard has no "type": "module", so its lib files load as CommonJS (tsx handles the TypeScript).
const requireFe = createRequire(import.meta.url);
const { corridorStatusFromFeed, tallyExitStatuses } = requireFe("../../../Front-End-Dashboard/lib/corridor-status.ts");
const { FALLBACK_EXITS } = requireFe("../../../Front-End-Dashboard/lib/nlex-exits.ts");
import { readSource, declaration } from "../support/source-extract.js";
import { nlexStreetSql } from "../../src/utils/nlex-street.js";

const T = { timeout: 300_000 };
before(start);
after(async () => { await stop(); await closeAll(); });

test("TC-IT-11: Total CO2 (Modeled), Q1 2024, equals SUM over gold.fact_emissions_hourly", T, async (t) => {
  const why = await dbUnavailable();
  if (why) return t.skip(why);
  const r = await get(`/api/emissions/analytics?from=2024-01-01&to=2024-03-31`);
  assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  const [s] = await q(`SELECT ROUND(SUM(co2_tonnes)::numeric, 1)::float AS t, (SUM(co2_tonnes) * 1000)::float AS kg
                         FROM gold.fact_emissions_hourly WHERE date BETWEEN '2024-01-01' AND '2024-03-31'`);
  console.log(`  range=${JSON.stringify(r.body.data.range)} page totalCo2T=${r.body.data.kpis.totalCo2T} t; db=${s.t} t (${s.kg} kg)`);
  assert.equal(r.body.data.kpis.totalCo2T, s.t);
});

test("TC-IT-12: Congested/Slow/Clear counts match the live Waze rows of the last 60 minutes", T, async (t) => {
  const why = await dbUnavailable();
  if (why) return t.skip(why);
  const [feed, full] = await Promise.all([get(`/api/map-comparison/real-time`), get(`/api/dashboard/corridor-status/full`)]);
  // Per exit-direction from the table: worst level / slowest speed -> the app's Waze bands.
  const rows = await q(`
    WITH live AS (
      SELECT DISTINCT ON (ST_AsBinary(geom)) nlex_exit_id, level, speed_kmh, ST_LineMerge(geom) AS g
      FROM silver.fact_waze_jams
      WHERE last_seen_at > NOW() - interval '60 minutes' AND geom IS NOT NULL AND corridor_match IN ('ON_CORRIDOR', 'NEAR_CORRIDOR')
        AND ${nlexStreetSql("street")}
      ORDER BY ST_AsBinary(geom), last_seen_at DESC),
    per AS (
      SELECT nlex_exit_id,
             CASE WHEN DEGREES(ST_Azimuth(ST_StartPoint(g), ST_EndPoint(g))) < 90 OR DEGREES(ST_Azimuth(ST_StartPoint(g), ST_EndPoint(g))) > 270 THEN 'NB' ELSE 'SB' END AS dir,
             MAX(level) AS lvl, MIN(speed_kmh) AS spd
      FROM live WHERE GeometryType(g) = 'LINESTRING' AND nlex_exit_id IS NOT NULL GROUP BY 1, 2)
    SELECT CASE WHEN lvl IS NULL AND spd IS NULL THEN 'clear' WHEN lvl = 0 THEN 'clear'
                WHEN lvl >= 3 OR spd < 10 THEN 'congested' ELSE 'slow' END AS status, COUNT(*)::int AS n
    FROM per GROUP BY 1`);
  const [fresh] = await q(`SELECT MAX(last_seen_at) AS newest, COUNT(*) FILTER (WHERE last_seen_at > NOW() - interval '60 minutes')::int AS in_window FROM silver.fact_waze_jams`);
  const db = { congested: 0, slow: 0, ...Object.fromEntries(rows.map((r) => [r.status, r.n])) };
  const statuses = corridorStatusFromFeed(feed.body, FALLBACK_EXITS);
  const overview = tallyExitStatuses(FALLBACK_EXITS, statuses);
  const server = full.body?.data?.counts;
  console.log(`  feed newest=${fresh.newest?.toISOString?.() ?? fresh.newest} rows in window=${fresh.in_window}`);
  console.log(`  overview/live map/strip (browser derivation)=${JSON.stringify(overview)}`);
  console.log(`  /corridor-status/full=${JSON.stringify(server)}`);
  console.log(`  db per exit-direction=${JSON.stringify(db)}`);
  assert.equal(full.status, 200);
  assert.deepEqual(overview, server, "Overview counts equal the server's counts");
  assert.equal(overview.congested, db.congested, "congested exit-directions");
  assert.equal(overview.slow, db.slow, "slow exit-directions");
});

test("TC-IT-13: Predictive Congestion State Map cell (Bocaue) equals the stored forecast", T, async (t) => {
  const why = await dbUnavailable();
  if (why) return t.skip(why);
  const [{ owned }] = await q(`SELECT CASE WHEN to_regclass('gold.ml_congestion_forecast') IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM gold.ml_congestion_forecast) END::int AS owned`);
  const table = owned > 0 ? "gold.ml_congestion_forecast" : "gold.ml_predictive_congestion";
  const rows = (await getMLPredictiveCongestion()) ?? [];
  // The trainer names segments by their exit since October ("Bocaue Barrier"); the test looked for "Bocaue" (2 Nov 2026).
  const cells = rows.filter((r: any) => /^bocaue( barrier)?$/i.test(String(r.segment).trim()));
  assert.ok(cells.length > 0, `no Bocaue cells among ${rows.length} rows`);
  const cell = cells.find((c: any) => Number(c.hours) === 6) ?? cells[0];
  const db = await q(`SELECT congestion_state, probability::float AS probability, p_low::float AS p_low, p_med::float AS p_med, p_high::float AS p_high,
                             to_char(base_ts, 'YYYY-MM-DD HH24:MI') AS base_ts
                        FROM ${table} WHERE segment_name = $1 AND hours_ahead = $2`, [cell.segment, cell.hours]);
  console.log(`  table=${table} page cell=${JSON.stringify({ segment: cell.segment, hours: cell.hours, state: cell.state, probability: cell.probability, baseTs: cell.baseTs })}`);
  console.log(`  db=${JSON.stringify(db)}`);
  assert.equal(db.length, 1);
  assert.equal(cell.state, db[0].congestion_state);
  assert.equal(Number(cell.probability), db[0].probability);
  assert.deepEqual([cell.pLow, cell.pMed, cell.pHigh], [db[0].p_low, db[0].p_med, db[0].p_high]);
  assert.equal(cell.baseTs, db[0].base_ts);
});

test("TC-IT-14: displayed forecast accuracy equals the value recomputed from archived forecasts joined to actuals", T, async (t) => {
  const why = await dbUnavailable();
  if (why) return t.skip(why);
  // (a) Congestion: the live score is computed from the archived forecast log.
  const [{ def }] = await q(`SELECT pg_get_viewdef('gold.v_congestion_forecast_score'::regclass) AS def`);
  const live = (await getCongestionLiveScore()) as { buckets: any[] } | null;
  const recomputed = await q(`
    SELECT CASE WHEN hours_ahead <= 3 THEN '1-3h' WHEN hours_ahead <= 12 THEN '4-12h' ELSE '13-24h' END AS bucket,
           COUNT(*)::int AS n,
           SUM(CASE WHEN argmax_state = actual_state THEN 1 ELSE 0 END)::float / COUNT(*) AS acc
    FROM gold.v_congestion_forecast_score GROUP BY 1`);
  const byBucket = Object.fromEntries(recomputed.map((r) => [r.bucket, r]));
  console.log(`  view reads archived log: ${/ml_congestion_forecast_log/.test(def)}`);
  for (const b of live?.buckets ?? []) console.log(`  congestion ${b.bucket}: page acc=${b.argmax_state_acc} n=${b.n}; recomputed acc=${byBucket[b.bucket]?.acc} n=${byBucket[b.bucket]?.n}`);
  assert.match(def, /ml_congestion_forecast_log/);
  assert.ok(live && live.buckets.length > 0, "no scored archived forecasts yet");
  for (const b of live.buckets) {
    assert.equal(b.n, byBucket[b.bucket].n);
    assert.ok(Math.abs(b.argmax_state_acc - byBucket[b.bucket].acc) < 1e-9);
  }
});

test("TC-IT-14 (volume card): the card's MASE is the stored held-out score, and no actuals exist yet to score archived forecasts", T, async (t) => {
  const why = await dbUnavailable();
  if (why) return t.skip(why);
  const metrics = (await getMLModelMetrics()) ?? [];
  const stored = await q(`SELECT model_name, mase::float AS mase FROM gold.ml_model_metrics WHERE target = 'Total Traffic' AND split_label = '80_20'`);
  const storedBy = Object.fromEntries(stored.map((r) => [r.model_name, r.mase]));
  const archives = await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                             WHERE n.nspname = 'gold' AND c.relkind IN ('r','v','m') AND c.relname ~ '(volume|traffic).*(log|archive|feedback)|forecast_feedback' ORDER BY 1`);
  console.log(`  volume MASE page=${JSON.stringify(metrics.map((m: any) => [m.model ?? m.model_name, m.mase]))}`);
  console.log(`  volume MASE stored=${JSON.stringify(storedBy)}; candidate archived volume-forecast tables=${JSON.stringify(archives.map((a) => a.relname))}`);
  for (const m of metrics as any[]) assert.equal(m.mase, storedBy[m.model ?? m.model_name] ?? null, "card value equals the stored metric");
  // Where the card's figure comes from: the function's own SQL.
  const fn = declaration(readSource("Back-End/src/services/traffic.service.ts"), "getMLModelMetrics");
  const tables = [...new Set(fn.match(/\b(gold|silver|public)\.[a-z_]+/g) ?? [])];
  console.log(`  getMLModelMetrics reads: ${tables.join(", ")}`);
  // The held-out score, by design: scoring archived forecasts needs actual volumes for the days they forecast, and the
  // record ends 2026-06-30 (the team's rule) while every stored forecast starts after it (2 Nov 2026).
  assert.ok(tables.includes("gold.ml_model_metrics"), `the card's MASE should be the held-out score in gold.ml_model_metrics; it reads ${tables.join(", ")}`);
  const [{ scorable }] = await q(`SELECT COUNT(*)::int AS scorable FROM gold.ml_predictive_volume p
                                   JOIN gold.fact_traffic_hourly t ON t.date = p.forecast_date WHERE p.is_future`);
  console.log(`  future forecast days that already have actual traffic: ${scorable}`);
  assert.equal(scorable, 0, "actual traffic now exists for forecast days: score the archived forecasts on the card");
});
