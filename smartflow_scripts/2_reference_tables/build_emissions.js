/**
 * Rebuilds vehicle CO2 from gold.fact_traffic_hourly x the DENR/DOTC factors.
 *
 * WHY NOT REUSE bronze.nlex_theoretical_emissions
 *   Its daily volume disagrees with the series we forecast (ratios 1.13-1.70 on
 *   consecutive days, so not a constant factor but a different series), and it
 *   covers 10 exits rather than the canonical 20. Building on it would make the
 *   CO2 panel contradict the volume panel.
 *
 * SEGMENT LENGTH
 *   Stored distances exist for only 10 exits, and km-post rules do not reproduce
 *   them (best rule MAE 2.38 km against a 3.78 km mean). So they are NOT derived
 *   from km-posts and are NOT guessed per exit. Instead each exit is assigned the
 *   corridor it "owns" — half the gap to each neighbour. That has the property
 *   the stored values lack: the segments TILE the corridor exactly once, so the
 *   summed length equals the corridor length and a corridor total neither
 *   double-counts nor leaves gaps. Marked as derived in the table comment.
 */
const { Pool } = require("pg");
const p = new Pool(require("../config/db.cjs").poolConfig);
const f = (v, d = 0) => Number(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const APPLY = process.argv.includes("--apply");

(async () => {
  const km = (await p.query(
    "SELECT exit_name, km_post::float km FROM gold.exit_km_post ORDER BY km_post")).rows;

  // Thiessen segments: midpoint to midpoint, endpoints extended to the ends.
  const seg = km.map((r, i) => {
    const lo = i === 0 ? km[0].km : (km[i - 1].km + r.km) / 2;
    const hi = i === km.length - 1 ? km[km.length - 1].km : (r.km + km[i + 1].km) / 2;
    return { exit: r.exit_name, km: r.km, len: +(hi - lo).toFixed(3) };
  });
  const total = seg.reduce((s, x) => s + x.len, 0);
  console.log("SEGMENT LENGTHS (half the gap to each neighbour)");
  seg.forEach((x) => console.log(`  ${x.exit.padEnd(26)} km ${String(x.km).padStart(5)}   segment ${x.len.toFixed(2)} km`));
  console.log(`  sum ${total.toFixed(2)} km  vs corridor span ${(km[km.length - 1].km - km[0].km).toFixed(2)} km  -> tiles exactly: ${Math.abs(total - (km[km.length - 1].km - km[0].km)) < 0.01}`);

  const ef = (await p.query(
    "SELECT vehicle_class vc, co2_g_per_km, co_g_per_km, no2_g_per_km, pm25_g_per_km FROM bronze.nlex_emission_factors ORDER BY vehicle_class")).rows;
  console.log("\nFACTORS: " + ef.map((x) => `c${x.vc}=${x.co2_g_per_km}g/km`).join("  "));

  if (!APPLY) { console.log("\n(dry run — pass --apply)"); await p.end(); return; }

  const c = await p.connect();
  try {
    await c.query("BEGIN");
    await c.query("DROP TABLE IF EXISTS gold.exit_segment_km");
    await c.query(`CREATE TABLE gold.exit_segment_km (
      exit_name text PRIMARY KEY, km_post numeric(6,1), segment_km numeric(6,3), derived boolean DEFAULT true)`);
    await c.query(`COMMENT ON TABLE gold.exit_segment_km IS
      'Corridor length attributed to each exit, as half the gap to each neighbour so the segments tile the corridor exactly once. DERIVED: bronze.nlex_theoretical_emissions stores distances for only 10 of 20 exits, and km-post rules do not reproduce them (best MAE 2.38 km vs a 3.78 km mean). Used to convert vehicle counts into vehicle-km for emission factors.'`);
    for (const x of seg) {
      await c.query("INSERT INTO gold.exit_segment_km (exit_name, km_post, segment_km) VALUES ($1,$2,$3)",
        [x.exit, x.km, x.len]);
    }

    await c.query("DROP TABLE IF EXISTS gold.fact_emissions_hourly");
    await c.query(`
      CREATE TABLE gold.fact_emissions_hourly AS
      SELECT t.date, t.hour, t.exit_canonical, t.direction,
             s.segment_km::numeric(6,3),
             t.class_1, t.class_2, t.class_3, t.total,
             (t.class_1 * s.segment_km * f1.co2_g_per_km
            + t.class_2 * s.segment_km * f2.co2_g_per_km
            + t.class_3 * s.segment_km * f3.co2_g_per_km) / 1e6 AS co2_tonnes,
             (t.class_1 * s.segment_km * f1.co_g_per_km
            + t.class_2 * s.segment_km * f2.co_g_per_km
            + t.class_3 * s.segment_km * f3.co_g_per_km) / 1e3 AS co_kg,
             (t.class_1 * s.segment_km * f1.no2_g_per_km
            + t.class_2 * s.segment_km * f2.no2_g_per_km
            + t.class_3 * s.segment_km * f3.no2_g_per_km) / 1e3 AS no2_kg,
             (t.class_1 * s.segment_km * f1.pm25_g_per_km
            + t.class_2 * s.segment_km * f2.pm25_g_per_km
            + t.class_3 * s.segment_km * f3.pm25_g_per_km) / 1e3 AS pm25_kg
      FROM gold.fact_traffic_hourly t
      JOIN gold.exit_segment_km s ON s.exit_name = t.exit_canonical
      CROSS JOIN (SELECT co2_g_per_km, co_g_per_km, no2_g_per_km, pm25_g_per_km FROM bronze.nlex_emission_factors WHERE vehicle_class=1) f1
      CROSS JOIN (SELECT co2_g_per_km, co_g_per_km, no2_g_per_km, pm25_g_per_km FROM bronze.nlex_emission_factors WHERE vehicle_class=2) f2
      CROSS JOIN (SELECT co2_g_per_km, co_g_per_km, no2_g_per_km, pm25_g_per_km FROM bronze.nlex_emission_factors WHERE vehicle_class=3) f3`);
    await c.query(`COMMENT ON TABLE gold.fact_emissions_hourly IS
      'Vehicle emissions computed from gold.fact_traffic_hourly (the same series the volume forecast uses) x per-class DENR/DOTC factors x gold.exit_segment_km. Reconciles with the volume panel by construction. Replaces bronze.nlex_theoretical_emissions, which was built on the superseded traffic series and covered 10 of 20 exits.'`);
    await c.query("CREATE INDEX ix_feh_date ON gold.fact_emissions_hourly (date)");
    await c.query("CREATE INDEX ix_feh_exit ON gold.fact_emissions_hourly (exit_canonical)");
    await c.query("ANALYZE gold.fact_emissions_hourly");
    await c.query("COMMIT");
    console.log("\nbuilt gold.fact_emissions_hourly");
  } catch (e) {
    await c.query("ROLLBACK");
    console.log("ROLLED BACK: " + e.message);
    c.release(); await p.end(); process.exit(1);
  }
  c.release();

  const n = await p.query(`SELECT COUNT(*)::bigint rows, COUNT(DISTINCT date)::int days,
    COUNT(DISTINCT exit_canonical)::int exits, MIN(date)::text lo, MAX(date)::text hi
    FROM gold.fact_emissions_hourly`);
  const r = n.rows[0];
  console.log(`  ${f(r.rows)} rows | ${f(r.days)} days ${r.lo}..${r.hi} | ${r.exits} exits`);

  const d = await p.query(`
    SELECT ROUND(AVG(v)::numeric,1) avg_t, ROUND(MIN(v)::numeric,1) lo, ROUND(MAX(v)::numeric,1) hi
    FROM (SELECT date, SUM(co2_tonnes) v FROM gold.fact_emissions_hourly GROUP BY date) x`);
  console.log(`\n  daily corridor CO2: mean ${d.rows[0].avg_t} t   range ${d.rows[0].lo} .. ${d.rows[0].hi} t`);

  // Must reconcile with the volume series it was built from.
  const rec = await p.query(`
    WITH e AS (SELECT date, SUM(total) v FROM gold.fact_emissions_hourly GROUP BY date)
    SELECT COUNT(*)::int n, ROUND(MAX(ABS(e.v - g.total_volume)),2) maxdiff
    FROM e JOIN gold.daily_traffic_volume_corrected g ON g.date = e.date`);
  console.log(`  volume reconciliation vs traffic series: ${f(rec.rows[0].n)} days, max diff ${rec.rows[0].maxdiff}`);

  const cls = await p.query(`
    SELECT ROUND(SUM(class_1 * segment_km * 192)/1e6)::bigint c1,
           ROUND(SUM(class_2 * segment_km * 354)/1e6)::bigint c2,
           ROUND(SUM(class_3 * segment_km * 1492)/1e6)::bigint c3,
           ROUND(SUM(class_1))::bigint v1, ROUND(SUM(class_2))::bigint v2, ROUND(SUM(class_3))::bigint v3
    FROM gold.fact_emissions_hourly`);
  const x = cls.rows[0];
  const tv = Number(x.v1) + Number(x.v2) + Number(x.v3), tc = Number(x.c1) + Number(x.c2) + Number(x.c3);
  console.log("\n  class share of VOLUME vs share of CO2:");
  [["Class 1", x.v1, x.c1], ["Class 2", x.v2, x.c2], ["Class 3", x.v3, x.c3]].forEach(([l, v, co]) =>
    console.log(`    ${l}  volume ${(Number(v) / tv * 100).toFixed(1)}%   CO2 ${(Number(co) / tc * 100).toFixed(1)}%`));

  await p.end();
})();
