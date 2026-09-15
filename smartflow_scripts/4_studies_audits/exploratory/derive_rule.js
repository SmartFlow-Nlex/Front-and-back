const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);
const f = (v) => (v == null ? "n/a" : Number(v).toLocaleString("en-US"));

(async () => {
  const pl = await p.query(
    "SELECT toll_plaza, direction, COUNT(*)::int n FROM silver.nlex_traffic_volume_clean GROUP BY 1,2 ORDER BY 1,2");
  const plazas = [...new Set(pl.rows.map((r) => r.toll_plaza))];
  console.log(`silver.nlex_traffic_volume_clean: ${plazas.length} distinct plazas`);
  console.log("  " + plazas.join(" | "));

  const map = await p.query("SELECT source_name, canonical_exit FROM gold.exit_name_map ORDER BY 1");
  const mapped = new Set(map.rows.map((r) => r.source_name));
  console.log(`\nexit_name_map has ${map.rowCount} source names`);
  const unmapped = plazas.filter((x) => !mapped.has(x));
  console.log("  silver plazas NOT in exit_name_map: " + (unmapped.length ? unmapped.join(", ") : "none"));
  const direct = plazas.filter((x) => map.rows.some((r) => r.canonical_exit === x));
  console.log("  silver plazas that ARE already canonical: " + direct.length);

  // Candidate rule: canonicalise, keep only (exit, direction) pairs that actually
  // have an entry, count entries only.
  const RULE = `
    WITH canon AS (
      SELECT s.date_day AS date, s.direction,
             COALESCE(m.canonical_exit, s.toll_plaza) AS exit_name,
             s.total_volume
      FROM silver.nlex_traffic_volume_clean s
      LEFT JOIN gold.exit_name_map m ON m.source_name = s.toll_plaza
    ), kept AS (
      SELECT c.date, c.total_volume
      FROM canon c
      JOIN gold.exit_direction_role r
        ON r.exit_name = c.exit_name AND r.direction = c.direction AND r.has_entry
    )
    SELECT date, SUM(total_volume)::numeric v FROM kept GROUP BY date`;

  const cmp = await p.query(`
    WITH derived AS (${RULE})
    SELECT COUNT(*)::int n,
           SUM(CASE WHEN ROUND(d.v) = ROUND(b.total_volume) THEN 1 ELSE 0 END)::int exact,
           ROUND(AVG(d.v))::bigint davg, ROUND(AVG(b.total_volume))::bigint bavg,
           ROUND(CORR(d.v, b.total_volume)::numeric, 6) r
    FROM derived d
    JOIN gold.daily_traffic_volume_corrected_bak_20260829 b ON b.date = d.date`);
  const c = cmp.rows[0];
  console.log(`\nRULE vs backup (the original corrected series):`);
  console.log(`  matched days      : ${f(c.n)}`);
  console.log(`  EXACT value match : ${f(c.exact)}  (${((c.exact / c.n) * 100).toFixed(2)}%)`);
  console.log(`  derived avg ${f(c.davg)}   backup avg ${f(c.bavg)}`);
  console.log(`  correlation r = ${c.r}`);

  const ex = await p.query(`
    WITH derived AS (${RULE})
    SELECT d.date::text, ROUND(d.v)::bigint derived, b.total_volume::bigint backup,
           ROUND(d.v - b.total_volume)::bigint diff
    FROM derived d JOIN gold.daily_traffic_volume_corrected_bak_20260829 b ON b.date = d.date
    ORDER BY d.date LIMIT 5`);
  console.log("\n  sample:");
  ex.rows.forEach((r) => console.log(`    ${r.date}  derived ${f(r.derived).padStart(9)}  backup ${f(r.backup).padStart(9)}  diff ${f(r.diff)}`));

  await p.end();
})();
