const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);
const f = (v) => Number(v ?? 0).toLocaleString("en-US");

(async () => {
  const r = await p.query(`
    SELECT forecast_date::text d, actual_volume::float a, pred_prophet::float pp,
           is_holdout, is_future
    FROM gold.ml_predictive_volume ORDER BY forecast_date`);
  const rows = r.rows;

  const past = rows.filter((x) => !x.is_holdout && !x.is_future);
  const hold = rows.filter((x) => x.is_holdout);
  const fut = rows.filter((x) => x.is_future);
  console.log(`rows ${f(rows.length)}  |  past ${f(past.length)}  holdout ${f(hold.length)}  future ${f(fut.length)}`);

  // 1. Does the prediction line bleed into the PAST region? It must not:
  //    walk-forward means nothing is predicted before the first origin.
  const pastWithPred = past.filter((x) => x.pp != null).length;
  console.log(`\n1. Prophet values inside PAST: ${f(pastWithPred)}  (must be 0)`);

  // 2. Are holdout and future fully covered?
  console.log(`2. holdout with a value: ${f(hold.filter((x) => x.pp != null).length)} of ${f(hold.length)}`);
  console.log(`   future  with a value: ${f(fut.filter((x) => x.pp != null).length)} of ${f(fut.length)}`);

  // 3. Recompute WMAPE from the SERVED numbers and compare with the stored
  //    metric. If the chart and the metrics table disagree, one of them is lying.
  const ev = hold.filter((x) => x.a != null && x.pp != null);
  const num = ev.reduce((s, x) => s + Math.abs(x.a - x.pp), 0);
  const den = ev.reduce((s, x) => s + Math.abs(x.a), 0);
  const wmape = (num / den) * 100;
  const mae = num / ev.length;
  const rmse = Math.sqrt(ev.reduce((s, x) => s + (x.a - x.pp) ** 2, 0) / ev.length);
  const my = ev.reduce((s, x) => s + x.a, 0) / ev.length;
  const r2 = 1 - ev.reduce((s, x) => s + (x.a - x.pp) ** 2, 0) /
                 ev.reduce((s, x) => s + (x.a - my) ** 2, 0);

  const m = await p.query(
    "SELECT wmape::float w, mae::float m, rmse::float rm, r2::float r FROM gold.ml_model_metrics WHERE target='Total Traffic' AND model_name='Prophet'");
  const st = m.rows[0];
  console.log(`\n3. Recomputed from the served series vs the stored metric:`);
  console.log(`   scored days   ${f(ev.length)}`);
  console.log(`   WMAPE  drawn ${wmape.toFixed(4)}%   stored ${st.w.toFixed(4)}%   diff ${(wmape - st.w).toFixed(6)}`);
  console.log(`   MAE    drawn ${f(Math.round(mae))}      stored ${f(Math.round(st.m))}`);
  console.log(`   RMSE   drawn ${f(Math.round(rmse))}      stored ${f(Math.round(st.rm))}`);
  console.log(`   R2     drawn ${r2.toFixed(4)}       stored ${st.r.toFixed(4)}`);
  console.log(`   MATCH: ${Math.abs(wmape - st.w) < 0.01 ? "YES" : "NO — chart and metrics disagree"}`);

  // 4. Boundary check: where does the line actually start?
  const firstPred = rows.find((x) => x.pp != null);
  const firstHold = rows.find((x) => x.is_holdout);
  console.log(`\n4. first Prophet value : ${firstPred?.d}`);
  console.log(`   first holdout day   : ${firstHold?.d}`);
  console.log(`   aligned: ${firstPred?.d === firstHold?.d ? "YES" : "NO"}`);

  // 5. Future values should exist but be unscored (no actuals).
  const futWithActual = fut.filter((x) => x.a != null).length;
  console.log(`\n5. future rows carrying an actual: ${f(futWithActual)}  (should be 0 — unscored projection)`);
  console.log(`   future range: ${fut[0]?.d} .. ${fut[fut.length - 1]?.d}`);

  await p.end();
})();
