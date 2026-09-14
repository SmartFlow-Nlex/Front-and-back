const fs = require("fs");
const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);
const f = (v) => Number(v).toLocaleString("en-US");
const APPLY = process.argv.includes("--apply");
const DEFOUT = require("path").join(__dirname, "../../_work") + "/old_matview_definition.sql";

(async () => {
  const shape = await p.query(
    `SELECT direction, role, toll_system, COUNT(*)::int n FROM gold.fact_traffic_hourly GROUP BY 1,2,3 ORDER BY 4 DESC`);
  console.log("fact table shape (direction / role / system):");
  shape.rows.forEach((r) => console.log(`  ${String(r.direction).padEnd(6)} ${String(r.role).padEnd(6)} ${String(r.toll_system).padEnd(5)} ${f(r.n)}`));

  const old = await p.query(
    "SELECT definition FROM pg_matviews WHERE schemaname='public' AND matviewname='nlex_traffic_volume'");
  if (old.rowCount) {
    fs.writeFileSync(DEFOUT, old.rows[0].definition, "utf8");
    console.log(`\nOld definition saved -> ${DEFOUT} (${old.rows[0].definition.length} chars)`);
  }

  const hcols = Array.from({ length: 24 }, (_, h) => {
    const hh = String(h).padStart(2, "0");
    return `SUM(CASE WHEN f.hour = ${h} THEN f.v ELSE 0 END)::numeric AS h${hh}`;
  }).join(",\n         ");

  // Same column shape the Descriptive service already queries, so no API or
  // frontend change is needed: date, toll_plaza, direction, type, vehicle_class,
  // h00..h23. Only the SOURCE changes — now the same fact table the forecast
  // series rolls up from.
  const SQL = `
    CREATE MATERIALIZED VIEW public.nlex_traffic_volume_new AS
    WITH unpivot AS (
      SELECT t.date, t.hour, t.exit_canonical AS toll_plaza, t.direction,
             -- Every source row is ONE tolled trip already counted once: Open
             -- System collects at the entry barrier, Closed System at the exit.
             -- The legacy contract used type='Entries' to mean "the deduplicated
             -- trip count" (see retrain_honest.py: "counts entries only - one
             -- count per trip"), so all rows carry that label and the existing
             -- queries keep their exact meaning. The real collection side is
             -- preserved separately in toll_role rather than being discarded.
             'Entries'::text AS type,
             t.role AS toll_role,
             cls.vehicle_class, cls.v
      FROM gold.fact_traffic_hourly t
      CROSS JOIN LATERAL (VALUES
        ('Class 1', t.class_1), ('Class 2', t.class_2),
        ('Class 3', t.class_3), ('Total',   t.total)
      ) AS cls(vehicle_class, v)
    )
    SELECT date, toll_plaza, direction, type, toll_role, vehicle_class,
           ${hcols}
    FROM unpivot f
    GROUP BY date, toll_plaza, direction, type, toll_role, vehicle_class`;

  if (!APPLY) { console.log("\n(dry run — pass --apply)"); await p.end(); return; }

  await p.query("DROP MATERIALIZED VIEW IF EXISTS public.nlex_traffic_volume_new");
  console.log("\nbuilding new matview...");
  const t0 = Date.now();
  await p.query(SQL);
  await p.query("CREATE INDEX ix_ntv_new_date ON public.nlex_traffic_volume_new (date)");
  await p.query("CREATE INDEX ix_ntv_new_plaza ON public.nlex_traffic_volume_new (toll_plaza)");
  await p.query("ANALYZE public.nlex_traffic_volume_new");
  console.log(`  built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const sum = "h00+h01+h02+h03+h04+h05+h06+h07+h08+h09+h10+h11+h12+h13+h14+h15+h16+h17+h18+h19+h20+h21+h22+h23";
  const n = await p.query(`
    SELECT COUNT(*)::bigint rows, COUNT(DISTINCT toll_plaza)::int plazas,
           COUNT(DISTINCT date)::int days, MIN(date)::text lo, MAX(date)::text hi
    FROM public.nlex_traffic_volume_new`);
  const r = n.rows[0];
  console.log(`\nNEW matview: ${f(r.rows)} rows | ${r.plazas} plazas | ${f(r.days)} days ${r.lo}..${r.hi}`);

  const rec = await p.query(`
    WITH d AS (SELECT date, SUM(${sum}) v FROM public.nlex_traffic_volume_new
               WHERE vehicle_class = 'Total' GROUP BY date)
    SELECT COUNT(*)::int n,
           SUM(CASE WHEN ROUND(d.v) = ROUND(g.total_volume) THEN 1 ELSE 0 END)::int exact,
           ROUND(MAX(ABS(d.v - g.total_volume)),2) maxdiff,
           ROUND(AVG(d.v))::bigint davg, ROUND(AVG(g.total_volume))::bigint gavg
    FROM d JOIN gold.daily_traffic_volume_corrected g ON g.date = d.date`);
  const q = rec.rows[0];
  console.log(`\nRECONCILIATION  Descriptive(new) vs Predictive daily series:`);
  console.log(`  days ${f(q.n)} | EXACT ${f(q.exact)} | max diff ${q.maxdiff}`);
  console.log(`  descriptive avg ${f(q.davg)}  |  predictive avg ${f(q.gavg)}`);

  const cls = await p.query(`
    SELECT vehicle_class, ROUND(AVG(dv))::bigint avg FROM (
      SELECT vehicle_class, date, SUM(${sum}) dv
      FROM public.nlex_traffic_volume_new GROUP BY 1,2) x GROUP BY 1 ORDER BY 1`);
  console.log("\n  avg daily by vehicle_class (Total must equal C1+C2+C3):");
  let s = 0;
  cls.rows.forEach((x) => { if (x.vehicle_class !== "Total") s += Number(x.avg); console.log(`    ${x.vehicle_class.padEnd(8)} ${f(x.avg)}`); });
  console.log(`    C1+C2+C3 ${f(s)}`);

  await p.end();
})();
