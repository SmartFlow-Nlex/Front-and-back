/**
 * Database initialiser / verifier for SmartFlow.
 *
 * The warehouse is a medallion layout and is NOT created here:
 *
 *   bronze  raw ingested data          (nlex_traffic_volume, nlex_incidents, ...)
 *   silver  cleaned facts & dimensions (fact_incident_log, dim_location, ...)
 *   gold    aggregates & ML outputs    (ml_predictive_volume, ...)
 *   public  views/matviews over the above, which the API reads
 *
 * Those are produced by the data pipeline, so this script does not attempt to
 * recreate them — it VERIFIES they are present and reports anything missing.
 *
 * What it does create are the four tables the *application* owns: rows the API
 * writes at runtime rather than data the pipeline loads. Those are safe to
 * create on a fresh database.
 *
 * Usage:  npm run init-db          (create app tables + verify warehouse)
 *         npm run init-db -- --verify-only   (verify, create nothing)
 *
 * NOTE: this replaces an older version of this script that created a flat
 * schema (traffic_volumes, incidents_table, emissions_log, directional_flow,
 * vehicle_classes). Those tables still exist in the database but are empty and
 * unused — no code reads or writes them. Do not reintroduce them.
 */
import { Pool } from "pg";
import { env } from "../src/config/env.js";

const verifyOnly = process.argv.includes("--verify-only");

if (!env.POSTGRES_URL) {
  console.error(
    "No database configured. Set POSTGRES_URL, or PG_HOST/PG_DATABASE/PG_USER/PG_PASSWORD,\n" +
      "in Back-End/.env (copy Back-End/.env.example to start)."
  );
  process.exit(1);
}

const db = new Pool({
  connectionString: env.POSTGRES_URL,
  ssl: env.PG_SSL_MODE === "disable" ? undefined : { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

/** Tables the API writes at runtime. Safe to create; mirrors the live schema. */
const APP_TABLES: { name: string; ddl: string; indexes: string[] }[] = [
  {
    name: "audit_logs",
    ddl: `
      CREATE TABLE IF NOT EXISTS audit_logs (
        id              BIGSERIAL PRIMARY KEY,
        user_id         VARCHAR(100) NOT NULL,
        action          VARCHAR(120) NOT NULL,
        target_resource VARCHAR(160),
        details         JSONB DEFAULT '{}'::jsonb,
        timestamp       TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    indexes: [
      `CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit_logs ("timestamp" DESC)`,
      `CREATE INDEX IF NOT EXISTS ix_audit_user_action ON audit_logs (user_id, action)`,
    ],
  },
  {
    name: "data_uploads",
    ddl: `
      CREATE TABLE IF NOT EXISTS data_uploads (
        id                BIGSERIAL PRIMARY KEY,
        filename          VARCHAR(255) NOT NULL,
        dataset_type      VARCHAR(80),
        status            VARCHAR(50) NOT NULL DEFAULT 'uploaded',
        processed_records INTEGER NOT NULL DEFAULT 0,
        uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    indexes: [`CREATE INDEX IF NOT EXISTS ix_uploads_at ON data_uploads (uploaded_at DESC)`],
  },
  {
    name: "nlex_maintenance_schedules",
    // gen_random_uuid() comes from pgcrypto, already installed on this database.
    ddl: `
      CREATE TABLE IF NOT EXISTS nlex_maintenance_schedules (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title         TEXT NOT NULL,
        description   TEXT,
        start_km      NUMERIC NOT NULL,
        end_km        NUMERIC NOT NULL,
        direction     TEXT NOT NULL,
        lane_closure  TEXT NOT NULL,
        starts_at     TIMESTAMPTZ NOT NULL,
        ends_at       TIMESTAMPTZ NOT NULL,
        status        TEXT NOT NULL DEFAULT 'scheduled',
        status_reason TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    indexes: [
      `CREATE INDEX IF NOT EXISTS ix_maint_status_starts ON nlex_maintenance_schedules (status, starts_at DESC)`,
    ],
  },
  {
    name: "sandbox_simulations",
    ddl: `
      CREATE TABLE IF NOT EXISTS sandbox_simulations (
        id            BIGSERIAL PRIMARY KEY,
        simulation_id VARCHAR(80) NOT NULL UNIQUE,
        parameters    JSONB NOT NULL,
        status        VARCHAR(30) NOT NULL DEFAULT 'pending',
        results       JSONB,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    indexes: [],
  },
];

/** Warehouse relations the API reads. Verified, never created. */
const WAREHOUSE_READS = [
  "nlex_traffic_volume", "nlex_road_crashes", "nlex_motorcycle_crashes",
  "nlex_stalled_vehicles", "nlex_emissions", "nlex_theoretical_emissions",
  "nlex_emission_factors", "nlex_exits", "philippine_arena_events",
  "fact_incident_log", "fact_hourly_jams", "dim_incident_type",
  "dim_time", "hourly_weather", "ml_daily_actuals", "ml_predictive_incidents",
  // Built by `npm run seed-holidays` — if this is missing or empty, run that.
  "ph_holidays",
  "gold.ml_predictive_volume", "gold.ml_predictive_congestion", "gold.ml_event_surge_forecast",
  "silver.nlex_accident_events_clean", "silver.nlex_breakdown_events_clean",
];

/** Bronze tables the ETL writes into on upload. */
const WAREHOUSE_WRITES = [
  "bronze.nlex_traffic_volume", "bronze.nlex_incidents",
  "bronze.nlex_theoretical_emissions", "bronze.nlex_emissions",
  "bronze.nlex_accident_data", "bronze.nlex_breakdown_data",
];

async function main() {
  const client = await db.connect();
  let problems = 0;

  try {
    const who = await client.query("SELECT current_database() AS db, current_user AS usr");
    console.log(`Connected to ${who.rows[0].db} as ${who.rows[0].usr}\n`);

    // ── Application-owned tables ──────────────────────────────────────
    if (verifyOnly) {
      console.log("Application tables (verify only):");
    } else {
      console.log("Application tables:");
    }
    for (const t of APP_TABLES) {
      const existed = (await client.query("SELECT to_regclass($1) AS r", [t.name])).rows[0].r !== null;
      if (!existed && verifyOnly) {
        console.log(`   MISSING  ${t.name}`);
        problems++;
        continue;
      }
      if (!existed) {
        await client.query(t.ddl);
        for (const ix of t.indexes) await client.query(ix);
        console.log(`   created  ${t.name}`);
      } else {
        // Present already — make sure the indexes exist, then leave data alone.
        if (!verifyOnly) for (const ix of t.indexes) await client.query(ix);
        console.log(`   ok       ${t.name}`);
      }
    }

    // ── Warehouse relations ───────────────────────────────────────────
    console.log("\nWarehouse relations the API reads:");
    for (const name of WAREHOUSE_READS) {
      const reg = await client.query("SELECT to_regclass($1) AS r", [name]);
      if (!reg.rows[0].r) {
        console.log(`   MISSING  ${name}`);
        problems++;
        continue;
      }
      const n = await client.query(`SELECT COUNT(*)::int AS n FROM ${name}`);
      const count = n.rows[0].n;
      console.log(`   ${count > 0 ? "ok      " : "EMPTY   "} ${name.padEnd(36)} ${count.toLocaleString()}`);
      if (count === 0) problems++;
    }

    console.log("\nBronze tables the ETL writes to:");
    for (const name of WAREHOUSE_WRITES) {
      const reg = await client.query("SELECT to_regclass($1) AS r", [name]);
      if (!reg.rows[0].r) {
        console.log(`   MISSING  ${name}`);
        problems++;
      } else {
        console.log(`   ok       ${name}`);
      }
    }

    console.log(
      problems === 0
        ? "\nAll good — schema is complete."
        : `\n${problems} issue(s) above. Missing or empty warehouse relations mean the data ` +
            `pipeline has not been run against this database; the API will fall back to mock data ` +
            `for the affected dashboards.`
    );
    process.exitCode = problems === 0 ? 0 : 1;
  } finally {
    client.release();
    await db.end();
  }
}

main().catch((err) => {
  console.error("init-db failed:", err.message);
  process.exit(1);
});
