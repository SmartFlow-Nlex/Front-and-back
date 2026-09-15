const { Pool } = require("pg");
const p = new Pool(require("../config/db.cjs").poolConfig);
const f = (v) => Number(v ?? 0).toLocaleString("en-US");

(async () => {
  const cols = await p.query(
    "SELECT column_name c, data_type d FROM information_schema.columns WHERE table_schema='gold' AND table_name='ml_predictive_congestion' ORDER BY ordinal_position");
  console.log("gold.ml_predictive_congestion");
  console.log("  columns: " + cols.rows.map((r) => `${r.c}`).join(", "));

  const n = await p.query("SELECT COUNT(*)::int n FROM gold.ml_predictive_congestion");
  console.log("  rows: " + f(n.rows[0].n));

  const seg = await p.query(
    "SELECT segment_name, COUNT(*)::int n FROM gold.ml_predictive_congestion GROUP BY 1 ORDER BY 1");
  console.log(`\n  segments (${seg.rowCount}):`);
  seg.rows.forEach((r) => console.log(`    ${r.segment_name.padEnd(24)} ${r.n} rows`));

  // Do these segment names match the canonical 20-exit reference?
  const canon = await p.query(
    "SELECT DISTINCT canonical_exit e FROM gold.exit_name_map WHERE canonical_exit IS NOT NULL");
  const C = new Set(canon.rows.map((r) => r.e));
  const segs = seg.rows.map((r) => r.segment_name);
  console.log("\n  vs canonical 20-exit reference:");
  console.log("    match     : " + (segs.filter((s) => C.has(s)).join(", ") || "none"));
  console.log("    NOT in ref: " + (segs.filter((s) => !C.has(s)).join(", ") || "none"));

  // Is there ANY training/evaluation record for congestion?
  const t = await p.query("SELECT DISTINCT target FROM gold.ml_model_metrics ORDER BY 1");
  console.log("\n  targets present in gold.ml_model_metrics:");
  t.rows.forEach((r) => console.log(`    "${r.target}"`));

  const cm = await p.query(
    "SELECT COUNT(*)::int n FROM gold.ml_model_metrics WHERE target ILIKE '%congest%'");
  console.log(`  metric rows for any congestion target: ${cm.rows[0].n}`);

  // Provenance
  for (const col of ["updated_at", "created_at", "generated_at"]) {
    try {
      const r = await p.query(`SELECT MIN(${col})::text lo, MAX(${col})::text hi FROM gold.ml_predictive_congestion`);
      console.log(`\n  ${col}: ${r.rows[0].lo} .. ${r.rows[0].hi}`);
    } catch { /* column absent */ }
  }

  // What do the values look like?
  const st = await p.query(
    "SELECT congestion_state, COUNT(*)::int n, ROUND(MIN(probability)::numeric,3) lo, ROUND(MAX(probability)::numeric,3) hi, ROUND(AVG(probability)::numeric,3) avg FROM gold.ml_predictive_congestion GROUP BY 1 ORDER BY 2 DESC");
  console.log("\n  states:");
  st.rows.forEach((r) => console.log(`    ${String(r.congestion_state).padEnd(12)} ${String(r.n).padStart(4)} rows  prob ${r.lo}..${r.hi} (avg ${r.avg})`));

  const h = await p.query("SELECT MIN(hours_ahead)::int lo, MAX(hours_ahead)::int hi FROM gold.ml_predictive_congestion");
  console.log(`  horizon: +${h.rows[0].lo}h .. +${h.rows[0].hi}h`);

  // Is there any source of observed congestion to have trained/tested against?
  for (const tbl of ["gold.fact_traffic_hourly", "silver.fact_waze_jams", "bronze.waze_hourly_jams", "silver.waze_hourly_jams_clean"]) {
    try {
      const r = await p.query(`SELECT COUNT(*)::bigint n FROM ${tbl}`);
      console.log(`  ${tbl}: ${f(r.rows[0].n)} rows`);
    } catch { console.log(`  ${tbl}: absent`); }
  }

  await p.end();
})();
