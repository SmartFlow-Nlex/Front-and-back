throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
// ============================================================
// NLEX Emissions — Supabase Setup Script
// Creates tables + seeds all 50 exit points + emission factors
// ============================================================

import pg from 'pg';
const { Client } = pg;

// ── Config ───────────────────────────────────────────────────
const SUPABASE_REF = 'cksprtvjsjrsldamlylc';
const DB_PASSWORD = process.env.SUPABASE_DB_PASSWORD;

if (!DB_PASSWORD) {
  console.error(`
╔══════════════════════════════════════════════════════════════╗
║  Missing SUPABASE_DB_PASSWORD environment variable!         ║
║                                                              ║
║  Get it from: Supabase Dashboard → Project Settings          ║
║               → Database → Database password                 ║
║                                                              ║
║  Then run:                                                   ║
║  $env:SUPABASE_DB_PASSWORD="REMOVED"; node setup.js    ║
╚══════════════════════════════════════════════════════════════╝
  `);
  process.exit(1);
}

// Session mode pooler (port 5432) — required for DDL (CREATE TABLE)
const connectionString = `postgresql://postgres.${SUPABASE_REF}:REMOVED@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`;

// ── SQL: Create Tables ───────────────────────────────────────
const CREATE_TABLES_SQL = `
-- Drop existing tables if re-running
DROP TABLE IF EXISTS nlex_emissions CASCADE;
DROP TABLE IF EXISTS nlex_emission_factors CASCADE;
DROP TABLE IF EXISTS nlex_exits CASCADE;

-- 1. NLEX Exit Points (50 total: 24 NB + 26 SB)
CREATE TABLE nlex_exits (
  id SERIAL PRIMARY KEY,
  exit_number INTEGER NOT NULL,
  exit_name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('NB', 'SB')),
  km_marker NUMERIC(5,1) NOT NULL,
  latitude NUMERIC(10,4) NOT NULL,
  longitude NUMERIC(10,4) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Vehicle Emission Factors (Class 1, 2, 3 per NLEX/TRB)
CREATE TABLE nlex_emission_factors (
  id SERIAL PRIMARY KEY,
  vehicle_class INTEGER NOT NULL CHECK (vehicle_class IN (1, 2, 3)),
  class_label TEXT NOT NULL,
  description TEXT,
  co2_g_per_km NUMERIC(10,2) NOT NULL,
  co_g_per_km NUMERIC(10,4) NOT NULL,
  no2_g_per_km NUMERIC(10,4) NOT NULL,
  pm25_g_per_km NUMERIC(10,4) NOT NULL,
  pm10_g_per_km NUMERIC(10,4) NOT NULL,
  so2_g_per_km NUMERIC(10,4) NOT NULL,
  source TEXT DEFAULT 'EURO IV/V Philippine Fleet Average',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Air Quality / Emissions Readings (time-series from API)
CREATE TABLE nlex_emissions (
  id BIGSERIAL PRIMARY KEY,
  exit_id INTEGER REFERENCES nlex_exits(id) ON DELETE CASCADE,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  aqi INTEGER,
  co NUMERIC(10,2),
  "no" NUMERIC(10,2),
  no2 NUMERIC(10,2),
  o3 NUMERIC(10,2),
  so2 NUMERIC(10,2),
  nh3 NUMERIC(10,2),
  pm2_5 NUMERIC(10,2),
  pm10 NUMERIC(10,2),
  api_dt INTEGER,
  raw_response JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast queries
CREATE INDEX idx_nlex_emissions_exit_id ON nlex_emissions(exit_id);
CREATE INDEX idx_nlex_emissions_fetched_at ON nlex_emissions(fetched_at);
CREATE INDEX idx_nlex_exits_direction ON nlex_exits(direction);

-- Enable RLS but add permissive policies for service access
ALTER TABLE nlex_exits ENABLE ROW LEVEL SECURITY;
ALTER TABLE nlex_emission_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE nlex_emissions ENABLE ROW LEVEL SECURITY;

-- Allow public read access
CREATE POLICY "Allow public read on nlex_exits" ON nlex_exits FOR SELECT USING (true);
CREATE POLICY "Allow public read on nlex_emission_factors" ON nlex_emission_factors FOR SELECT USING (true);
CREATE POLICY "Allow public read on nlex_emissions" ON nlex_emissions FOR SELECT USING (true);

-- Allow anon insert for ingestion scripts
CREATE POLICY "Allow anon insert on nlex_emissions" ON nlex_emissions FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon insert on nlex_exits" ON nlex_exits FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon insert on nlex_emission_factors" ON nlex_emission_factors FOR INSERT WITH CHECK (true);
`;

// ── Seed Data: Northbound Exits (24) ─────────────────────────
const NB_EXITS = [
  { exit_number: 1,  exit_name: 'Balintawak (NB entry)',            km_marker: 0,   latitude: 14.6545, longitude: 121.0020 },
  { exit_number: 2,  exit_name: 'Mindanao Ave / Bignay (NB)',       km_marker: 3,   latitude: 14.6680, longitude: 120.9900 },
  { exit_number: 3,  exit_name: 'Valenzuela / Gen. T. De Leon (NB)',km_marker: 7,   latitude: 14.6929, longitude: 120.9740 },
  { exit_number: 4,  exit_name: 'Karuhatan (NB)',                   km_marker: 9,   latitude: 14.7020, longitude: 120.9660 },
  { exit_number: 5,  exit_name: 'Tambubong / Paso de Blas (NB)',    km_marker: 11,  latitude: 14.7130, longitude: 120.9560 },
  { exit_number: 6,  exit_name: 'Meycauayan (NB)',                  km_marker: 15,  latitude: 14.7380, longitude: 120.9540 },
  { exit_number: 7,  exit_name: 'Marilao (NB)',                     km_marker: 18,  latitude: 14.7580, longitude: 120.9480 },
  { exit_number: 8,  exit_name: 'Bocaue (NB)',                      km_marker: 22,  latitude: 14.7976, longitude: 120.9316 },
  { exit_number: 9,  exit_name: 'Balagtas (NB)',                    km_marker: 26,  latitude: 14.8205, longitude: 120.9100 },
  { exit_number: 10, exit_name: 'Tabang / Guiguinto (NB)',          km_marker: 29,  latitude: 14.8450, longitude: 120.8890 },
  { exit_number: 11, exit_name: 'Santa Rita / Guiguinto (NB)',      km_marker: 30,  latitude: 14.8460, longitude: 120.8860 },
  { exit_number: 12, exit_name: 'Plaridel (NB)',                    km_marker: 34,  latitude: 14.8780, longitude: 120.8680 },
  { exit_number: 13, exit_name: 'Pulilan (NB)',                     km_marker: 37,  latitude: 14.9010, longitude: 120.8560 },
  { exit_number: 14, exit_name: 'Calumpit (NB)',                    km_marker: 42,  latitude: 14.9220, longitude: 120.8300 },
  { exit_number: 15, exit_name: 'Apalit (NB)',                      km_marker: 50,  latitude: 14.9540, longitude: 120.7590 },
  { exit_number: 16, exit_name: 'San Simon (NB)',                   km_marker: 54,  latitude: 14.9870, longitude: 120.7270 },
  { exit_number: 17, exit_name: 'Santo Tomas (NB)',                 km_marker: 57,  latitude: 15.0100, longitude: 120.7050 },
  { exit_number: 18, exit_name: 'San Fernando (NB)',                km_marker: 61,  latitude: 15.0300, longitude: 120.6900 },
  { exit_number: 19, exit_name: 'San Fernando 2 / JASA (NB)',       km_marker: 63,  latitude: 15.0430, longitude: 120.6780 },
  { exit_number: 20, exit_name: 'Mexico (NB)',                      km_marker: 67,  latitude: 15.0680, longitude: 120.6570 },
  { exit_number: 21, exit_name: 'Angeles / City of Victoria (NB)',  km_marker: 71,  latitude: 15.0920, longitude: 120.6340 },
  { exit_number: 22, exit_name: 'Magalang (NB)',                    km_marker: 75,  latitude: 15.1200, longitude: 120.6130 },
  { exit_number: 23, exit_name: 'Dau / Mabalacat (NB)',             km_marker: 80,  latitude: 15.1530, longitude: 120.5980 },
  { exit_number: 24, exit_name: 'Santa Ines / SCTEX (NB terminus)', km_marker: 84,  latitude: 15.1640, longitude: 120.5900 },
];

// ── Seed Data: Southbound Exits (26) ─────────────────────────
const SB_EXITS = [
  { exit_number: 1,  exit_name: 'Santa Ines / SCTEX (SB entry)',    km_marker: 84,  latitude: 15.1635, longitude: 120.5905 },
  { exit_number: 2,  exit_name: 'Dau / Mabalacat (SB)',             km_marker: 80,  latitude: 15.1525, longitude: 120.5985 },
  { exit_number: 3,  exit_name: 'Magalang (SB)',                    km_marker: 75,  latitude: 15.1195, longitude: 120.6135 },
  { exit_number: 4,  exit_name: 'Angeles / City of Victoria (SB)',  km_marker: 71,  latitude: 15.0915, longitude: 120.6345 },
  { exit_number: 5,  exit_name: 'Mexico (SB)',                      km_marker: 67,  latitude: 15.0675, longitude: 120.6575 },
  { exit_number: 6,  exit_name: 'San Fernando 2 / JASA (SB)',       km_marker: 63,  latitude: 15.0425, longitude: 120.6785 },
  { exit_number: 7,  exit_name: 'San Fernando (SB)',                km_marker: 61,  latitude: 15.0295, longitude: 120.6905 },
  { exit_number: 8,  exit_name: 'Santo Tomas (SB)',                 km_marker: 57,  latitude: 15.0095, longitude: 120.7055 },
  { exit_number: 9,  exit_name: 'San Simon (SB)',                   km_marker: 54,  latitude: 14.9865, longitude: 120.7275 },
  { exit_number: 10, exit_name: 'Apalit (SB)',                      km_marker: 50,  latitude: 14.9535, longitude: 120.7595 },
  { exit_number: 11, exit_name: 'Calumpit (SB)',                    km_marker: 42,  latitude: 14.9215, longitude: 120.8305 },
  { exit_number: 12, exit_name: 'Pulilan (SB)',                     km_marker: 37,  latitude: 14.9005, longitude: 120.8565 },
  { exit_number: 13, exit_name: 'Plaridel (SB)',                    km_marker: 34,  latitude: 14.8775, longitude: 120.8685 },
  { exit_number: 14, exit_name: 'Santa Rita / Guiguinto (SB)',      km_marker: 30,  latitude: 14.8455, longitude: 120.8865 },
  { exit_number: 15, exit_name: 'Tabang / Guiguinto (SB)',          km_marker: 29,  latitude: 14.8445, longitude: 120.8895 },
  { exit_number: 16, exit_name: 'Balagtas (SB)',                    km_marker: 26,  latitude: 14.8200, longitude: 120.9105 },
  { exit_number: 17, exit_name: 'Bocaue (SB)',                      km_marker: 22,  latitude: 14.7970, longitude: 120.9320 },
  { exit_number: 18, exit_name: 'Marilao (SB)',                     km_marker: 18,  latitude: 14.7575, longitude: 120.9485 },
  { exit_number: 19, exit_name: 'Meycauayan (SB)',                  km_marker: 15,  latitude: 14.7375, longitude: 120.9545 },
  { exit_number: 20, exit_name: 'Tambubong / Paso de Blas (SB)',    km_marker: 11,  latitude: 14.7125, longitude: 120.9565 },
  { exit_number: 21, exit_name: 'Karuhatan (SB)',                   km_marker: 9,   latitude: 14.7015, longitude: 120.9665 },
  { exit_number: 22, exit_name: 'Valenzuela / Gen. T. De Leon (SB)',km_marker: 7,   latitude: 14.6924, longitude: 120.9745 },
  { exit_number: 23, exit_name: 'Mindanao Ave / Bignay (SB)',       km_marker: 3,   latitude: 14.6675, longitude: 120.9905 },
  { exit_number: 24, exit_name: 'Harbor Link Interchange (SB)',     km_marker: 5,   latitude: 14.6929, longitude: 120.9750 },
  { exit_number: 25, exit_name: 'Paso de Blas (SB alternate)',      km_marker: 10,  latitude: 14.7100, longitude: 120.9580 },
  { exit_number: 26, exit_name: 'Balintawak (SB terminus)',         km_marker: 0,   latitude: 14.6540, longitude: 121.0025 },
];

// ── Seed Data: Emission Factors (Class 1, 2, 3) ─────────────
const EMISSION_FACTORS = [
  {
    vehicle_class: 1,
    class_label: 'Class 1 — Light Vehicles',
    description: 'Cars, sedans, SUVs, pickups, motorcycles (400cc+), passenger vans. 2 axles, ≤7.5 ft height.',
    co2_g_per_km: 160.00,
    co_g_per_km: 1.0000,
    no2_g_per_km: 0.0800,
    pm25_g_per_km: 0.0050,
    pm10_g_per_km: 0.0120,
    so2_g_per_km: 0.0020,
  },
  {
    vehicle_class: 2,
    class_label: 'Class 2 — Medium Commercial',
    description: 'Buses, light trucks, delivery trucks. 2-3 axles, >7.5 ft height.',
    co2_g_per_km: 550.00,
    co_g_per_km: 3.5000,
    no2_g_per_km: 3.0000,
    pm25_g_per_km: 0.1000,
    pm10_g_per_km: 0.1800,
    so2_g_per_km: 0.0150,
  },
  {
    vehicle_class: 3,
    class_label: 'Class 3 — Heavy Commercial',
    description: 'Large trailer trucks, heavy cargo, tankers. 4+ axles.',
    co2_g_per_km: 950.00,
    co_g_per_km: 4.0000,
    no2_g_per_km: 7.0000,
    pm25_g_per_km: 0.1500,
    pm10_g_per_km: 0.2800,
    so2_g_per_km: 0.0300,
  },
];

// ── Main ─────────────────────────────────────────────────────
async function main() {
  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    console.log('🔌 Connecting to Supabase PostgreSQL...');
    await client.connect();
    console.log('✅ Connected!\n');

    // 1. Create tables
    console.log('📦 Creating tables (nlex_exits, nlex_emission_factors, nlex_emissions)...');
    await client.query(CREATE_TABLES_SQL);
    console.log('✅ Tables created!\n');

    // 2. Seed NB exits
    console.log('🚗 Seeding Northbound exits (24)...');
    for (const exit of NB_EXITS) {
      await client.query(
        `INSERT INTO nlex_exits (exit_number, exit_name, direction, km_marker, latitude, longitude)
         VALUES ($1, $2, 'NB', $3, $4, $5)`,
        [exit.exit_number, exit.exit_name, exit.km_marker, exit.latitude, exit.longitude]
      );
    }
    console.log('✅ 24 Northbound exits seeded!\n');

    // 3. Seed SB exits
    console.log('🚗 Seeding Southbound exits (26)...');
    for (const exit of SB_EXITS) {
      await client.query(
        `INSERT INTO nlex_exits (exit_number, exit_name, direction, km_marker, latitude, longitude)
         VALUES ($1, $2, 'SB', $3, $4, $5)`,
        [exit.exit_number, exit.exit_name, exit.km_marker, exit.latitude, exit.longitude]
      );
    }
    console.log('✅ 26 Southbound exits seeded!\n');

    // 4. Seed emission factors
    console.log('📊 Seeding emission factors (Class 1, 2, 3)...');
    for (const ef of EMISSION_FACTORS) {
      await client.query(
        `INSERT INTO nlex_emission_factors 
         (vehicle_class, class_label, description, co2_g_per_km, co_g_per_km, no2_g_per_km, pm25_g_per_km, pm10_g_per_km, so2_g_per_km)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [ef.vehicle_class, ef.class_label, ef.description, ef.co2_g_per_km, ef.co_g_per_km, ef.no2_g_per_km, ef.pm25_g_per_km, ef.pm10_g_per_km, ef.so2_g_per_km]
      );
    }
    console.log('✅ Emission factors seeded!\n');

    // 5. Verify
    const exitCount = await client.query('SELECT COUNT(*) FROM nlex_exits');
    const factorCount = await client.query('SELECT COUNT(*) FROM nlex_emission_factors');
    
    console.log('════════════════════════════════════════════════');
    console.log('  ✅ SETUP COMPLETE');
    console.log('════════════════════════════════════════════════');
    console.log(`  nlex_exits:            ${exitCount.rows[0].count} rows`);
    console.log(`  nlex_emission_factors:  ${factorCount.rows[0].count} rows`);
    console.log(`  nlex_emissions:         0 rows (ready for ingestion)`);
    console.log('════════════════════════════════════════════════');
    console.log('\n  Next step: Run the ingestion script');
    console.log('  $env:OWM_API_KEY="your-key"; node ingest.js\n');

  } catch (err) {
    console.error('❌ Error:', err.message);
    if (err.message.includes('password authentication failed')) {
      console.error('\n  ⚠️  Wrong database password. Check your Supabase Dashboard:');
      console.error('     Project Settings → Database → Database password\n');
    }
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
