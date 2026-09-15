const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);
const f = (v) => Number(v ?? 0).toLocaleString("en-US");

(async () => {
  // 1. Which tables exist for emissions?
  const t = await p.query(`
    SELECT table_schema s, table_name n, table_type ty
    FROM information_schema.tables
    WHERE (table_name ILIKE '%emission%' OR table_name ILIKE '%carbon%' OR table_name ILIKE '%fleet%')
      AND table_schema IN ('bronze','silver','gold','public')
    ORDER BY 1,2`);
  console.log("EMISSION-RELATED TABLES");
  for (const r of t.rows) {
    try {
      const n = await p.query(`SELECT COUNT(*)::bigint c FROM "${r.s}"."${r.n}"`);
      console.log(`  ${(r.s + "." + r.n).padEnd(40)} ${String(r.ty).padEnd(16)} ${f(n.rows[0].c).padStart(10)} rows`);
    } catch { console.log(`  ${(r.s + "." + r.n).padEnd(40)} ${r.ty}  (unreadable)`); }
  }

  // 2. Shape + coverage of the main gold table.
  for (const tbl of ["gold.daily_emissions_summary", "silver.nlex_emissions_clean", "bronze.nlex_emission_factors"]) {
    const [sc, tb] = tbl.split(".");
    try {
      const c = await p.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position", [sc, tb]);
      if (!c.rowCount) continue;
      console.log(`\n${tbl}`);
      console.log("  " + c.rows.map((x) => x.column_name).join(", "));
      const names = c.rows.map((x) => x.column_name);
      const dcol = names.find((x) => /^date|day/i.test(x));
      if (dcol) {
        const d = await p.query(`SELECT MIN(${dcol})::text lo, MAX(${dcol})::text hi, COUNT(DISTINCT ${dcol})::int n FROM ${tbl}`);
        console.log(`  ${dcol}: ${d.rows[0].lo} .. ${d.rows[0].hi}  (${f(d.rows[0].n)} distinct)`);
      }
    } catch (e) { console.log(`\n${tbl}: ${e.message.slice(0, 60)}`); }
  }

  // 3. Is there ANY predictive/evaluation record for emissions?
  const tg = await p.query("SELECT DISTINCT target FROM gold.ml_model_metrics ORDER BY 1");
  console.log("\nTARGETS IN gold.ml_model_metrics:");
  tg.rows.forEach((r) => console.log(`  "${r.target}"`));

  const pred = await p.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='gold' AND table_name LIKE 'ml_%' ORDER BY 1`);
  console.log("\ngold.ml_* TABLES:");
  for (const r of pred.rows) {
    const n = await p.query(`SELECT COUNT(*)::bigint c FROM gold."${r.table_name}"`);
    console.log(`  ${r.table_name.padEnd(38)} ${f(n.rows[0].c).padStart(9)} rows`);
  }

  await p.end();
})();
