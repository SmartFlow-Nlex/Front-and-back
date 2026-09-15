const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);
const f = (v) => Number(v ?? 0).toLocaleString("en-US");

const TABLES = [
  "silver.waze_hourly_jams_clean",
  "silver.fact_waze_jams",
  "bronze.waze_hourly_jams",
  "bronze.waze_hourly_irregularities",
];

(async () => {
  for (const t of TABLES) {
    const [s, tab] = t.split(".");
    try {
      const c = await p.query(
        "SELECT column_name c FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position", [s, tab]);
      if (!c.rowCount) { console.log(`\n${t}: no columns (view?)`); continue; }
      const n = await p.query(`SELECT COUNT(*)::bigint n FROM ${t}`);
      console.log(`\n${t}  — ${f(n.rows[0].n)} rows`);
      console.log("  " + c.rows.map((r) => r.c).join(", "));

      const names = c.rows.map((r) => r.c);
      const dateCol = names.find((x) => /date|day|timestamp|hour_ts/i.test(x));
      if (dateCol) {
        const d = await p.query(`SELECT MIN(${dateCol})::text lo, MAX(${dateCol})::text hi FROM ${t}`);
        console.log(`  ${dateCol}: ${d.rows[0].lo} .. ${d.rows[0].hi}`);
      }
      const segCol = names.find((x) => /segment|street|road|location|name/i.test(x));
      if (segCol) {
        const g = await p.query(`SELECT ${segCol} s, COUNT(*)::int n FROM ${t} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`);
        console.log(`  ${segCol} (top 12 of ${(await p.query(`SELECT COUNT(DISTINCT ${segCol})::int n FROM ${t}`)).rows[0].n}):`);
        g.rows.forEach((r) => console.log(`    ${String(r.s).slice(0, 44).padEnd(46)} ${f(r.n)}`));
      }
      for (const sc of names.filter((x) => /speed|level|delay|length/i.test(x))) {
        const r = await p.query(`SELECT ROUND(MIN(${sc})::numeric,2) lo, ROUND(MAX(${sc})::numeric,2) hi, ROUND(AVG(${sc})::numeric,2) avg, COUNT(*) FILTER (WHERE ${sc} IS NULL)::int nulls FROM ${t}`);
        console.log(`  ${sc}: ${r.rows[0].lo} .. ${r.rows[0].hi}  avg ${r.rows[0].avg}  nulls ${f(r.rows[0].nulls)}`);
      }
    } catch (e) { console.log(`\n${t}: ERROR ${e.message.slice(0, 70)}`); }
  }
  await p.end();
})();
