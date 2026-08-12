/**
 * Removes the five unused tables left over from the pre-warehouse schema:
 *
 *   traffic_volumes  directional_flow  vehicle_classes  incidents_table  emissions_log
 *
 * All five are empty. Their real data lives in the warehouse
 * (nlex_traffic_volume, fact_incident_log, nlex_emissions, ...), and no code on
 * this branch reads or writes them.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  DO NOT RUN THIS YET.
 *
 *  As of 2026-08, several teammate branches (Jertz-Merged, NEW-YSA-MERGE,
 *  Updated-with-map, and older commits of Ver1-Merged-BE-FE) still query these
 *  tables. Today they read zero rows and fall back to mock data. Once the
 *  tables are gone those queries raise "relation does not exist" instead, so
 *  anyone running those branches gets a hard failure.
 *
 *  Run this only after every active branch has been merged onto the warehouse-
 *  backed services. Verify first with:
 *
 *    grep -rn "FROM \(traffic_volumes\|directional_flow\|vehicle_classes\|incidents_table\|emissions_log\)" Back-End/src
 *
 *  That must return nothing on every branch you still care about.
 * ────────────────────────────────────────────────────────────────────────
 *
 * Usage:  npx tsx scripts/drop-legacy-tables.ts            (dry run — shows what would happen)
 *         npx tsx scripts/drop-legacy-tables.ts --confirm  (actually drops)
 *
 * The script refuses to drop any table that has rows, so it cannot destroy data
 * even if one of them gets populated later. To restore, run RECREATE_DDL below.
 */
import { Pool } from "pg";
import { env } from "../src/config/env.js";

const LEGACY_TABLES = [
  "traffic_volumes",
  "directional_flow",
  "vehicle_classes",
  "incidents_table",
  "emissions_log",
];

/** Exact DDL captured from the live database — run this to undo the drop. */
export const RECREATE_DDL = `
CREATE TABLE IF NOT EXISTS traffic_volumes (
  id SERIAL PRIMARY KEY,
  segment_id VARCHAR(50) NOT NULL,
  volume_count INTEGER NOT NULL,
  avg_speed_kmh INTEGER NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS directional_flow (
  id SERIAL PRIMARY KEY,
  direction VARCHAR(2) NOT NULL,
  vehicle_count INTEGER NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicle_classes (
  id SERIAL PRIMARY KEY,
  class_type INTEGER NOT NULL,
  count INTEGER NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incidents_table (
  id SERIAL PRIMARY KEY,
  incident_id VARCHAR(50) NOT NULL,
  type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  km_marker NUMERIC NOT NULL,
  direction VARCHAR(2) NOT NULL,
  clearance_time_mins INTEGER,
  weather_condition VARCHAR(50),
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS emissions_log (
  id SERIAL PRIMARY KEY,
  aqi_level INTEGER NOT NULL,
  co2_emissions_tons NUMERIC NOT NULL,
  peak_penalty_applied BOOLEAN DEFAULT false,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`.trim();

const confirmed = process.argv.includes("--confirm");

if (!env.POSTGRES_URL) {
  console.error("No database configured — set POSTGRES_URL or PG_* in Back-End/.env");
  process.exit(1);
}

const db = new Pool({
  connectionString: env.POSTGRES_URL,
  ssl: env.PG_SSL_MODE === "disable" ? undefined : { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

async function main() {
  const client = await db.connect();
  try {
    console.log(confirmed ? "MODE: drop\n" : "MODE: dry run (pass --confirm to apply)\n");

    const droppable: string[] = [];

    for (const t of LEGACY_TABLES) {
      const reg = await client.query("SELECT to_regclass($1) AS r", [`public.${t}`]);
      if (!reg.rows[0].r) {
        console.log(`   skip   ${t.padEnd(20)} already absent`);
        continue;
      }

      const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
      if (rows[0].n > 0) {
        console.log(`   KEEP   ${t.padEnd(20)} has ${rows[0].n} row(s) — refusing to drop`);
        continue;
      }

      // Refuse if anything still depends on it.
      const deps = await client.query(
        `SELECT DISTINCT dep.relname
         FROM pg_depend d
         JOIN pg_rewrite r ON r.oid = d.objid
         JOIN pg_class dep ON dep.oid = r.ev_class
         WHERE d.refobjid = $1::regclass AND dep.relname <> $2`,
        [t, t]
      );
      if (deps.rows.length > 0) {
        console.log(`   KEEP   ${t.padEnd(20)} depended on by: ${deps.rows.map((x) => x.relname).join(", ")}`);
        continue;
      }

      droppable.push(t);
      console.log(`   ${confirmed ? "drop  " : "would drop"} ${t}`);
    }

    if (confirmed && droppable.length > 0) {
      // One transaction: either all five go or none do.
      await client.query("BEGIN");
      for (const t of droppable) await client.query(`DROP TABLE ${t}`);
      await client.query("COMMIT");
      console.log(`\nDropped ${droppable.length} table(s). To restore, run the SQL in RECREATE_DDL.`);
    } else if (!confirmed) {
      console.log(`\n${droppable.length} table(s) would be dropped. Re-run with --confirm to apply.`);
    }
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await db.end();
  }
}

main().catch((err) => {
  console.error("drop-legacy-tables failed:", err.message);
  process.exit(1);
});
