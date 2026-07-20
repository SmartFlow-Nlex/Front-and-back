import { Pool } from "pg";
import { env } from "../src/config/env.js";

const db = env.POSTGRES_URL
  ? new Pool({ 
      connectionString: env.POSTGRES_URL.replace(/[?&]ssl=true/, ''),
      ssl: { rejectUnauthorized: false }
    })
  : null;

async function runSeeder() {
  if (!db) {
    console.error("No POSTGRES_URL found in environment. Skipping database seed.");
    process.exit(1);
  }

  console.log("Connecting to PostgreSQL...");
  const client = await db.connect();

  try {
    console.log("Creating tables...");

    // 1. Traffic Volumes (DEV-01)
    await client.query(`
      CREATE TABLE IF NOT EXISTS traffic_volumes (
        id SERIAL PRIMARY KEY,
        segment_id VARCHAR(50) NOT NULL,
        volume_count INT NOT NULL,
        avg_speed_kmh INT NOT NULL,
        recorded_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // 2. Directional Flow (DEV-02)
    await client.query(`
      CREATE TABLE IF NOT EXISTS directional_flow (
        id SERIAL PRIMARY KEY,
        direction VARCHAR(2) NOT NULL, -- 'NB' or 'SB'
        vehicle_count INT NOT NULL,
        recorded_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // 3. Vehicle Classes (DEV-03)
    await client.query(`
      CREATE TABLE IF NOT EXISTS vehicle_classes (
        id SERIAL PRIMARY KEY,
        class_type INT NOT NULL, -- 1, 2, or 3
        count INT NOT NULL,
        recorded_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // 4. INCIDENT (DEV-01)
    await client.query(`
      CREATE TABLE IF NOT EXISTS incidents_table (
        id SERIAL PRIMARY KEY,
        incident_id VARCHAR(50) UNIQUE NOT NULL,
        type VARCHAR(50) NOT NULL,
        severity VARCHAR(20) NOT NULL,
        km_marker DECIMAL NOT NULL,
        direction VARCHAR(2) NOT NULL,
        clearance_time_mins INT,
        weather_condition VARCHAR(50),
        reported_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // 5. SUSTAIN (DEV-01)
    await client.query(`
      CREATE TABLE IF NOT EXISTS emissions_log (
        id SERIAL PRIMARY KEY,
        aqi_level INT NOT NULL,
        co2_emissions_tons DECIMAL NOT NULL,
        peak_penalty_applied BOOLEAN DEFAULT FALSE,
        recorded_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // 6. SANDBOX (DEV-01)
    await client.query(`
      CREATE TABLE IF NOT EXISTS sandbox_simulations (
        id SERIAL PRIMARY KEY,
        simulation_id VARCHAR(50) UNIQUE NOT NULL,
        parameters JSONB NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        results JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // 7. MAINT (DEV-01)
    await client.query(`
      CREATE TABLE IF NOT EXISTS maintenance_schedules (
        id SERIAL PRIMARY KEY,
        segment_id VARCHAR(50) NOT NULL,
        description TEXT,
        start_date TIMESTAMP NOT NULL,
        end_date TIMESTAMP NOT NULL,
        status VARCHAR(20) DEFAULT 'scheduled'
      );
    `);

    // 8. UPLOAD (DEV-01)
    await client.query(`
      CREATE TABLE IF NOT EXISTS data_uploads (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'uploaded',
        processed_records INT DEFAULT 0,
        uploaded_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // 9. AUDIT (DEV-01)
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        action VARCHAR(100) NOT NULL,
        target_resource VARCHAR(100),
        details JSONB,
        timestamp TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    console.log("Tables created successfully. Seeding data...");

    // Clear existing data
    await client.query("TRUNCATE traffic_volumes, directional_flow, vehicle_classes, incidents_table, emissions_log, sandbox_simulations, maintenance_schedules, data_uploads, audit_logs RESTART IDENTITY CASCADE");

    // Seed Volumes
    await client.query(`
      INSERT INTO traffic_volumes (segment_id, volume_count, avg_speed_kmh) VALUES 
      ('NB-01', 1200, 65),
      ('NB-02', 2500, 20),
      ('SB-01', 950, 80),
      ('SB-02', 1100, 75);
    `);

    // Seed Directional Flow
    await client.query(`
      INSERT INTO directional_flow (direction, vehicle_count) VALUES 
      ('NB', 154000),
      ('SB', 142000);
    `);

    // Seed Vehicle Classes
    await client.query(`
      INSERT INTO vehicle_classes (class_type, count) VALUES 
      (1, 280000),
      (2, 50000),
      (3, 20000);
    `);

    // Seed Incidents
    await client.query(`
      INSERT INTO incidents_table (incident_id, type, severity, km_marker, direction, clearance_time_mins, weather_condition) VALUES 
      ('INC-992', 'Traffic Jam', 'High', 14.5, 'NB', 45, 'Clear'),
      ('INC-993', 'Construction', 'Medium', 26.2, 'SB', NULL, 'Clear');
    `);

    // Seed Emissions
    await client.query(`
      INSERT INTO emissions_log (aqi_level, co2_emissions_tons, peak_penalty_applied) VALUES 
      (45, 120.5, FALSE),
      (150, 450.2, TRUE);
    `);

    console.log("Database seeded successfully!");
  } catch (err) {
    console.error("Error seeding database:", err);
  } finally {
    client.release();
    await db.end();
  }
}

runSeeder();
