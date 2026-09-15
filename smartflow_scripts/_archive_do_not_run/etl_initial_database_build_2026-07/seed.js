throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
// ============================================================
// NLEX Emissions — Seed Script
// Seeds 50 exits + 3 emission factors via Supabase REST API
// Run AFTER pasting schema.sql in the SQL Editor
// ============================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://cksprtvjsjrsldamlylc.supabase.co';
const SUPABASE_ANON_KEY = 'REMOVED';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Northbound Exits (24) ────────────────────────────────────
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

// ── Southbound Exits (26) ────────────────────────────────────
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

// ── Emission Factors (Class 1, 2, 3) ─────────────────────────
const EMISSION_FACTORS = [
  {
    vehicle_class: 1,
    class_label: 'Class 1 — Light Vehicles',
    description: 'Cars, sedans, SUVs, pickups, motorcycles (400cc+), passenger vans. 2 axles, ≤7.5 ft height.',
    co2_g_per_km: 160.00, co_g_per_km: 1.0000, no2_g_per_km: 0.0800,
    pm25_g_per_km: 0.0050, pm10_g_per_km: 0.0120, so2_g_per_km: 0.0020,
  },
  {
    vehicle_class: 2,
    class_label: 'Class 2 — Medium Commercial',
    description: 'Buses, light trucks, delivery trucks. 2-3 axles, >7.5 ft height.',
    co2_g_per_km: 550.00, co_g_per_km: 3.5000, no2_g_per_km: 3.0000,
    pm25_g_per_km: 0.1000, pm10_g_per_km: 0.1800, so2_g_per_km: 0.0150,
  },
  {
    vehicle_class: 3,
    class_label: 'Class 3 — Heavy Commercial',
    description: 'Large trailer trucks, heavy cargo, tankers. 4+ axles.',
    co2_g_per_km: 950.00, co_g_per_km: 4.0000, no2_g_per_km: 7.0000,
    pm25_g_per_km: 0.1500, pm10_g_per_km: 0.2800, so2_g_per_km: 0.0300,
  },
];

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('🚀 NLEX Emissions — Seeding Data via Supabase REST API\n');

  // 1. Check if tables exist
  const { data: test, error: testErr } = await supabase.from('nlex_exits').select('id').limit(1);
  if (testErr) {
    console.error('❌ Table "nlex_exits" not found. Did you run schema.sql in the SQL Editor?');
    console.error('   Error:', testErr.message);
    console.error('\n   Steps:');
    console.error('   1. Go to Supabase Dashboard → SQL Editor');
    console.error('   2. Copy-paste the contents of schema.sql');
    console.error('   3. Click "Run"');
    console.error('   4. Come back and run this script again\n');
    process.exit(1);
  }

  // 2. Clear existing data (in case of re-run)
  console.log('🧹 Clearing existing data...');
  await supabase.from('nlex_emissions').delete().neq('id', 0);
  await supabase.from('nlex_emission_factors').delete().neq('id', 0);
  await supabase.from('nlex_exits').delete().neq('id', 0);

  // 3. Seed exits
  const allExits = [...NB_EXITS, ...SB_EXITS];
  console.log(`🚗 Inserting ${allExits.length} exit points...`);
  
  const { data: exitData, error: exitErr } = await supabase
    .from('nlex_exits')
    .insert(allExits)
    .select();

  if (exitErr) {
    console.error('❌ Failed to insert exits:', exitErr.message);
    process.exit(1);
  }
  console.log(`✅ ${exitData.length} exits inserted!\n`);

  // 4. Seed emission factors
  console.log('📊 Inserting emission factors (Class 1, 2, 3)...');
  const { data: efData, error: efErr } = await supabase
    .from('nlex_emission_factors')
    .insert(EMISSION_FACTORS)
    .select();

  if (efErr) {
    console.error('❌ Failed to insert emission factors:', efErr.message);
    process.exit(1);
  }
  console.log(`✅ ${efData.length} emission factors inserted!\n`);

  // 5. Summary
  console.log('════════════════════════════════════════════════');
  console.log('  ✅ SEEDING COMPLETE');
  console.log('════════════════════════════════════════════════');
  console.log(`  nlex_exits:            ${exitData.length} rows`);
  console.log(`  nlex_emission_factors: ${efData.length} rows`);
  console.log(`  nlex_emissions:        0 rows (ready for API ingestion)`);
  console.log('════════════════════════════════════════════════');

  // 6. Show sample
  console.log('\n  Sample exits:');
  for (const e of exitData.slice(0, 5)) {
    console.log(`    [${e.direction} #${e.exit_number}] ${e.exit_name} (${e.latitude}, ${e.longitude})`);
  }
  console.log(`    ... and ${exitData.length - 5} more\n`);

  console.log('  Emission factors:');
  for (const f of efData) {
    console.log(`    ${f.class_label}: ${f.co2_g_per_km} g CO₂/km`);
  }

  console.log('\n  Next: Run the ingestion script to fetch air quality data');
  console.log('  $env:OWM_API_KEY="your-key"; node ingest.js\n');
}

main();
