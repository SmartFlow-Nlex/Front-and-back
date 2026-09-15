const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);
const f = (v) => (v == null ? "n/a" : Number(v).toLocaleString("en-US"));

const BAK = "gold.daily_traffic_volume_corrected_bak_20260829";

async function test(label, sql) {
  try {
    const r = await p.query(`
      WITH d AS (${sql})
      SELECT COUNT(*)::int n,
             SUM(CASE WHEN ROUND(d.v) = ROUND(b.total_volume) THEN 1 ELSE 0 END)::int exact,
             ROUND(AVG(d.v))::bigint davg, ROUND(AVG(b.total_volume))::bigint bavg,
             ROUND(AVG(d.v / NULLIF(b.total_volume,0))::numeric, 4) ratio,
             ROUND(CORR(d.v, b.total_volume)::numeric, 6) corr
      FROM d JOIN ${BAK} b ON b.date = d.date`);
    const c = r.rows[0];
    console.log(`  ${label.padEnd(46)} exact ${String(c.exact).padStart(5)}/${c.n}  avg ${f(c.davg).padStart(10)}  ratio ${c.ratio}  r ${c.corr}`);
    return c;
  } catch (e) {
    console.log(`  ${label.padEnd(46)} ERROR ${e.message.slice(0, 60)}`);
    return null;
  }
}

(async () => {
  const b = await p.query(`SELECT ROUND(AVG(total_volume))::bigint a FROM ${BAK}`);
  console.log(`TARGET (backup) avg daily: ${f(b.rows[0].a)}\n`);

  const CANON = `
    SELECT s.date_day AS date, s.direction, s.hour_of_day,
           COALESCE(m.canonical_exit, s.toll_plaza) AS exit_name,
           s.total_volume, s.volume_class1, s.volume_class2, s.volume_class3
    FROM silver.nlex_traffic_volume_clean s
    LEFT JOIN gold.exit_name_map m ON m.source_name = s.toll_plaza`;

  console.log("Hypotheses:");
  await test("raw sum, no filter",
    `SELECT date_day AS date, SUM(total_volume)::numeric v FROM silver.nlex_traffic_volume_clean GROUP BY 1`);

  await test("canon + has_entry",
    `WITH c AS (${CANON}) SELECT c.date, SUM(c.total_volume)::numeric v FROM c
     JOIN gold.exit_direction_role r ON r.exit_name=c.exit_name AND r.direction=c.direction AND r.has_entry GROUP BY 1`);

  await test("canon + role='Entry' exactly",
    `WITH c AS (${CANON}) SELECT c.date, SUM(c.total_volume)::numeric v FROM c
     JOIN gold.exit_direction_role r ON r.exit_name=c.exit_name AND r.direction=c.direction AND r.role='Entry' GROUP BY 1`);

  await test("canon + has_entry, class1 only",
    `WITH c AS (${CANON}) SELECT c.date, SUM(c.volume_class1)::numeric v FROM c
     JOIN gold.exit_direction_role r ON r.exit_name=c.exit_name AND r.direction=c.direction AND r.has_entry GROUP BY 1`);

  await test("canon + has_entry, /4",
    `WITH c AS (${CANON}) SELECT c.date, (SUM(c.total_volume)/4.0)::numeric v FROM c
     JOIN gold.exit_direction_role r ON r.exit_name=c.exit_name AND r.direction=c.direction AND r.has_entry GROUP BY 1`);

  await test("canon + has_entry, DISTINCT rows",
    `WITH c AS (SELECT DISTINCT s.date_day AS date, s.direction, s.hour_of_day, s.toll_plaza,
                       COALESCE(m.canonical_exit, s.toll_plaza) AS exit_name, s.total_volume
                FROM silver.nlex_traffic_volume_clean s
                LEFT JOIN gold.exit_name_map m ON m.source_name = s.toll_plaza)
     SELECT c.date, SUM(c.total_volume)::numeric v FROM c
     JOIN gold.exit_direction_role r ON r.exit_name=c.exit_name AND r.direction=c.direction AND r.has_entry GROUP BY 1`);

  // Is silver duplicated per row key?
  const dup = await p.query(`
    SELECT COUNT(*)::bigint rows,
           COUNT(DISTINCT (date_day, hour_of_day, toll_plaza, direction))::bigint keys
    FROM silver.nlex_traffic_volume_clean`);
  console.log(`\nsilver rows ${f(dup.rows[0].rows)} vs distinct (date,hour,plaza,dir) keys ${f(dup.rows[0].keys)}`);
  console.log(`  duplication factor: ${(Number(dup.rows[0].rows) / Number(dup.rows[0].keys)).toFixed(3)}`);

  // What does gold.daily_traffic_volume (uncorrected) look like?
  const un = await p.query("SELECT ROUND(AVG(total_volume))::bigint a, COUNT(*)::int n FROM gold.daily_traffic_volume");
  console.log(`\ngold.daily_traffic_volume (uncorrected): avg ${f(un.rows[0].a)} over ${f(un.rows[0].n)} days`);
  const ratio = Number(un.rows[0].a) / Number(b.rows[0].a);
  console.log(`  uncorrected / corrected = ${ratio.toFixed(4)}`);

  await p.end();
})();
