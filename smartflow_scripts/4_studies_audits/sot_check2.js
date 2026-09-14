const { Pool } = require("pg");
const p = new Pool(require("../config/db.cjs").poolConfig);
const f = (v) => (v == null ? "n/a" : Number(v).toLocaleString("en-US"));

(async () => {
  const c = await p.query(`
    SELECT a.attname FROM pg_attribute a
    JOIN pg_class cl ON cl.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE n.nspname='public' AND cl.relname='nlex_traffic_volume' AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`);
  const names = c.rows.map((r) => r.attname);
  console.log("DESCRIPTIVE  public.nlex_traffic_volume  [materialized view]");
  console.log("  columns: " + names.join(", "));

  const hcols = names.filter((x) => /^h\d\d$/.test(x));
  const expr = hcols.length ? hcols.map((x) => `COALESCE(${x},0)`).join("+") : "total_volume";
  console.log(`  daily total expression: ${hcols.length ? hcols.length + " hourly cols summed" : "total_volume"}`);

  const d = await p.query(
    `SELECT MIN(date)::text lo, MAX(date)::text hi, COUNT(DISTINCT date)::int days,
            COUNT(DISTINCT toll_plaza)::int plazas, COUNT(*)::bigint rows
     FROM public.nlex_traffic_volume`);
  console.log(`  range : ${d.rows[0].lo} .. ${d.rows[0].hi}`);
  console.log(`  ${f(d.rows[0].days)} days | ${d.rows[0].plazas} plazas | ${f(d.rows[0].rows)} rows`);

  const dd = await p.query(
    `SELECT ROUND(AVG(t))::bigint avg FROM (SELECT date, SUM(${expr}) t FROM public.nlex_traffic_volume GROUP BY date) x`);
  console.log(`  avg daily total: ${f(dd.rows[0].avg)}`);

  const g = await p.query(
    "SELECT MIN(date)::text lo, MAX(date)::text hi, COUNT(*)::int days, ROUND(AVG(total_volume))::bigint avg FROM gold.daily_traffic_volume_corrected");
  console.log(`\nPREDICTIVE  gold.daily_traffic_volume_corrected`);
  console.log(`  range : ${g.rows[0].lo} .. ${g.rows[0].hi}`);
  console.log(`  ${f(g.rows[0].days)} days`);
  console.log(`  avg daily total: ${f(g.rows[0].avg)}`);

  const ov = await p.query(
    `WITH dd AS (SELECT date, SUM(${expr}) v FROM public.nlex_traffic_volume GROUP BY date),
          pp AS (SELECT date, total_volume v FROM gold.daily_traffic_volume_corrected)
     SELECT COUNT(*)::int n, MIN(dd.date)::text lo, MAX(dd.date)::text hi,
            ROUND(AVG(dd.v))::bigint davg, ROUND(AVG(pp.v))::bigint pavg,
            ROUND(CORR(dd.v, pp.v)::numeric,4) r
     FROM dd JOIN pp ON pp.date = dd.date`);
  const o = ov.rows[0];
  console.log(`\nOVERLAP`);
  console.log(`  ${f(o.n)} shared days  ${o.lo} .. ${o.hi}`);
  console.log(`  descriptive avg ${f(o.davg)}  |  predictive avg ${f(o.pavg)}`);
  console.log(`  gap ${f(Number(o.davg) - Number(o.pavg))}  (${((Number(o.davg) / Number(o.pavg) - 1) * 100).toFixed(1)}%)`);
  console.log(`  correlation r = ${o.r}`);

  const orph = await p.query(
    `SELECT COUNT(DISTINCT date)::int n, MIN(date)::text lo, MAX(date)::text hi
     FROM public.nlex_traffic_volume
     WHERE date NOT IN (SELECT date FROM gold.daily_traffic_volume_corrected)`);
  console.log(`\n  Days in DESCRIPTIVE with no PREDICTIVE counterpart: ${f(orph.rows[0].n)}  (${orph.rows[0].lo} .. ${orph.rows[0].hi})`);

  await p.end();
})();
