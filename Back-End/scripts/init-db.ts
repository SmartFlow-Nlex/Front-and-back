import { Pool } from "pg";
import { env } from "../src/config/env.js";

const db = env.POSTGRES_URL
  ? new Pool({
      connectionString: env.POSTGRES_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

async function runSeeder() {
  if (!db) {
    console.error("No POSTGRES_URL found in environment. Skipping database seed.");
    process.exit(1);
  }

  console.log("Connecting to AWS PostgreSQL...");
  const client = await db.connect();

  try {
    console.log("Creating tables...\n");

    // ─────────────────────────────────────────────────────────
    // 1. Traffic Volumes — matches traffic_volume_synthetic.csv
    //    Columns: Date, Direction, Type, Toll Plaza, Vehicle Class, h00–h23
    // ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS nlex_traffic_volumes (
        id BIGSERIAL PRIMARY KEY,
        date DATE NOT NULL,
        direction TEXT NOT NULL,
        type TEXT NOT NULL,
        toll_plaza TEXT NOT NULL,
        vehicle_class TEXT NOT NULL,
        h00 INTEGER DEFAULT 0, h01 INTEGER DEFAULT 0, h02 INTEGER DEFAULT 0,
        h03 INTEGER DEFAULT 0, h04 INTEGER DEFAULT 0, h05 INTEGER DEFAULT 0,
        h06 INTEGER DEFAULT 0, h07 INTEGER DEFAULT 0, h08 INTEGER DEFAULT 0,
        h09 INTEGER DEFAULT 0, h10 INTEGER DEFAULT 0, h11 INTEGER DEFAULT 0,
        h12 INTEGER DEFAULT 0, h13 INTEGER DEFAULT 0, h14 INTEGER DEFAULT 0,
        h15 INTEGER DEFAULT 0, h16 INTEGER DEFAULT 0, h17 INTEGER DEFAULT 0,
        h18 INTEGER DEFAULT 0, h19 INTEGER DEFAULT 0, h20 INTEGER DEFAULT 0,
        h21 INTEGER DEFAULT 0, h22 INTEGER DEFAULT 0, h23 INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("  ✅ nlex_traffic_volumes");

    // Indexes for traffic queries
    await client.query(`CREATE INDEX IF NOT EXISTS idx_traffic_date ON nlex_traffic_volumes(date);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_traffic_direction ON nlex_traffic_volumes(direction);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_traffic_toll_plaza ON nlex_traffic_volumes(toll_plaza);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_traffic_vehicle_class ON nlex_traffic_volumes(vehicle_class);`);

    // ─────────────────────────────────────────────────────────
    // 2. Road Crash Reports — matches road_crash_reports_synthetic.csv
    // ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS nlex_road_crashes (
        id BIGSERIAL PRIMARY KEY,
        no INTEGER,
        date TEXT,
        reported_time TEXT,
        response_time TEXT,
        cleared_time TEXT,
        location TEXT,
        lane_occupied TEXT,
        no_of_vehicles_involved INTEGER,
        cause_of_accident TEXT,
        type_of_accident TEXT,
        weather_condition TEXT,
        type_of_pavement TEXT,
        injuries_male INTEGER DEFAULT 0,
        injuries_female INTEGER DEFAULT 0,
        fatalities_male INTEGER DEFAULT 0,
        fatalities_female INTEGER DEFAULT 0,
        damage_to_toll_property TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("  ✅ nlex_road_crashes");

    await client.query(`CREATE INDEX IF NOT EXISTS idx_road_crashes_date ON nlex_road_crashes(date);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_road_crashes_weather ON nlex_road_crashes(weather_condition);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_road_crashes_cause ON nlex_road_crashes(cause_of_accident);`);

    // ─────────────────────────────────────────────────────────
    // 3. Motorcycle Crash Reports — same structure as road crashes
    // ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS nlex_motorcycle_crashes (
        id BIGSERIAL PRIMARY KEY,
        no INTEGER,
        date TEXT,
        reported_time TEXT,
        response_time TEXT,
        cleared_time TEXT,
        location TEXT,
        lane_occupied TEXT,
        no_of_vehicles_involved INTEGER,
        cause_of_accident TEXT,
        type_of_accident TEXT,
        weather_condition TEXT,
        type_of_pavement TEXT,
        injuries_male INTEGER DEFAULT 0,
        injuries_female INTEGER DEFAULT 0,
        fatalities_male INTEGER DEFAULT 0,
        fatalities_female INTEGER DEFAULT 0,
        damage_to_toll_property TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("  ✅ nlex_motorcycle_crashes");

    await client.query(`CREATE INDEX IF NOT EXISTS idx_moto_crashes_date ON nlex_motorcycle_crashes(date);`);

    // ─────────────────────────────────────────────────────────
    // 4. Stalled Vehicle Reports — matches stalled_vehicles_reports_synthetic.csv
    // ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS nlex_stalled_vehicles (
        id BIGSERIAL PRIMARY KEY,
        no INTEGER,
        date TEXT,
        reported_time TEXT,
        responded_time TEXT,
        cleared_time TEXT,
        entry_point TEXT,
        vehicle_cause TEXT,
        location TEXT,
        driver_gender TEXT,
        assistance_rendered TEXT,
        remarks TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("  ✅ nlex_stalled_vehicles");

    await client.query(`CREATE INDEX IF NOT EXISTS idx_stalled_date ON nlex_stalled_vehicles(date);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_stalled_cause ON nlex_stalled_vehicles(vehicle_cause);`);

    // ─────────────────────────────────────────────────────────
    // 5. Apprehension Reports — matches apprehension_reports_synthetic.csv
    // ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS nlex_apprehensions (
        id BIGSERIAL PRIMARY KEY,
        no INTEGER,
        date TEXT,
        time TEXT,
        vehicle_model TEXT,
        driver_gender TEXT,
        violation TEXT,
        action_taken TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("  ✅ nlex_apprehensions");

    await client.query(`CREATE INDEX IF NOT EXISTS idx_apprehensions_date ON nlex_apprehensions(date);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_apprehensions_violation ON nlex_apprehensions(violation);`);

    // ─────────────────────────────────────────────────────────
    // 6. Data Uploads — tracks upload history
    // ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS data_uploads (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        dataset_type VARCHAR(50) NOT NULL,
        status VARCHAR(50) DEFAULT 'processing',
        total_rows INTEGER DEFAULT 0,
        processed_rows INTEGER DEFAULT 0,
        failed_rows INTEGER DEFAULT 0,
        error_message TEXT,
        uploaded_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
    `);
    console.log("  ✅ data_uploads");

    // ─────────────────────────────────────────────────────────
    // 7. Audit Logs — keep existing
    // ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        action VARCHAR(100) NOT NULL,
        target_resource VARCHAR(100),
        details JSONB,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("  ✅ audit_logs");

    // ─────────────────────────────────────────────────────────
    // Keep existing emissions/nlex tables if they exist (from nlex-emissions migration)
    // ─────────────────────────────────────────────────────────

    console.log("\n════════════════════════════════════════════════");
    console.log("  ✅ ALL TABLES CREATED SUCCESSFULLY");
    console.log("════════════════════════════════════════════════");

    // Verify table counts
    const tables = [
      "nlex_traffic_volumes", "nlex_road_crashes", "nlex_motorcycle_crashes",
      "nlex_stalled_vehicles", "nlex_apprehensions", "data_uploads", "audit_logs"
    ];
    for (const t of tables) {
      const { rows } = await client.query(`SELECT COUNT(*) FROM ${t}`);
      console.log(`  ${t}: ${rows[0].count} rows`);
    }
    console.log("════════════════════════════════════════════════\n");

  } catch (err) {
    console.error("Error creating tables:", err);
  } finally {
    client.release();
    await db.end();
  }
}

runSeeder();
