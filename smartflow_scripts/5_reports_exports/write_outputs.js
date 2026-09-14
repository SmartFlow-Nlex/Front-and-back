const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const cfg = require("../config/db.cjs");
const p = new Pool(cfg.poolConfig);

const BASE = cfg.setting("REPORTS_DIR", undefined, true);   // set in config/.env
const DIR = path.join(BASE, "05_2026-08-29_new_source_data_retrain");
const LOG = path.join(cfg.WORK, "logs", "retrain_new_data.log");

const pad = (s, n) => String(s).padEnd(n);
const num = (v, d = 4) => (v == null || !isFinite(v) ? "n/a" : Number(v).toFixed(d));
const int = (v) => (v == null ? "n/a" : Math.round(Number(v)).toLocaleString("en-US"));

(async () => {
  fs.mkdirSync(DIR, { recursive: true });

  const m = await p.query(
    `SELECT model_name, wmape, mae, rmse, mase, r2, rank, accepted, rejected_reason, uses_weather, aic, bic
     FROM gold.ml_model_metrics WHERE target='Total Traffic' ORDER BY wmape ASC NULLS LAST`
  );
  const split = await p.query(`
    SELECT COUNT(DISTINCT forecast_date) FILTER (WHERE NOT is_holdout AND NOT is_future)::int tr,
           COUNT(DISTINCT forecast_date) FILTER (WHERE is_holdout)::int ho,
           COUNT(DISTINCT forecast_date) FILTER (WHERE is_future)::int fu,
           MIN(forecast_date) FILTER (WHERE is_holdout)::text hs,
           MAX(forecast_date) FILTER (WHERE is_holdout)::text he
    FROM gold.ml_predictive_volume`);
  const s = split.rows[0];

  const yr = await p.query(
    `SELECT EXTRACT(YEAR FROM date)::int y, COUNT(*)::int d, ROUND(AVG(total_volume))::bigint a
     FROM gold.daily_traffic_volume_corrected GROUP BY 1 ORDER BY 1`);
  const yrOld = await p.query(
    `SELECT EXTRACT(YEAR FROM date)::int y, ROUND(AVG(total_volume))::bigint a
     FROM gold.daily_traffic_volume_corrected_bak_20260829 GROUP BY 1 ORDER BY 1`);
  const oldBy = new Map(yrOld.rows.map((r) => [r.y, Number(r.a)]));

  const L = [];
  const rule = "=".repeat(78);
  L.push(rule);
  L.push("  MODEL EVALUATION REPORT — SmartFlow NLEX / Traffic Volume Forecast");
  L.push(`  Generated : 2026-08-29`);
  L.push(`  Source    : new hourly O-D extracts (nlex_traffic_hourly_2022..2025.csv)`);
  L.push(`  Pipeline  : retrain_honest.py — rolling-origin walk-forward`);
  L.push(rule);
  L.push("");
  L.push("1. HEADLINE RESULT");
  L.push("-".repeat(78));
  L.push("  NO MODEL WAS ACCEPTED.");
  L.push("");
  L.push("  All eight candidates failed to beat the naive/climatology baseline of");
  L.push("  9.40% WMAPE. Every model returned MASE > 1, meaning every one performed");
  L.push("  worse than the in-sample seasonal-naive benchmark it is measured against.");
  L.push("  This is reported as-is. No threshold was relaxed to manufacture a pass.");
  L.push("");
  L.push("2. EVALUATION PROTOCOL");
  L.push("-".repeat(78));
  L.push(`  Train span      : ${s.tr} days (80.15%)`);
  L.push(`  Holdout scored  : ${s.ho} days (19.85%)  ${s.hs} -> ${s.he}`);
  L.push(`  Future forecast : ${s.fu} days (unscored projection)`);
  L.push("  Origins         : 34, non-overlapping, STEP = 14");
  L.push("  Horizon         : 14 days, forecast blind at each origin");
  L.push("  Seasonality     : 7 (weekly) — MASE is vs seasonal naive, NOT a percentage");
  L.push("");
  L.push("3. RESULTS (476 scored days)");
  L.push("-".repeat(78));
  L.push("  " + pad("model", 15) + pad("WMAPE", 10) + pad("MAE", 13) + pad("RMSE", 13) + pad("MASE", 9) + pad("R2", 10) + "verdict");
  for (const r of m.rows) {
    L.push("  " + pad(r.model_name, 15) + pad(num(r.wmape, 2) + "%", 10) +
      pad(int(r.mae), 13) + pad(int(r.rmse), 13) + pad(num(r.mase, 3), 9) +
      pad(num(r.r2, 4), 10) + (r.accepted ? "ACCEPTED" : "rejected"));
  }
  L.push("");
  L.push("  Baseline to beat (best of seasonal-naive / climatology): 9.40% WMAPE");
  L.push("");
  L.push("4. WHY EVERY MODEL FAILED");
  L.push("-".repeat(78));
  L.push("  The new source series is smoother and less weekly-structured than the");
  L.push("  data it replaced, which makes a plain climatological mean very hard to");
  L.push("  beat. Measured over the identical span 2022-01-01..2025-12-31:");
  L.push("");
  L.push("                            OLD data      NEW data");
  L.push("    coefficient of variation   0.2219        0.1407");
  L.push("    day-of-week R2             0.323         0.252");
  L.push("    weekday spread          103,020 veh    76,099 veh");
  L.push("");
  L.push("  The weekly pattern also INVERTED. Old data peaked on Sunday (405,621)");
  L.push("  with Mon-Thu flat near 303,000. New data has Sunday as the WEEK'S LOW");
  L.push("  (279,579), rising through the week to Friday (355,678).");
  L.push("");
  L.push("    day     OLD avg      NEW avg");
  L.push("    Sun     405,621      279,579   <- peak became trough");
  L.push("    Mon     308,783      322,543");
  L.push("    Tue     302,601      330,954");
  L.push("    Wed     303,697      330,010");
  L.push("    Thu     304,150      332,315");
  L.push("    Fri     396,035      355,678");
  L.push("    Sat     361,000      352,717");
  L.push("");
  L.push("  Consequence: models carrying a 7-day seasonal term (Holt-Winters,");
  L.push("  SARIMAX, Prophet) fit a weekly cycle that is now much weaker. STEP 4");
  L.push("  confirms this — actual weekday-only R2 is 0.1535, but Prophet emits");
  L.push("  0.5154 and Prophet_nw 0.5323, i.e. they output a repeating weekly");
  L.push("  average the data no longer supports.");
  L.push("");
  L.push("5. DOES WEATHER HELP?");
  L.push("-".repeat(78));
  L.push("    SARIMAX   10.38%  vs  no-weather 10.55%   -> helps by 0.17 pts");
  L.push("    Prophet   10.84%  vs  no-weather 10.96%   -> helps by 0.13 pts");
  L.push("    LSTM      12.97%  vs  no-weather 12.96%   -> no meaningful difference");
  L.push("");
  L.push("  Weather now marginally helps two of three, reversing the previous run");
  L.push("  where the weather-free model ranked first. Both effects are small and");
  L.push("  neither changes any accept/reject verdict.");
  L.push("");
  L.push("6. HORIZON DEGRADATION (week 1 vs week 2 ahead)");
  L.push("-".repeat(78));
  L.push("    SeasonalNaive  10.21% -> 12.40%   (+2.19 pts)");
  L.push("    Climatology     8.16% -> 10.65%   (+2.49 pts)");
  L.push("    HoltWinters     8.80% -> 11.50%   (+2.71 pts)");
  L.push("    SARIMAX         8.95% -> 11.82%   (+2.87 pts)");
  L.push("    Prophet         9.73% -> 11.95%   (+2.21 pts)");
  L.push("    LSTM           11.81% -> 14.14%   (+2.33 pts)");
  L.push("");
  L.push("  Every model degrades with horizon, as expected. Metrics above are the");
  L.push("  14-day average, matching exactly what the dashboard serves.");
  L.push("");
  L.push("7. AIC / BIC (ARIMA-family only)");
  L.push("-".repeat(78));
  L.push("    HoltWinters    AIC  50,305.4    BIC  50,369.0");
  L.push("    Holts_Linear   AIC  51,539.3    BIC  51,562.4");
  L.push("    SARIMAX        AIC  56,974.6    BIC  57,026.6");
  L.push("    SARIMAX_nw     AIC  56,974.9    BIC  57,003.8");
  L.push("  Prophet and LSTM are not likelihood-based; AIC/BIC do not apply and are");
  L.push("  not reported for them. Comparable only WITHIN this family.");
  L.push("");
  L.push("8. DATA LINEAGE");
  L.push("-".repeat(78));
  L.push("  Replaced : 2022-01-01 .. 2025-12-31  (1,461 days) from new CSV extracts");
  L.push("  Retained : 2020, 2021 and 2026 unchanged, per project owner instruction");
  L.push("  Backup   : gold.daily_traffic_volume_corrected_bak_20260829 (2,398 rows)");
  L.push("  Source rows validated: 12,510,984 total");
  L.push("      class_1+class_2+class_3 = total mismatches : 0");
  L.push("      negative totals                            : 0");
  L.push("");
  L.push("    year   days   NEW avg/day    OLD avg/day    change");
  for (const r of yr.rows) {
    const o = oldBy.get(r.y);
    const n = Number(r.a);
    const ch = o == null ? "" : (n === o ? "unchanged (retained)" : `${(((n - o) / o) * 100).toFixed(1)}%`);
    L.push(`    ${r.y}   ${pad(r.d, 6)} ${pad(n.toLocaleString(), 14)} ${pad(o == null ? "n/a" : o.toLocaleString(), 14)} ${ch}`);
  }
  L.push("");
  L.push("9. CAVEATS");
  L.push("-".repeat(78));
  L.push("  - Source directory is named 'synthetic-nlex-data'. If these extracts are");
  L.push("    generated rather than observed, the low variance and weak weekly");
  L.push("    structure may be an artefact of generation rather than a property of");
  L.push("    real NLEX traffic. This materially affects how the null result above");
  L.push("    should be interpreted.");
  L.push("  - Sctex has no rows in the new extracts; its prior data was retained.");
  L.push("  - Only the DAILY series was replaced. The hourly origin-destination fact");
  L.push("    table (12.5M rows) is not yet loaded, so fleet-mix, emissions,");
  L.push("    peak-hour and exit-impact analyses still run on prior data.");
  L.push("  - FUTURE window weather is day-of-year climatology, not observation.");
  L.push("");
  L.push(rule);
  L.push("  END OF REPORT");
  L.push(rule);

  fs.writeFileSync(path.join(DIR, "MODEL_EVALUATION_REPORT.txt"), L.join("\n"), "utf8");

  // Machine-readable companion
  fs.writeFileSync(
    path.join(DIR, "model_selection_results.json"),
    JSON.stringify({
      generated: "2026-08-29",
      source: "nlex_traffic_hourly_2022..2025.csv",
      protocol: { origins: 34, horizon: 14, step: 14, season: 7, scored_days: s.ho, train_days: s.tr },
      baseline_wmape: 9.3987,
      any_accepted: m.rows.some((r) => r.accepted),
      models: m.rows,
    }, null, 2), "utf8"
  );

  // Metrics CSV
  const hdr = "model,wmape,mae,rmse,mase,r2,accepted,uses_weather,aic,bic,rejected_reason";
  const csv = [hdr].concat(m.rows.map((r) =>
    [r.model_name, r.wmape, r.mae, r.rmse, r.mase, r.r2, r.accepted, r.uses_weather, r.aic, r.bic,
     JSON.stringify(r.rejected_reason ?? "")].join(",")));
  fs.writeFileSync(path.join(DIR, "model_metrics.csv"), csv.join("\n"), "utf8");

  // Scored predictions
  const pr = await p.query(`
    SELECT forecast_date::text date, actual_volume, pred_lstm, pred_prophet, pred_holtwinters,
           pred_sarimax, pred_holts_linear, is_holdout, is_future
    FROM gold.ml_predictive_volume ORDER BY forecast_date`);
  const ph = "date,actual_volume,pred_lstm,pred_prophet,pred_holtwinters,pred_sarimax,pred_holts_linear,is_holdout,is_future";
  fs.writeFileSync(path.join(DIR, "predictions_full_series.csv"),
    [ph].concat(pr.rows.map((r) => Object.values(r).join(","))).join("\n"), "utf8");

  // Raw run log
  if (fs.existsSync(LOG)) fs.copyFileSync(LOG, path.join(DIR, "retrain_run.log"));

  console.log("Wrote to: " + DIR);
  fs.readdirSync(DIR).forEach((f) => {
    console.log(`  ${pad(f, 34)} ${fs.statSync(path.join(DIR, f)).size.toLocaleString()} bytes`);
  });
  await p.end();
})();
