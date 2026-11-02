/**
 * Rebuilds emissions from what each trip drove, on cited factors (1 Nov 2026). Uploads keep it current afterwards;
 * this is for the years already loaded, whose entry-exit rows only exist in the yearly files.
 *
 *   npx tsx scripts/build-vehicle-km.ts km <north_tir_YYYY...csv ...> <nlex_traffic_hourly_2026.csv>
 *       gold.fact_vkm_hourly, a year at a time, each in its own transaction, so a dropped connection costs one year.
 *       Prints each file's trips against the warehouse: a file that is not what was loaded must not be used.
 *   npx tsx scripts/build-vehicle-km.ts swap
 *       Factors, gold.open_plaza_km and gold.fact_emissions_hourly, in one transaction.
 *       The previous table and factors stay in ml_backup, suffix _20261101.
 *   npx tsx scripts/build-vehicle-km.ts undo
 *       Puts them back.
 */
import "dotenv/config";
import fs from "node:fs";
import { db } from "../src/config/db.js";
import { aggregateTollHourly, EMISSIONS_COLUMNS, EMISSIONS_SELECT, insertVkm, loadCutoff, type TollHourlyAggregate } from "../src/etl/toll-hourly.js";
import { aggregateTir, isTirFile, readLevelAdjustment } from "../src/etl/toll-tir.js";
import { openTripKm } from "../src/etl/trip-km.js";
import { exitMeasuredKm } from "../src/lib/km-post.js";
import type { RawRow } from "../src/etl/parser.js";

const SUFFIX = "20261101";
const pool = db!;

/* EMEP/EEA air pollutant emission inventory guidebook 2023 (Update 2024), chapter 1.A.3.b.i-iv.
   g fuel/km: Table 3-15 (Tier 1 typical) or Table 3-27 (Tier 2). kg CO2/kg fuel: Table 3-12. CO, NOx, PM g/kg fuel: Tables 3-5, 3-6.
   Classes as the operator defines them (PhilRatings, NLEX Corporation, Nov 2024): light vehicles; buses and small trucks; large trucks. */
const PETROL = 3.168, DIESEL = 3.18;
const FACTORS = [
  {
    cls: 1, label: "Light Vehicles (Class 1)", fuel: 61.9, co2Kg: PETROL, low: 56.8 * DIESEL, high: 79.0 * DIESEL, co: 48.36, nox: 3.98, pm: 0.02,
    note: "Passenger car, petrol: 61.9 g fuel/km (Table 3-15) x 3.168 kg CO2/kg (Table 3-12); CO, NOx, PM Tables 3-5 and 3-6. Low: passenger car, diesel, 56.8 g/km. High: light commercial, diesel, 79.0 g/km.",
  },
  {
    cls: 2, label: "Buses and Small Trucks (Class 2)", fuel: 216.8, co2Kg: DIESEL, low: 155 * DIESEL, high: 263 * DIESEL, co: 6.1, nox: 25.95, pm: 0.55,
    note: "Heavy-duty diesel, all sizes: 216.8 g fuel/km (Table 3-15) x 3.180 kg CO2/kg; CO, NOx, PM Tables 3-5 and 3-6. Low: truck 7.5-16 t Euro I+, 155 g/km. High: coach, conventional, 263 g/km (Table 3-27).",
  },
  {
    cls: 3, label: "Large Trucks (Class 3)", fuel: 251, co2Kg: DIESEL, low: 210 * DIESEL, high: 297 * DIESEL, co: 6.1, nox: 25.95, pm: 0.55,
    note: "Heavy-duty truck over 32 t, Euro I+: 251 g fuel/km (Table 3-27) x 3.180 kg CO2/kg; CO, NOx, PM per kg fuel Tables 3-5 and 3-6. Low: 16-32 t Euro I+, 210 g/km. High: over 32 t conventional, 297 g/km.",
  },
];
const SOURCE = "EMEP/EEA Guidebook 2023 (Update 2024), 1.A.3.b.i-iv";

/** Each file's lines as rows, for the nlex_traffic_hourly layout. */
function* hourlyRows(file: string): Generator<RawRow> {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(8 * 1024 * 1024);
  let rest = "", head: string[] | null = null;
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    const parts = (rest + buf.toString("utf8", 0, n)).split("\n");
    rest = parts.pop() ?? "";
    for (const raw of parts) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!head) { head = line.replace(/^﻿/, "").split(","); continue; }
      if (!line) continue;
      const f = line.split(",");
      const row: RawRow = {};
      head.forEach((h, i) => { row[h] = f[i] ?? null; });
      yield row;
    }
  }
  fs.closeSync(fd);
}

/** The file's trips by class against the warehouse's for the same days, and which fact keys only one side has. */
async function compare(agg: TollHourlyAggregate, y: string) {
  const { rows } = await pool.query(
    `SELECT sum(class_1)::float c1, sum(class_2)::float c2, sum(class_3)::float c3, count(*)::int n FROM gold.fact_traffic_hourly WHERE date >= $1 AND date <= $2`,
    [`${y}-01-01`, `${y}-12-31`],
  );
  const s = [0, 0, 0];
  for (const v of agg.fact.values()) { s[0] += v[0]; s[1] += v[1]; s[2] += v[2]; }
  const w = rows[0];
  const pct = (a: number, b: number) => `${(100 * (a / b - 1)).toFixed(3)}%`;
  console.log(`  file vs warehouse: class 1 ${pct(s[0], w.c1)}, class 2 ${pct(s[1], w.c2)}, class 3 ${pct(s[2], w.c3)}; keys ${agg.fact.size} vs ${w.n}`);
  return [s[0] / w.c1, s[1] / w.c2, s[2] / w.c3].every((r) => Math.abs(r - 1) < 0.0005);
}

async function km(files: string[]) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gold.fact_vkm_hourly (
      date date NOT NULL, hour smallint NOT NULL, exit_canonical text NOT NULL, direction text, role text, toll_system text, status text NOT NULL,
      vkm_1 numeric NOT NULL DEFAULT 0, vkm_2 numeric NOT NULL DEFAULT 0, vkm_3 numeric NOT NULL DEFAULT 0)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_fvh_date ON gold.fact_vkm_hourly (date)`);
  await pool.query(`COMMENT ON TABLE gold.fact_vkm_hourly IS
    'Vehicle-km driven on NLEX per plaza-hour, on the key of gold.fact_traffic_hourly, from each trip''s entry and exit plaza (Back-End/src/etl/trip-km.ts). status off_nlex: trips paid on SCTEX, SFEX or the Connector, on their NLEX entry plaza. status off_nlex_est: 2026 only, whose file has no such rows; each hour''s Class km x the 2025 ratio of off-NLEX to paid km, shared among plazas as in 2025.'`);
  const adjust = await readLevelAdjustment();
  for (const file of files) {
    const t0 = Date.now();
    const agg = isTirFile(file) ? aggregateTir(file, adjust).agg : aggregateTollHourly(hourlyRows(file), loadCutoff());
    const year = agg.dates[0].slice(0, 4);
    console.log(`${year}: ${agg.dates.length} days, ${agg.vkm.size} rows, ${((Date.now() - t0) / 1000).toFixed(0)} s read`);
    if (!(await compare(agg, year))) throw new Error(`${file} is not what the warehouse holds for ${year}: stopped, ${year} not written`);
    const missing = [...agg.fact.keys()].filter((k) => !agg.vkm.has(k)).length;
    if (missing) throw new Error(`${missing} fact keys have no vehicle-km`);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`DELETE FROM gold.fact_vkm_hourly WHERE date >= $1 AND date <= $2`, [`${year}-01-01`, `${year}-12-31`]);
      await insertVkm(c, "gold.fact_vkm_hourly", [...agg.vkm.entries()]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    console.log(`  written, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  // The 2026 file has no trip paid off NLEX, which 2025 has 14.9% of its NLEX km in: without this the series would step down on 1 Jan.
  const est = await pool.connect();
  await est.query("SET statement_timeout = 0");
  await est.query(`DELETE FROM gold.fact_vkm_hourly WHERE status = 'off_nlex_est'`);
  const r = await est.query(`
    WITH y25 AS (SELECT * FROM gold.fact_vkm_hourly WHERE date BETWEEN '2025-01-01' AND '2025-12-31'),
    ratio AS (
      SELECT sum(vkm_1) FILTER (WHERE status = 'off_nlex') / sum(vkm_1) FILTER (WHERE status <> 'off_nlex') r1,
             sum(vkm_2) FILTER (WHERE status = 'off_nlex') / sum(vkm_2) FILTER (WHERE status <> 'off_nlex') r2,
             sum(vkm_3) FILTER (WHERE status = 'off_nlex') / sum(vkm_3) FILTER (WHERE status <> 'off_nlex') r3 FROM y25),
    share AS (
      SELECT exit_canonical, direction, role, toll_system,
             sum(vkm_1) / sum(sum(vkm_1)) OVER () s1, sum(vkm_2) / sum(sum(vkm_2)) OVER () s2, sum(vkm_3) / sum(sum(vkm_3)) OVER () s3
        FROM y25 WHERE status = 'off_nlex' GROUP BY 1, 2, 3, 4),
    hourly AS (SELECT date, hour, sum(vkm_1) k1, sum(vkm_2) k2, sum(vkm_3) k3 FROM gold.fact_vkm_hourly WHERE date >= '2026-01-01' AND status = 'nlex' GROUP BY 1, 2)
    INSERT INTO gold.fact_vkm_hourly (date, hour, exit_canonical, direction, role, toll_system, status, vkm_1, vkm_2, vkm_3)
    SELECT h.date, h.hour, s.exit_canonical, s.direction, s.role, s.toll_system, 'off_nlex_est',
           round(h.k1 * ra.r1 * s.s1, 2), round(h.k2 * ra.r2 * s.s2, 2), round(h.k3 * ra.r3 * s.s3, 2)
      FROM hourly h CROSS JOIN ratio ra CROSS JOIN share s`);
  est.release();
  console.log(`2026 off-NLEX estimate: ${r.rowCount} rows`);
  await pool.query("ANALYZE gold.fact_vkm_hourly");
}

async function swap() {
  const c = await pool.connect();
  try {
    await c.query("SET statement_timeout = 0"); // the rebuild is the whole table; the pool's limit is for page queries
    await c.query("BEGIN");
    await c.query(`CREATE TABLE ml_backup.nlex_emission_factors_bronze_${SUFFIX} AS TABLE bronze.nlex_emission_factors`);
    await c.query(`CREATE TABLE ml_backup.nlex_emission_factors_silver_${SUFFIX} AS TABLE silver.nlex_emission_factors`);
    const view = (await c.query(`SELECT pg_get_viewdef('public.nlex_emission_factors'::regclass) AS d`)).rows[0].d as string;
    await c.query(`CREATE TABLE ml_backup.nlex_emission_factors_view_${SUFFIX} AS SELECT $1::text AS definition`, [view]);

    for (const t of ["bronze", "silver"]) {
      await c.query(`ALTER TABLE ${t}.nlex_emission_factors ADD COLUMN co2_low_g_per_km double precision, ADD COLUMN co2_high_g_per_km double precision`);
      for (const f of FACTORS) {
        const co2 = f.fuel * f.co2Kg, g = (perKg: number) => (perKg * f.fuel) / 1000;
        await c.query(
          `UPDATE ${t}.nlex_emission_factors
              SET class_label = $2, co2_g_per_km = $3, co2_low_g_per_km = $4, co2_high_g_per_km = $5, co_g_per_km = $6, no2_g_per_km = $7,
                  pm25_g_per_km = $8, pm10_g_per_km = $8, so2_g_per_km = NULL, source = $9, description = $10, recorded_at = now()
            WHERE vehicle_class = $1`,
          [f.cls, f.label, co2, f.low, f.high, g(f.co), g(f.nox), g(f.pm), SOURCE, f.note],
        );
      }
    }
    await c.query(`COMMENT ON COLUMN bronze.nlex_emission_factors.no2_g_per_km IS 'NOx as EMEP/EEA reports it, not NO2 alone. The column keeps its name for what reads it.'`);
    await c.query(`COMMENT ON COLUMN bronze.nlex_emission_factors.so2_g_per_km IS 'Not set: EMEP/EEA computes SO2 from fuel sulphur, no cited Philippine figure is held, and nothing reads this column.'`);
    await c.query(`CREATE OR REPLACE VIEW public.nlex_emission_factors AS ${view.trim().replace(/;$/, "").replace(/\n\s*FROM\s/i, ",\n    co2_low_g_per_km,\n    co2_high_g_per_km\n   FROM ")}`);

    await c.query(`DROP TABLE IF EXISTS gold.open_plaza_km`);
    await c.query(`CREATE TABLE gold.open_plaza_km (exit_canonical text NOT NULL, direction text, km_low numeric, km_central numeric, km_high numeric)`);
    await c.query(`COMMENT ON TABLE gold.open_plaza_km IS
      'Trips paid on entry in the open section have no exit on record. km_central is the mean of the exits ahead up to the closed system (ADB Performance Evaluation Report PHI 2011, Table A6.2 note a); km_low and km_high are the nearest and farthest of them, the hard bounds.'`);
    const open = await c.query(`SELECT DISTINCT exit_canonical, direction FROM gold.fact_traffic_hourly WHERE toll_system = 'OS' AND role = 'Entry'`);
    for (const r of open.rows as { exit_canonical: string; direction: string | null }[]) {
      const k = openTripKm(exitMeasuredKm(r.exit_canonical)!, r.direction);
      await c.query(`INSERT INTO gold.open_plaza_km VALUES ($1, $2, $3, $4, $5)`, [r.exit_canonical, r.direction, k.low, k.central, k.high]);
    }

    await c.query(`ALTER TABLE gold.fact_emissions_hourly SET SCHEMA ml_backup`);
    await c.query(`ALTER TABLE ml_backup.fact_emissions_hourly RENAME TO fact_emissions_hourly_${SUFFIX}`);
    await c.query(`CREATE TABLE gold.fact_emissions_hourly (
      date date, hour smallint, exit_canonical text, direction text, class_1 numeric, class_2 numeric, class_3 numeric, total numeric,
      vkm_1 numeric, vkm_2 numeric, vkm_3 numeric, co2_tonnes double precision, co_kg double precision, no2_kg double precision, pm25_kg double precision)`);
    const ins = await c.query(`INSERT INTO gold.fact_emissions_hourly (${EMISSIONS_COLUMNS}) ${EMISSIONS_SELECT}`);
    console.log(`emission rows ${ins.rowCount}`);
    await c.query(`COMMENT ON TABLE gold.fact_emissions_hourly IS
      'Modelled tailpipe emissions per plaza-hour: gold.fact_vkm_hourly vehicle-km by class x the EMEP/EEA factors in bronze.nlex_emission_factors. no2_kg holds NOx. Not measured: no CO2 is metered on NLEX. Rows with total 0 are trips paid off NLEX.'`);
    await c.query(`CREATE INDEX ix_feh_date_2 ON gold.fact_emissions_hourly (date)`);
    await c.query(`CREATE INDEX ix_feh_exit_2 ON gold.fact_emissions_hourly (exit_canonical)`);
    const chk = (await c.query(`
      SELECT (SELECT round(sum(total)) FROM gold.fact_emissions_hourly) a, (SELECT round(sum(total)) FROM gold.fact_traffic_hourly) b,
             (SELECT round(sum(vkm_1+vkm_2+vkm_3)) FROM gold.fact_emissions_hourly) v, (SELECT round(sum(vkm_1+vkm_2+vkm_3)) FROM gold.fact_vkm_hourly) w`)).rows[0];
    if (chk.a !== chk.b || chk.v !== chk.w) throw new Error(`does not reconcile: ${JSON.stringify(chk)}`);
    console.log(`reconciled: trips ${chk.a}, vehicle-km ${chk.v}`);
    await c.query("COMMIT");
  } catch (e: any) {
    await c.query("ROLLBACK");
    console.log("ROLLED BACK, nothing changed: " + e.message);
    process.exitCode = 1;
  } finally {
    c.release();
  }
  await pool.query("ANALYZE gold.fact_emissions_hourly");
}

async function undo() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`DROP TABLE gold.fact_emissions_hourly`);
    await c.query(`ALTER TABLE ml_backup.fact_emissions_hourly_${SUFFIX} SET SCHEMA gold`);
    await c.query(`ALTER TABLE gold.fact_emissions_hourly_${SUFFIX} RENAME TO fact_emissions_hourly`);
    const view = (await c.query(`SELECT definition FROM ml_backup.nlex_emission_factors_view_${SUFFIX}`)).rows[0].definition as string;
    await c.query(`DROP VIEW public.nlex_emission_factors`);
    for (const t of ["bronze", "silver"]) {
      await c.query(`ALTER TABLE ${t}.nlex_emission_factors DROP COLUMN co2_low_g_per_km, DROP COLUMN co2_high_g_per_km`);
      await c.query(`DELETE FROM ${t}.nlex_emission_factors`);
      await c.query(`INSERT INTO ${t}.nlex_emission_factors SELECT * FROM ml_backup.nlex_emission_factors_${t}_${SUFFIX}`);
    }
    await c.query(`CREATE VIEW public.nlex_emission_factors AS ${view}`);
    await c.query(`DROP TABLE ml_backup.nlex_emission_factors_bronze_${SUFFIX}, ml_backup.nlex_emission_factors_silver_${SUFFIX}, ml_backup.nlex_emission_factors_view_${SUFFIX}`);
    await c.query("COMMIT");
    console.log("put back");
  } catch (e: any) {
    await c.query("ROLLBACK");
    console.log("ROLLED BACK: " + e.message);
    process.exitCode = 1;
  } finally {
    c.release();
  }
}

const [mode, ...files] = process.argv.slice(2);
if (mode === "km") await km(files);
else if (mode === "swap") await swap();
else if (mode === "undo") await undo();
else console.log("km <files...> | swap | undo");
await pool.end();
process.exit(process.exitCode ?? 0);
