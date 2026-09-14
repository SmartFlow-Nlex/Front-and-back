const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);
const SNAP = "gold.daily_traffic_volume_corrected_spliced_20260829";
const f = (v) => Number(v).toLocaleString("en-US");

(async () => {
  const c = await p.connect();
  try {
    await c.query("BEGIN");

    // Snapshot the current spliced state too, so BOTH prior states are recoverable:
    //   _bak_20260829     = original all-old series (2,398 days)
    //   _spliced_20260829 = old 2020/21/2026 + new 2022-25 (2,398 days)
    await c.query(`DROP TABLE IF EXISTS ${SNAP}`);
    await c.query(`CREATE TABLE ${SNAP} AS SELECT * FROM gold.daily_traffic_volume_corrected`);
    const s = await c.query(`SELECT COUNT(*)::int n FROM ${SNAP}`);
    console.log(`Snapshot ${SNAP}: ${s.rows[0].n} rows`);

    const del = await c.query(
      "DELETE FROM gold.daily_traffic_volume_corrected WHERE date < '2022-01-01' OR date > '2025-12-31'"
    );
    console.log(`Deleted ${del.rowCount} rows (2020, 2021, 2026)`);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    console.log("ROLLED BACK: " + e.message);
    c.release(); await p.end(); process.exit(1);
  }
  c.release();

  const r = await p.query(
    `SELECT EXTRACT(YEAR FROM date)::int y, COUNT(*)::int d, ROUND(AVG(total_volume))::bigint a,
            ROUND(STDDEV(total_volume))::bigint sd
     FROM gold.daily_traffic_volume_corrected GROUP BY 1 ORDER BY 1`);
  console.log("\nRemaining series (single source — new CSVs only):");
  r.rows.forEach((x) => console.log(`  ${x.y}  ${String(x.d).padStart(4)} days  avg ${f(x.a).padStart(9)}  sd ${f(x.sd).padStart(7)}`));

  const t = await p.query(
    "SELECT COUNT(*)::int n, MIN(date)::text lo, MAX(date)::text hi FROM gold.daily_traffic_volume_corrected");
  const n = t.rows[0].n;
  console.log(`\nTotal: ${n} days  ${t.rows[0].lo} .. ${t.rows[0].hi}`);

  const N_ORIGINS = 21, STEP = 14;
  const scored = N_ORIGINS * STEP, train = n - scored;
  console.log(`\nPlanned split with N_ORIGINS=${N_ORIGINS}, STEP=${STEP}:`);
  console.log(`  train  ${train} days  (${((train / n) * 100).toFixed(2)}%)`);
  console.log(`  scored ${scored} days  (${((scored / n) * 100).toFixed(2)}%)`);
  const b = await p.query(
    "SELECT date::text d FROM gold.daily_traffic_volume_corrected ORDER BY date OFFSET $1 LIMIT 1", [train]);
  console.log(`  first scored day: ${b.rows[0].d}`);

  await p.end();
})();
