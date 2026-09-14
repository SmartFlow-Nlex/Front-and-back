throw new Error("ARCHIVED - do not run. Its input (daily_new.csv) no longer exists; superseded by 1_data_loading/traffic/load_fact.js. See smartflow_scripts/README.md.");
const fs = require("fs");
const { Pool } = require("pg");
const p = new Pool(require("../config/db.cjs").poolConfig);

const BACKUP = "gold.daily_traffic_volume_corrected_bak_20260829";
const APPLY = process.argv.includes("--apply");

const rows = fs.readFileSync("C:/Users/Hans/.gemini/antigravity/scratch/Front-and-back-Ver1-Merged-BE-FE/Front-and-back-Ver1-Merged-BE-FE/pipeline_scripts/_work/daily_new.csv", "utf8")
  .split("\n").map((l) => l.trim()).filter(Boolean)
  .map((l) => { const [d, v] = l.split(","); return { d, v: Number(v) }; });

(async () => {
  console.log(`New daily rows to load: ${rows.length} (${rows[0].d} .. ${rows[rows.length - 1].d})`);

  const before = await p.query(
    "SELECT EXTRACT(YEAR FROM date)::int y, COUNT(*)::int d, ROUND(AVG(total_volume))::bigint a FROM gold.daily_traffic_volume_corrected GROUP BY 1 ORDER BY 1"
  );
  console.log("\nBEFORE:");
  before.rows.forEach((r) => console.log(`  ${r.y}  ${r.d} days  avg ${Number(r.a).toLocaleString()}`));

  if (!APPLY) { console.log("\n(dry run — pass --apply)"); await p.end(); return; }

  const c = await p.connect();
  try {
    await c.query("BEGIN");

    // Backup the whole table before touching it.
    await c.query(`DROP TABLE IF EXISTS ${BACKUP}`);
    await c.query(`CREATE TABLE ${BACKUP} AS SELECT * FROM gold.daily_traffic_volume_corrected`);
    const bk = await c.query(`SELECT COUNT(*)::int n FROM ${BACKUP}`);
    console.log(`\nBackup ${BACKUP}: ${bk.rows[0].n} rows`);

    // 2020, 2021 and 2026 are retained exactly as-is, per instruction.
    const del = await c.query(
      "DELETE FROM gold.daily_traffic_volume_corrected WHERE date BETWEEN '2022-01-01' AND '2025-12-31'"
    );
    console.log(`Deleted ${del.rowCount} rows (2022-01-01..2025-12-31)`);

    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const vals = [];
      const ph = batch.map((r, j) => { vals.push(r.d, r.v); return `($${j * 2 + 1}::date, $${j * 2 + 2}::numeric)`; });
      await c.query(
        `INSERT INTO gold.daily_traffic_volume_corrected (date, total_volume) VALUES ${ph.join(",")}`, vals
      );
    }
    console.log(`Inserted ${rows.length} rows`);
    await c.query("COMMIT");
    console.log("Committed.");
  } catch (e) {
    await c.query("ROLLBACK");
    console.log("ROLLED BACK: " + e.message);
    c.release(); await p.end(); process.exit(1);
  }
  c.release();

  const after = await p.query(
    "SELECT EXTRACT(YEAR FROM date)::int y, COUNT(*)::int d, ROUND(AVG(total_volume))::bigint a FROM gold.daily_traffic_volume_corrected GROUP BY 1 ORDER BY 1"
  );
  console.log("\nAFTER:");
  after.rows.forEach((r) => console.log(`  ${r.y}  ${r.d} days  avg ${Number(r.a).toLocaleString()}`));

  const tot = await p.query("SELECT COUNT(*)::int n, MIN(date)::text lo, MAX(date)::text hi FROM gold.daily_traffic_volume_corrected");
  console.log(`\nTotal: ${tot.rows[0].n} days  ${tot.rows[0].lo} .. ${tot.rows[0].hi}`);
  await p.end();
})();
