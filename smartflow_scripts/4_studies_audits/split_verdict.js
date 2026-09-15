/**
 * Is 90/10 better, or is its test window just easier?
 *
 * Decisive test: take the 80/20 run's OWN predictions and re-score them on only
 * the days the 90/10 arm was scored on (2025-08-14..2025-12-31). Same model,
 * same forecasts, narrower window. If the number improves, the window is easier
 * and the split ratio deserves none of the credit.
 */
const { Pool } = require("pg");
const p = new Pool(require("../config/db.cjs").poolConfig);
const f = (v) => Number(v ?? 0).toLocaleString("en-US");

const wmape = (rows, col) => {
  const ok = rows.filter((r) => r.a != null && r[col] != null);
  const n = ok.reduce((s, r) => s + Math.abs(r.a - r[col]), 0);
  const d = ok.reduce((s, r) => s + Math.abs(r.a), 0);
  return { w: (n / d) * 100, n: ok.length };
};

(async () => {
  const q = async (split) => (await p.query(`
    SELECT forecast_date::text d, actual_volume::float a,
           pred_prophet::float prophet, pred_holtwinters::float hw
    FROM gold.ml_predictive_volume
    WHERE split_label = $1 AND is_holdout ORDER BY forecast_date`, [split])).rows;

  const a = await q("80_20");
  const b = await q("90_10");
  const overlapStart = b[0].d;

  console.log(`80/20 scored ${f(a.length)} days: ${a[0].d} .. ${a[a.length - 1].d}`);
  console.log(`90/10 scored ${f(b.length)} days: ${b[0].d} .. ${b[b.length - 1].d}`);

  const aSub = a.filter((r) => r.d >= overlapStart);
  console.log(`\nRE-SCORING THE 80/20 MODELS ON THE 90/10 WINDOW ONLY (${f(aSub.length)} days)\n`);
  console.log("  model         full 80/20 window   same models, 90/10 window   90/10 run");
  for (const [name, col] of [["Prophet", "prophet"], ["HoltWinters", "hw"]]) {
    const full = wmape(a, col), sub = wmape(aSub, col), own = wmape(b, col);
    console.log(`  ${name.padEnd(12)} ${full.w.toFixed(2)}%${" ".repeat(16)}${sub.w.toFixed(2)}%${" ".repeat(20)}${own.w.toFixed(2)}%`);
  }

  // How variable is each window? Harder windows swing more.
  const cv = (rows) => {
    const v = rows.map((r) => r.a).filter((x) => x != null);
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length) / m;
  };
  const months = (rows) => new Set(rows.map((r) => r.d.slice(5, 7))).size;
  console.log(`\n  window difficulty:`);
  console.log(`    80/20 full   CV ${cv(a).toFixed(4)}   ${months(a)} distinct months`);
  console.log(`    90/10 window CV ${cv(b).toFixed(4)}   ${months(b)} distinct months`);

  console.log(`\n  independent 14-day blocks tested:  80/20 = 21    90/10 = 10`);
  await p.end();
})();
