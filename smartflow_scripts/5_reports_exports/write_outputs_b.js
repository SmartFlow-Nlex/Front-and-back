const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const cfg = require("../config/db.cjs");
const p = new Pool(cfg.poolConfig);

const BASE = cfg.setting("REPORTS_DIR", undefined, true);   // set in config/.env
const DIR = path.join(BASE, "06_2026-08-29_new_data_only_retrain");
const LOG = path.join(cfg.WORK, "logs", "retrain_option_b.log");

const pad = (s, n) => String(s).padEnd(n);
const num = (v, d = 4) => (v == null || !isFinite(Number(v)) ? "n/a" : Number(v).toFixed(d));
const int = (v) => (v == null ? "n/a" : Math.round(Number(v)).toLocaleString("en-US"));

(async () => {
  fs.mkdirSync(DIR, { recursive: true });

  const m = await p.query(
    `SELECT model_name, wmape, mae, rmse, mase, r2, rank, accepted, rejected_reason, uses_weather, aic, bic
     FROM gold.ml_model_metrics WHERE target='Total Traffic' ORDER BY rank`);
  const sp = await p.query(`
    SELECT COUNT(DISTINCT forecast_date) FILTER (WHERE NOT is_holdout AND NOT is_future)::int tr,
           COUNT(DISTINCT forecast_date) FILTER (WHERE is_holdout)::int ho,
           COUNT(DISTINCT forecast_date) FILTER (WHERE is_future)::int fu,
           MIN(forecast_date) FILTER (WHERE is_holdout)::text hs,
           MAX(forecast_date) FILTER (WHERE is_holdout)::text he
    FROM gold.ml_predictive_volume`);
  const s = sp.rows[0];

  const L = [];
  const rule = "=".repeat(78);
  L.push(rule);
  L.push("  MODEL EVALUATION REPORT — SmartFlow NLEX / Traffic Volume Forecast");
  L.push("  Run       : new-source data ONLY (no splice)");
  L.push("  Generated : 2026-08-29");
  L.push("  Source    : nlex_traffic_hourly_2022..2025.csv");
  L.push("  Pipeline  : retrain_honest.py — rolling-origin walk-forward");
  L.push(rule);
  L.push("");
  L.push("1. HEADLINE RESULT");
  L.push("-".repeat(78));
  L.push("  PROPHET ACCEPTED — rank #1.");
  L.push("");
  L.push("    WMAPE 6.19%   MASE 0.969   R2 0.4150   RMSE 35,099   MAE 21,517");
  L.push("");
  L.push("  It is the ONLY accepted model. It clears both gates: WMAPE below the");
  L.push("  7.81% baseline, and MASE below 1.0 (better than seasonal naive).");
  L.push("  The other seven are rejected. No threshold was relaxed.");
  L.push("");
  L.push("2. WHY THIS RUN EXISTS — CORRECTING A PRIOR ERROR");
  L.push("-".repeat(78));
  L.push("  The previous run (05_) spliced three sources into one series: old data");
  L.push("  for 2020-21 and 2026, new CSV data for 2022-25. Those two sources");
  L.push("  correlate at r = 0.0439 over identical dates and have very different");
  L.push("  volatility (sd ratio 2.21 at the 2025-12 -> 2026-01 seam).");
  L.push("");
  L.push("  The consequence was that models trained mostly on the smooth new regime");
  L.push("  were then scored on a 476-day window of which 206 days came from the old");
  L.push("  volatile regime. They could not produce swings they had never seen, and");
  L.push("  ALL EIGHT were rejected. That verdict was an artefact of the splice, not");
  L.push("  a property of the data.");
  L.push("");
  L.push("  This run removes 2020, 2021 and 2026 entirely. Every day now comes from");
  L.push("  one source. It is the first fair test of the new data.");
  L.push("");
  L.push("3. EVALUATION PROTOCOL");
  L.push("-".repeat(78));
  L.push(`  Series          : 1,461 days  2022-01-01 -> 2025-12-31  (single source)`);
  L.push(`  Train           : ${s.tr} days (79.88%)`);
  L.push(`  Holdout scored  : ${s.ho} days (20.12%)  ${s.hs} -> ${s.he}`);
  L.push(`  Future forecast : ${s.fu} days (unscored projection into 2026)`);
  L.push("  Origins         : 21, non-overlapping, STEP = 14");
  L.push("  Horizon         : 14 days, forecast blind at each origin");
  L.push("  Failed origins  : 0 across all models");
  L.push("");
  L.push("  N_ORIGINS was reduced 34 -> 21. At 34 the scored window would have been");
  L.push("  476 of 1,461 days = 32.6%, not an 80/20 split.");
  L.push("");
  L.push("4. RESULTS (294 scored days)");
  L.push("-".repeat(78));
  L.push("  " + pad("model", 15) + pad("WMAPE", 9) + pad("MAE", 12) + pad("RMSE", 12) + pad("MASE", 8) + pad("R2", 9) + "verdict");
  for (const r of m.rows) {
    L.push("  " + pad(r.model_name, 15) + pad(num(r.wmape, 2) + "%", 9) + pad(int(r.mae), 12) +
      pad(int(r.rmse), 12) + pad(num(r.mase, 3), 8) + pad(num(r.r2, 4), 9) +
      (r.accepted ? "ACCEPTED #" + r.rank : "rejected"));
  }
  L.push("");
  L.push("  Baseline to beat (best of seasonal-naive / climatology): 7.81% WMAPE");
  L.push("  Note Climatology scored 7.81% here — models now BEAT it, unlike run 05_.");
  L.push("");
  L.push("5. REJECTION REASONS (exact failing criterion)");
  L.push("-".repeat(78));
  for (const r of m.rows.filter((x) => !x.accepted)) {
    L.push(`  ${pad(r.model_name, 15)} ${r.rejected_reason}`);
  }
  L.push("");
  L.push("  Prophet_nw is notable: at 6.51% it DOES beat the 7.81% baseline, but");
  L.push("  fails on MASE (1.019). Both gates must pass.");
  L.push("");
  L.push("6. DOES WEATHER HELP? — YES, AND THIS REVERSES THE EARLIER FINDING");
  L.push("-".repeat(78));
  L.push("    Prophet    6.19%  vs  no-weather  6.51%   -> weather helps by 0.32 pts");
  L.push("    SARIMAX    7.71%  vs  no-weather  7.81%   -> weather helps by 0.09 pts");
  L.push("    LSTM      10.56%  vs  no-weather 11.20%   -> weather helps by 0.64 pts");
  L.push("");
  L.push("  Weather helps all three weather-capable models, and it is DECISIVE for");
  L.push("  the champion: Prophet (with weather) is accepted at MASE 0.969, while");
  L.push("  Prophet_nw (without) is rejected at MASE 1.019. On the original dataset");
  L.push("  the weather-free twin ranked first and weather was judged unhelpful.");
  L.push("  The conclusion is dataset-dependent and must be stated as such.");
  L.push("");
  L.push("7. HORIZON DEGRADATION (week 1 vs week 2 ahead, 147 days each)");
  L.push("-".repeat(78));
  L.push("    Prophet_nw      6.46% -> 6.57%   (+0.11 pts)   very stable");
  L.push("    Climatology     7.73% -> 7.89%   (+0.17 pts)");
  L.push("    Holts_Linear    9.87% -> 10.16%  (+0.29 pts)");
  L.push("    LSTM_nw        11.00% -> 11.40%  (+0.40 pts)");
  L.push("    SeasonalNaive   8.19% -> 9.24%   (+1.04 pts)");
  L.push("    SARIMAX_nw      6.99% -> 8.64%   (+1.66 pts)");
  L.push("    HoltWinters     6.62% -> 8.40%   (+1.78 pts)   steepest decay");
  L.push("");
  L.push("  Headline metrics are the 14-day average, matching what the dashboard");
  L.push("  serves. HoltWinters is competitive in week 1 (6.62%) but degrades most.");
  L.push("");
  L.push("8. DIAGNOSTIC — IS THE FORECAST JUST A REPEATING WEEK?");
  L.push("-".repeat(78));
  L.push("  Weekday-only R2 (a model far ABOVE the actual reference is emitting a");
  L.push("  repeating weekly average rather than reacting to conditions):");
  L.push("");
  L.push("    ACTUAL traffic   0.2985   <- reference");
  L.push("    SeasonalNaive    0.2909");
  L.push("    Climatology      0.8186");
  L.push("    Prophet          0.7006   <- CAVEAT: well above reference");
  L.push("    Prophet_nw       0.7514");
  L.push("    SARIMAX_nw       0.4542");
  L.push("    HoltWinters      0.4177");
  L.push("    SARIMAX          0.3883");
  L.push("    LSTM             0.0013");
  L.push("");
  L.push("  HONEST CAVEAT ON THE CHAMPION: Prophet's weekday-only R2 of 0.7006 is");
  L.push("  more than double the actual 0.2985. A large share of its output variance");
  L.push("  is day-of-week structure. It is winning substantially by fitting a smooth");
  L.push("  weekly profile rather than by reacting to day-specific conditions. That");
  L.push("  is consistent with how Prophet works (additive seasonality) and it still");
  L.push("  clears both gates — but it should be disclosed, not hidden.");
  L.push("");
  L.push("9. AIC / BIC (ARIMA-family only)");
  L.push("-".repeat(78));
  L.push("    HoltWinters    AIC  29,936.2   BIC  29,994.3");
  L.push("    Holts_Linear   AIC  30,862.8   BIC  30,883.9");
  L.push("    SARIMAX_nw     AIC  33,898.1   BIC  33,924.5");
  L.push("  Prophet and LSTM are not likelihood-based; not reported. Comparable only");
  L.push("  WITHIN this family — AIC/BIC cannot rank SARIMAX against Prophet.");
  L.push("");
  L.push("10. COMPARISON ACROSS ALL THREE RUNS");
  L.push("-".repeat(78));
  L.push("  run              series              champion       WMAPE   MASE   verdict");
  L.push("  original (04_)   2,398d all-old      Prophet_nw     9.76%   0.829  accepted");
  L.push("  spliced  (05_)   2,398d 3 sources    none          10.15%   1.234  ALL rejected");
  L.push("  new only (06_)   1,461d single       Prophet        6.19%   0.969  accepted");
  L.push("");
  L.push("  WMAPE is NOT comparable across these rows — different series, different");
  L.push("  scored windows, different difficulty. A lower WMAPE here does not mean");
  L.push("  the new data forecasts 'better' in any absolute sense; the new series is");
  L.push("  smoother (coefficient of variation 0.1407 vs 0.2218), so lower percentage");
  L.push("  error is expected. MASE is the fairer cross-run comparison, and by that");
  L.push("  measure the ORIGINAL data is stronger: 0.829 vs 0.969.");
  L.push("");
  L.push("11. WHAT THIS RUN DOES AND DOES NOT SETTLE");
  L.push("-".repeat(78));
  L.push("  SETTLED: the new data IS forecastable. The all-rejected verdict in 05_");
  L.push("  was caused by the splice, not by the data.");
  L.push("");
  L.push("  NOT SETTLED: whether the new data should be preferred. Against it —");
  L.push("    - worse MASE than the original data (0.969 vs 0.829); the champion is");
  L.push("      only 3.1% better than a seasonal naive forecast");
  L.push("    - only ONE model of eight clears the bar, and only just");
  L.push("    - no COVID period, no pre-2022 history (1,167 training days ~ 3.2 yrs)");
  L.push("    - Sunday is the weekly LOW; the original data had Sunday as the PEAK,");
  L.push("      which matches intercity/leisure travel on a road to Bulacan/Pampanga");
  L.push("    - no Holy Week April surge (327,294 vs 390,043 in the original)");
  L.push("    - a hard ceiling near 423,000: 7 days sit within 1% of the maximum,");
  L.push("      versus 1 day in the original — a saturation artefact");
  L.push("    - the two sources correlate at r = 0.0439 over identical dates, so at");
  L.push("      least one does not describe reality");
  L.push("");
  L.push("12. DATA LINEAGE AND RECOVERY");
  L.push("-".repeat(78));
  L.push("  Live table : gold.daily_traffic_volume_corrected — 1,461 days, new source");
  L.push("  Recovery   : gold.daily_traffic_volume_corrected_bak_20260829");
  L.push("                 original all-old series, 2,398 days");
  L.push("               gold.daily_traffic_volume_corrected_spliced_20260829");
  L.push("                 spliced series, 2,398 days");
  L.push("  Source validated: 12,510,984 rows — 0 class-sum mismatches, 0 negatives");
  L.push("");
  L.push("13. KNOWN ISSUES");
  L.push("-".repeat(78));
  L.push("  - retrain_honest.py line ~530 prints a canned 'does not beat the baseline'");
  L.push("    for every rejection in the CONSOLE log. The DATABASE reason is correct");
  L.push("    and specific (see section 5). Console text only; metrics are unaffected.");
  L.push("  - FUTURE window weather is day-of-year climatology, not observation.");
  L.push("  - Only the DAILY series was replaced. The hourly origin-destination fact");
  L.push("    table (12.5M rows) is not loaded, so fleet-mix, emissions, peak-hour and");
  L.push("    exit-impact analyses still run on prior data.");
  L.push("  - The ETL upload path still cannot ingest these files: Gate 2 rejects the");
  L.push("    long hourly format, and parser.ts uses readFileSync on 250MB files.");
  L.push("");
  L.push(rule);
  L.push("  END OF REPORT");
  L.push(rule);

  fs.writeFileSync(path.join(DIR, "MODEL_EVALUATION_REPORT.txt"), L.join("\n"), "utf8");

  fs.writeFileSync(path.join(DIR, "model_selection_results.json"), JSON.stringify({
    generated: "2026-08-29", run: "new_data_only_no_splice",
    series: { days: 1461, from: "2022-01-01", to: "2025-12-31", sources: 1 },
    protocol: { origins: 21, horizon: 14, step: 14, season: 7, train_days: s.tr, scored_days: s.ho },
    baseline_wmape: 7.8109,
    champion: "Prophet",
    models: m.rows,
  }, null, 2), "utf8");

  const hdr = "model,rank,wmape,mae,rmse,mase,r2,accepted,uses_weather,aic,bic,rejected_reason";
  fs.writeFileSync(path.join(DIR, "model_metrics.csv"),
    [hdr].concat(m.rows.map((r) => [r.model_name, r.rank, r.wmape, r.mae, r.rmse, r.mase, r.r2,
      r.accepted, r.uses_weather, r.aic, r.bic, JSON.stringify(r.rejected_reason ?? "")].join(","))).join("\n"), "utf8");

  const pr = await p.query(`
    SELECT forecast_date::text date, actual_volume, pred_lstm, pred_prophet, pred_holtwinters,
           pred_sarimax, pred_holts_linear, is_holdout, is_future
    FROM gold.ml_predictive_volume ORDER BY forecast_date`);
  fs.writeFileSync(path.join(DIR, "predictions_full_series.csv"),
    ["date,actual_volume,pred_lstm,pred_prophet,pred_holtwinters,pred_sarimax,pred_holts_linear,is_holdout,is_future"]
      .concat(pr.rows.map((r) => Object.values(r).join(","))).join("\n"), "utf8");

  if (fs.existsSync(LOG)) fs.copyFileSync(LOG, path.join(DIR, "retrain_run.log"));

  console.log("Wrote to: " + DIR);
  fs.readdirSync(DIR).forEach((fn) =>
    console.log(`  ${pad(fn, 34)} ${fs.statSync(path.join(DIR, fn)).size.toLocaleString()} bytes`));
  await p.end();
})();
