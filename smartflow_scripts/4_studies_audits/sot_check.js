const { Pool } = require("pg");
const p = new Pool(require("../config/db.cjs").poolConfig);
const f = (v) => (v == null ? "n/a" : Number(v).toLocaleString("en-US"));

(async () => {
  // pg_attribute, not information_schema.columns: rebuild_descriptive.js turned
  // this table into a MATERIALIZED VIEW, and information_schema does not list a
  // matview's columns - the list came back empty and the query below became SUM().
  const cols = await p.query(
    `SELECT attname AS column_name FROM pg_attribute
     WHERE attrelid = 'public.nlex_traffic_volume'::regclass AND attnum > 0 AND NOT attisdropped
     ORDER BY attnum`);
  const hcols = cols.rows.map((r) => r.column_name).filter((c) => /^h\d\d$/.test(c));
  console.log(`DESCRIPTIVE source: public.nlex_traffic_volume`);
  console.log(`  hourly columns: ${hcols.length} (${hcols[0]}..${hcols[hcols.length - 1]})`);

  const sum = hcols.map((c) => `COALESCE(${c},0)`).join("+");
  const d = await p.query(
    `SELECT MIN(date)::text lo, MAX(date)::text hi, COUNT(DISTINCT date)::int days,
            COUNT(DISTINCT toll_plaza)::int plazas
     FROM public.nlex_traffic_volume`);
  console.log(`  range: ${d.rows[0].lo} .. ${d.rows[0].hi}   ${f(d.rows[0].days)} days   ${d.rows[0].plazas} plazas`);

  const dd = await p.query(
    `SELECT ROUND(AVG(t))::bigint avg FROM (
       SELECT date, SUM(${sum}) t FROM public.nlex_traffic_volume GROUP BY date) x`);
  console.log(`  avg daily total: ${f(dd.rows[0].avg)}`);

  const g = await p.query(
    "SELECT MIN(date)::text lo, MAX(date)::text hi, COUNT(*)::int days, ROUND(AVG(total_volume))::bigint avg FROM gold.daily_traffic_volume_corrected");
  console.log(`\nPREDICTIVE source: gold.daily_traffic_volume_corrected`);
  console.log(`  range: ${g.rows[0].lo} .. ${g.rows[0].hi}   ${f(g.rows[0].days)} days`);
  console.log(`  avg daily total: ${f(g.rows[0].avg)}`);

  // Overlap
  const ov = await p.query(
    `WITH desc_d AS (SELECT date, SUM(${sum}) v FROM public.nlex_traffic_volume GROUP BY date),
          pred_d AS (SELECT date, total_volume v FROM gold.daily_traffic_volume_corrected)
     SELECT COUNT(*)::int n, MIN(d.date)::text lo, MAX(d.date)::text hi,
            ROUND(AVG(d.v))::bigint davg, ROUND(AVG(pr.v))::bigint pavg,
            ROUND(CORR(d.v, pr.v)::numeric, 4) r
     FROM desc_d d JOIN pred_d pr ON pr.date = d.date`);
  const o = ov.rows[0];
  console.log(`\nOVERLAP (dates present in BOTH):`);
  if (!o.n) { console.log("  none"); }
  else {
    console.log(`  ${f(o.n)} days   ${o.lo} .. ${o.hi}`);
    console.log(`  descriptive avg ${f(o.davg)}   predictive avg ${f(o.pavg)}   gap ${f(Number(o.davg) - Number(o.pavg))}`);
    console.log(`  correlation r = ${o.r}   <- do they describe the same road?`);
  }

  // Dates in descriptive that predictive no longer has
  const orph = await p.query(
    `SELECT COUNT(DISTINCT date)::int n, MIN(date)::text lo, MAX(date)::text hi
     FROM public.nlex_traffic_volume
     WHERE date NOT IN (SELECT date FROM gold.daily_traffic_volume_corrected)`);
  console.log(`\nDates in DESCRIPTIVE but NOT in PREDICTIVE: ${f(orph.rows[0].n)} days  ${orph.rows[0].lo} .. ${orph.rows[0].hi}`);

  await p.end();
})();
