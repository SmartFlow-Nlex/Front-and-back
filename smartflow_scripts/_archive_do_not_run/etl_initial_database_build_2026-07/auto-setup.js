throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
// ============================================================
// NLEX Emissions — Full Auto Setup
// Uses service_role key to create tables + seed everything
// ============================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://cksprtvjsjrsldamlylc.supabase.co';
const SERVICE_ROLE_KEY = 'REMOVED';

// Try multiple endpoints to execute SQL
const SQL = `
DROP TABLE IF EXISTS nlex_emissions CASCADE;
DROP TABLE IF EXISTS nlex_emission_factors CASCADE;
DROP TABLE IF EXISTS nlex_exits CASCADE;

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

CREATE INDEX idx_nlex_emissions_exit_id ON nlex_emissions(exit_id);
CREATE INDEX idx_nlex_emissions_fetched_at ON nlex_emissions(fetched_at);
CREATE INDEX idx_nlex_exits_direction ON nlex_exits(direction);

ALTER TABLE nlex_exits ENABLE ROW LEVEL SECURITY;
ALTER TABLE nlex_emission_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE nlex_emissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read on nlex_exits" ON nlex_exits FOR SELECT USING (true);
CREATE POLICY "Allow public read on nlex_emission_factors" ON nlex_emission_factors FOR SELECT USING (true);
CREATE POLICY "Allow public read on nlex_emissions" ON nlex_emissions FOR SELECT USING (true);
CREATE POLICY "Allow insert on nlex_exits" ON nlex_exits FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow insert on nlex_emission_factors" ON nlex_emission_factors FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow insert on nlex_emissions" ON nlex_emissions FOR INSERT WITH CHECK (true);
`;

async function tryExecuteSQL() {
  // Approach 1: Try /pg/query endpoint (newer Supabase)
  const endpoints = [
    { url: `${SUPABASE_URL}/pg/query`, method: 'POST', body: JSON.stringify({ query: SQL }), label: '/pg/query' },
    { url: `${SUPABASE_URL}/rest/v1/rpc/exec_sql`, method: 'POST', body: JSON.stringify({ query: SQL }), label: '/rpc/exec_sql' },
    { url: `${SUPABASE_URL}/sql`, method: 'POST', body: JSON.stringify({ query: SQL }), label: '/sql' },
  ];

  for (const ep of endpoints) {
    console.log(`  Trying ${ep.label}...`);
    try {
      const res = await fetch(ep.url, {
        method: ep.method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
          'apikey': SERVICE_ROLE_KEY,
        },
        body: ep.body,
      });
      const text = await res.text();
      if (res.ok) {
        console.log(`  ✅ ${ep.label} succeeded!`);
        return true;
      } else {
        console.log(`  ❌ ${ep.label}: ${res.status} - ${text.substring(0, 120)}`);
      }
    } catch (err) {
      console.log(`  ❌ ${ep.label}: ${err.message}`);
    }
  }

  // Approach 2: Try direct PostgreSQL with service_role context  
  console.log('\n  Trying direct PostgreSQL connection with confirmed region...');
  try {
    const pg = await import('pg');
    const client = new pg.default.Client({
      host: 'aws-0-ap-southeast-1.pooler.supabase.com',
      port: 5432,
      user: 'postgres.cksprtvjsjrsldamlylc',
      password: 'REMOVED',
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
    });
    await client.connect();
    await client.query(SQL);
    console.log('  ✅ Direct PostgreSQL succeeded!');
    await client.end();
    return true;
  } catch (err) {
    console.log(`  ❌ Direct PG: ${err.message.substring(0, 120)}`);
  }

  return false;
}

// ── Seed Data ────────────────────────────────────────────────
const NB_EXITS = [
  { exit_number: 1,  exit_name: 'Balintawak (NB entry)',             direction: 'NB', km_marker: 0,   latitude: 14.6545, longitude: 121.0020 },
  { exit_number: 2,  exit_name: 'Mindanao Ave / Bignay (NB)',        direction: 'NB', km_marker: 3,   latitude: 14.6680, longitude: 120.9900 },
  { exit_number: 3,  exit_name: 'Valenzuela / Gen. T. De Leon (NB)', direction: 'NB', km_marker: 7,   latitude: 14.6929, longitude: 120.9740 },
  { exit_number: 4,  exit_name: 'Karuhatan (NB)',                    direction: 'NB', km_marker: 9,   latitude: 14.7020, longitude: 120.9660 },
  { exit_number: 5,  exit_name: 'Tambubong / Paso de Blas (NB)',     direction: 'NB', km_marker: 11,  latitude: 14.7130, longitude: 120.9560 },
  { exit_number: 6,  exit_name: 'Meycauayan (NB)',                   direction: 'NB', km_marker: 15,  latitude: 14.7380, longitude: 120.9540 },
  { exit_number: 7,  exit_name: 'Marilao (NB)',                      direction: 'NB', km_marker: 18,  latitude: 14.7580, longitude: 120.9480 },
  { exit_number: 8,  exit_name: 'Bocaue (NB)',                       direction: 'NB', km_marker: 22,  latitude: 14.7976, longitude: 120.9316 },
  { exit_number: 9,  exit_name: 'Balagtas (NB)',                     direction: 'NB', km_marker: 26,  latitude: 14.8205, longitude: 120.9100 },
  { exit_number: 10, exit_name: 'Tabang / Guiguinto (NB)',           direction: 'NB', km_marker: 29,  latitude: 14.8450, longitude: 120.8890 },
  { exit_number: 11, exit_name: 'Santa Rita / Guiguinto (NB)',       direction: 'NB', km_marker: 30,  latitude: 14.8460, longitude: 120.8860 },
  { exit_number: 12, exit_name: 'Plaridel (NB)',                     direction: 'NB', km_marker: 34,  latitude: 14.8780, longitude: 120.8680 },
  { exit_number: 13, exit_name: 'Pulilan (NB)',                      direction: 'NB', km_marker: 37,  latitude: 14.9010, longitude: 120.8560 },
  { exit_number: 14, exit_name: 'Calumpit (NB)',                     direction: 'NB', km_marker: 42,  latitude: 14.9220, longitude: 120.8300 },
  { exit_number: 15, exit_name: 'Apalit (NB)',                       direction: 'NB', km_marker: 50,  latitude: 14.9540, longitude: 120.7590 },
  { exit_number: 16, exit_name: 'San Simon (NB)',                    direction: 'NB', km_marker: 54,  latitude: 14.9870, longitude: 120.7270 },
  { exit_number: 17, exit_name: 'Santo Tomas (NB)',                  direction: 'NB', km_marker: 57,  latitude: 15.0100, longitude: 120.7050 },
  { exit_number: 18, exit_name: 'San Fernando (NB)',                 direction: 'NB', km_marker: 61,  latitude: 15.0300, longitude: 120.6900 },
  { exit_number: 19, exit_name: 'San Fernando 2 / JASA (NB)',        direction: 'NB', km_marker: 63,  latitude: 15.0430, longitude: 120.6780 },
  { exit_number: 20, exit_name: 'Mexico (NB)',                       direction: 'NB', km_marker: 67,  latitude: 15.0680, longitude: 120.6570 },
  { exit_number: 21, exit_name: 'Angeles / City of Victoria (NB)',   direction: 'NB', km_marker: 71,  latitude: 15.0920, longitude: 120.6340 },
  { exit_number: 22, exit_name: 'Magalang (NB)',                     direction: 'NB', km_marker: 75,  latitude: 15.1200, longitude: 120.6130 },
  { exit_number: 23, exit_name: 'Dau / Mabalacat (NB)',              direction: 'NB', km_marker: 80,  latitude: 15.1530, longitude: 120.5980 },
  { exit_number: 24, exit_name: 'Santa Ines / SCTEX (NB terminus)',  direction: 'NB', km_marker: 84,  latitude: 15.1640, longitude: 120.5900 },
];

const SB_EXITS = [
  { exit_number: 1,  exit_name: 'Santa Ines / SCTEX (SB entry)',     direction: 'SB', km_marker: 84,  latitude: 15.1635, longitude: 120.5905 },
  { exit_number: 2,  exit_name: 'Dau / Mabalacat (SB)',              direction: 'SB', km_marker: 80,  latitude: 15.1525, longitude: 120.5985 },
  { exit_number: 3,  exit_name: 'Magalang (SB)',                     direction: 'SB', km_marker: 75,  latitude: 15.1195, longitude: 120.6135 },
  { exit_number: 4,  exit_name: 'Angeles / City of Victoria (SB)',   direction: 'SB', km_marker: 71,  latitude: 15.0915, longitude: 120.6345 },
  { exit_number: 5,  exit_name: 'Mexico (SB)',                       direction: 'SB', km_marker: 67,  latitude: 15.0675, longitude: 120.6575 },
  { exit_number: 6,  exit_name: 'San Fernando 2 / JASA (SB)',        direction: 'SB', km_marker: 63,  latitude: 15.0425, longitude: 120.6785 },
  { exit_number: 7,  exit_name: 'San Fernando (SB)',                 direction: 'SB', km_marker: 61,  latitude: 15.0295, longitude: 120.6905 },
  { exit_number: 8,  exit_name: 'Santo Tomas (SB)',                  direction: 'SB', km_marker: 57,  latitude: 15.0095, longitude: 120.7055 },
  { exit_number: 9,  exit_name: 'San Simon (SB)',                    direction: 'SB', km_marker: 54,  latitude: 14.9865, longitude: 120.7275 },
  { exit_number: 10, exit_name: 'Apalit (SB)',                       direction: 'SB', km_marker: 50,  latitude: 14.9535, longitude: 120.7595 },
  { exit_number: 11, exit_name: 'Calumpit (SB)',                     direction: 'SB', km_marker: 42,  latitude: 14.9215, longitude: 120.8305 },
  { exit_number: 12, exit_name: 'Pulilan (SB)',                      direction: 'SB', km_marker: 37,  latitude: 14.9005, longitude: 120.8565 },
  { exit_number: 13, exit_name: 'Plaridel (SB)',                     direction: 'SB', km_marker: 34,  latitude: 14.8775, longitude: 120.8685 },
  { exit_number: 14, exit_name: 'Santa Rita / Guiguinto (SB)',       direction: 'SB', km_marker: 30,  latitude: 14.8455, longitude: 120.8865 },
  { exit_number: 15, exit_name: 'Tabang / Guiguinto (SB)',           direction: 'SB', km_marker: 29,  latitude: 14.8445, longitude: 120.8895 },
  { exit_number: 16, exit_name: 'Balagtas (SB)',                     direction: 'SB', km_marker: 26,  latitude: 14.8200, longitude: 120.9105 },
  { exit_number: 17, exit_name: 'Bocaue (SB)',                       direction: 'SB', km_marker: 22,  latitude: 14.7970, longitude: 120.9320 },
  { exit_number: 18, exit_name: 'Marilao (SB)',                      direction: 'SB', km_marker: 18,  latitude: 14.7575, longitude: 120.9485 },
  { exit_number: 19, exit_name: 'Meycauayan (SB)',                   direction: 'SB', km_marker: 15,  latitude: 14.7375, longitude: 120.9545 },
  { exit_number: 20, exit_name: 'Tambubong / Paso de Blas (SB)',     direction: 'SB', km_marker: 11,  latitude: 14.7125, longitude: 120.9565 },
  { exit_number: 21, exit_name: 'Karuhatan (SB)',                    direction: 'SB', km_marker: 9,   latitude: 14.7015, longitude: 120.9665 },
  { exit_number: 22, exit_name: 'Valenzuela / Gen. T. De Leon (SB)', direction: 'SB', km_marker: 7,   latitude: 14.6924, longitude: 120.9745 },
  { exit_number: 23, exit_name: 'Mindanao Ave / Bignay (SB)',        direction: 'SB', km_marker: 3,   latitude: 14.6675, longitude: 120.9905 },
  { exit_number: 24, exit_name: 'Harbor Link Interchange (SB)',      direction: 'SB', km_marker: 5,   latitude: 14.6929, longitude: 120.9750 },
  { exit_number: 25, exit_name: 'Paso de Blas (SB alternate)',       direction: 'SB', km_marker: 10,  latitude: 14.7100, longitude: 120.9580 },
  { exit_number: 26, exit_name: 'Balintawak (SB terminus)',          direction: 'SB', km_marker: 0,   latitude: 14.6540, longitude: 121.0025 },
];

const EMISSION_FACTORS = [
  {
    vehicle_class: 1, class_label: 'Class 1 — Light Vehicles',
    description: 'Cars, sedans, SUVs, pickups, motorcycles (400cc+), passenger vans. 2 axles, ≤7.5 ft height.',
    co2_g_per_km: 160.00, co_g_per_km: 1.0000, no2_g_per_km: 0.0800,
    pm25_g_per_km: 0.0050, pm10_g_per_km: 0.0120, so2_g_per_km: 0.0020,
  },
  {
    vehicle_class: 2, class_label: 'Class 2 — Medium Commercial',
    description: 'Buses, light trucks, delivery trucks. 2-3 axles, >7.5 ft height.',
    co2_g_per_km: 550.00, co_g_per_km: 3.5000, no2_g_per_km: 3.0000,
    pm25_g_per_km: 0.1000, pm10_g_per_km: 0.1800, so2_g_per_km: 0.0150,
  },
  {
    vehicle_class: 3, class_label: 'Class 3 — Heavy Commercial',
    description: 'Large trailer trucks, heavy cargo, tankers. 4+ axles.',
    co2_g_per_km: 950.00, co_g_per_km: 4.0000, no2_g_per_km: 7.0000,
    pm25_g_per_km: 0.1500, pm10_g_per_km: 0.2800, so2_g_per_km: 0.0300,
  },
];

async function seedData() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Seed exits
  console.log('\n🚗 Inserting 50 exit points...');
  const allExits = [...NB_EXITS, ...SB_EXITS];
  const { data: exitData, error: exitErr } = await supabase.from('nlex_exits').insert(allExits).select();
  if (exitErr) {
    console.error('❌ Exits insert failed:', exitErr.message);
    return false;
  }
  console.log(`✅ ${exitData.length} exits inserted!`);

  // Seed emission factors
  console.log('\n📊 Inserting emission factors (Class 1, 2, 3)...');
  const { data: efData, error: efErr } = await supabase.from('nlex_emission_factors').insert(EMISSION_FACTORS).select();
  if (efErr) {
    console.error('❌ Emission factors insert failed:', efErr.message);
    return false;
  }
  console.log(`✅ ${efData.length} emission factors inserted!`);

  // Verify
  console.log('\n════════════════════════════════════════════════');
  console.log('  ✅ SETUP COMPLETE');
  console.log('════════════════════════════════════════════════');
  console.log(`  nlex_exits:            ${exitData.length} rows`);
  console.log(`  nlex_emission_factors: ${efData.length} rows`);
  console.log(`  nlex_emissions:        0 rows (ready for ingestion)`);
  console.log('════════════════════════════════════════════════\n');

  // Sample
  console.log('  Sample exits:');
  for (const e of exitData.slice(0, 3)) {
    console.log(`    [${e.direction} #${e.exit_number}] ${e.exit_name} (${e.latitude}, ${e.longitude})`);
  }
  console.log(`    ... and ${exitData.length - 3} more\n`);

  return true;
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('🚀 NLEX Emissions — Full Automatic Setup\n');
  console.log('Step 1: Creating tables...');

  const sqlOk = await tryExecuteSQL();
  if (!sqlOk) {
    console.error('\n❌ Could not create tables automatically.');
    process.exit(1);
  }

  console.log('\nStep 2: Seeding data...');
  const seedOk = await seedData();
  if (!seedOk) {
    process.exit(1);
  }
}

main();
