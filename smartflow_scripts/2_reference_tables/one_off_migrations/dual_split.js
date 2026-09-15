if (process.env.ALLOW_MIGRATION !== "1") {
  console.error("One-off migration, already applied to the database. Re-running it can duplicate or undo changes. Set ALLOW_MIGRATION=1 to run it deliberately.");
  process.exit(1);
}
/**
 * Hold BOTH split arms side by side so the dashboard can toggle between them.
 *
 * State on entry: the live tables hold the 90/10 run (it overwrote them), and
 * the 80/20 run is parked in *_split8020. This tags every row with the split it
 * came from and puts both arms back in the live tables.
 *
 * A split_label column is safer here than two sets of tables: every existing
 * query keeps working against one table, and the filter is a WHERE clause. But
 * it MUST be applied everywhere — the same shared-table mistake with
 * target='Congestion' leaked congestion accuracies into the volume panel.
 */
const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);
const f = (v) => Number(v ?? 0).toLocaleString("en-US");

(async () => {
  const c = await p.connect();
  try {
    await c.query("BEGIN");

    // Park the 90/10 arm currently sitting in the live tables.
    await c.query("DROP TABLE IF EXISTS gold.ml_predictive_volume_split9010");
    await c.query("DROP TABLE IF EXISTS gold.ml_model_metrics_split9010");
    await c.query("CREATE TABLE gold.ml_predictive_volume_split9010 AS SELECT * FROM gold.ml_predictive_volume");
    await c.query("CREATE TABLE gold.ml_model_metrics_split9010 AS SELECT * FROM gold.ml_model_metrics WHERE target='Total Traffic'");

    for (const t of ["gold.ml_predictive_volume", "gold.ml_model_metrics"]) {
      await c.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS split_label text`);
    }
    await c.query(`COMMENT ON COLUMN gold.ml_predictive_volume.split_label IS
      'Which chronological split produced this row: 80_20 (21 origins, 294 scored days) or 90_10 (10 origins, 140 scored days). The manuscript (p86) commits to evaluating both. Queries MUST filter on it or the two arms mix.'`);
    await c.query(`COMMENT ON COLUMN gold.ml_model_metrics.split_label IS
      'Split arm for target=Total Traffic rows. NULL for other targets (e.g. Congestion), which have their own protocol.'`);

    // Rebuild the live tables with both arms present. The id column is excluded
    // so the sequence regenerates — the two snapshots carry the same ids and
    // would collide on the primary key otherwise.
    const colsOf = async (tbl) => {
      const [sc, tb] = tbl.split(".");
      const r = await c.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema=$1 AND table_name=$2 AND column_name NOT IN ('id','split_label')
         ORDER BY ordinal_position`, [sc, tb]);
      return r.rows.map((x) => `"${x.column_name}"`).join(", ");
    };

    const vCols = await colsOf("gold.ml_predictive_volume");
    await c.query("DELETE FROM gold.ml_predictive_volume");
    for (const [tbl, lbl] of [["gold.ml_predictive_volume_split8020", "80_20"],
                              ["gold.ml_predictive_volume_split9010", "90_10"]]) {
      await c.query(`INSERT INTO gold.ml_predictive_volume (${vCols}, split_label)
                     SELECT ${vCols}, $1 FROM ${tbl}`, [lbl]);
    }

    const mCols = await colsOf("gold.ml_model_metrics");
    await c.query("DELETE FROM gold.ml_model_metrics WHERE target='Total Traffic'");
    for (const [tbl, lbl] of [["gold.ml_model_metrics_split8020", "80_20"],
                              ["gold.ml_model_metrics_split9010", "90_10"]]) {
      await c.query(`INSERT INTO gold.ml_model_metrics (${mCols}, split_label)
                     SELECT ${mCols}, $1 FROM ${tbl}`, [lbl]);
    }

    await c.query("COMMIT");
    console.log("both arms loaded.");
  } catch (e) {
    await c.query("ROLLBACK");
    console.log("ROLLED BACK: " + e.message);
    c.release(); await p.end(); process.exit(1);
  }
  c.release();

  const v = await p.query(`
    SELECT split_label, COUNT(*)::int rows,
           COUNT(*) FILTER (WHERE is_holdout)::int scored,
           COUNT(*) FILTER (WHERE NOT is_holdout AND NOT is_future)::int train,
           MIN(forecast_date) FILTER (WHERE is_holdout)::text hs
    FROM gold.ml_predictive_volume GROUP BY 1 ORDER BY 1`);
  console.log("\ngold.ml_predictive_volume");
  v.rows.forEach((r) => console.log(
    `  ${r.split_label}  ${f(r.rows)} rows | train ${f(r.train)} | scored ${f(r.scored)} (${((r.scored / (r.train + r.scored)) * 100).toFixed(2)}%) | holdout starts ${r.hs}`));

  const m = await p.query(`
    SELECT split_label, model_name, ROUND(wmape::numeric,4) w, ROUND(mase::numeric,4) ms, rank, accepted
    FROM gold.ml_model_metrics WHERE target='Total Traffic' AND accepted
    ORDER BY split_label, rank`);
  console.log("\naccepted models per arm:");
  m.rows.forEach((r) => console.log(`  ${r.split_label}  #${r.rank}  ${r.model_name.padEnd(14)} WMAPE ${r.w}%  MASE ${r.ms}`));

  const n = await p.query("SELECT split_label, COUNT(*)::int n FROM gold.ml_model_metrics GROUP BY 1 ORDER BY 1 NULLS LAST");
  console.log("\nml_model_metrics by split_label:");
  n.rows.forEach((r) => console.log(`  ${String(r.split_label ?? "(null — congestion)").padEnd(24)} ${r.n}`));
  await p.end();
})();
