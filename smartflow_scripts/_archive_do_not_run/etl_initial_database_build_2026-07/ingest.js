throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
// ============================================================
// NLEX Emissions — OpenWeatherMap Air Pollution Ingestion
// Fetches pollution data for all 50 exits → Supabase
// ============================================================

import { createClient } from '@supabase/supabase-js';

// ── Config ───────────────────────────────────────────────────
const SUPABASE_URL = 'https://cksprtvjsjrsldamlylc.supabase.co';
const SUPABASE_ANON_KEY = 'REMOVED';
const OWM_API_KEY = process.env.OWM_API_KEY;

if (!OWM_API_KEY) {
  console.error(`
╔══════════════════════════════════════════════════════════════╗
║  Missing OWM_API_KEY environment variable!                   ║
║                                                              ║
║  Get your FREE key: https://openweathermap.org/api           ║
║  Sign up → API Keys → Copy your key                         ║
║                                                              ║
║  Then run:                                                   ║
║  $env:OWM_API_KEY="your-key"; node ingest.js                 ║
╚══════════════════════════════════════════════════════════════╝
  `);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Fetch air pollution from OpenWeatherMap ──────────────────
async function fetchAirPollution(lat, lon) {
  const url = `https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${OWM_API_KEY}`;
  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OWM API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const item = data.list[0]; // Current reading

  return {
    aqi: item.main.aqi,
    co: item.components.co,
    no: item.components.no,
    no2: item.components.no2,
    o3: item.components.o3,
    so2: item.components.so2,
    nh3: item.components.nh3,
    pm2_5: item.components.pm2_5,
    pm10: item.components.pm10,
    api_dt: item.dt,
    raw_response: data,
  };
}

// ── Main ingestion loop ─────────────────────────────────────
async function main() {
  console.log('🌍 NLEX Emissions Ingestion — OpenWeatherMap Air Pollution API\n');

  // 1. Fetch all exits from Supabase
  const { data: exits, error: exitError } = await supabase
    .from('nlex_exits')
    .select('*')
    .order('direction', { ascending: true })
    .order('exit_number', { ascending: true });

  if (exitError) {
    console.error('❌ Failed to fetch exits:', exitError.message);
    process.exit(1);
  }

  console.log(`📍 Found ${exits.length} exit points\n`);

  let successCount = 0;
  let failCount = 0;

  // 2. Fetch pollution data for each exit
  for (const exit of exits) {
    const label = `[${exit.direction}#${exit.exit_number}] ${exit.exit_name}`;

    try {
      // Rate limit: max 60 calls/min — we add a small delay
      await new Promise(resolve => setTimeout(resolve, 250));

      const pollution = await fetchAirPollution(exit.latitude, exit.longitude);

      // 3. Insert into Supabase
      const { error: insertError } = await supabase
        .from('nlex_emissions')
        .insert({
          exit_id: exit.id,
          aqi: pollution.aqi,
          co: pollution.co,
          no: pollution.no,
          no2: pollution.no2,
          o3: pollution.o3,
          so2: pollution.so2,
          nh3: pollution.nh3,
          pm2_5: pollution.pm2_5,
          pm10: pollution.pm10,
          api_dt: pollution.api_dt,
          raw_response: pollution.raw_response,
        });

      if (insertError) {
        console.log(`  ❌ ${label} — Insert failed: ${insertError.message}`);
        failCount++;
      } else {
        const aqiLabel = ['', 'Good', 'Fair', 'Moderate', 'Poor', 'Very Poor'][pollution.aqi];
        console.log(`  ✅ ${label} — AQI: ${pollution.aqi} (${aqiLabel}) | CO: ${pollution.co} | NO₂: ${pollution.no2} | PM2.5: ${pollution.pm2_5}`);
        successCount++;
      }

    } catch (err) {
      console.log(`  ❌ ${label} — ${err.message}`);
      failCount++;
    }
  }

  // 4. Summary
  console.log('\n════════════════════════════════════════════════');
  console.log('  📊 INGESTION COMPLETE');
  console.log('════════════════════════════════════════════════');
  console.log(`  ✅ Success: ${successCount} / ${exits.length}`);
  if (failCount > 0) console.log(`  ❌ Failed:  ${failCount}`);
  console.log(`  📅 Timestamp: ${new Date().toISOString()}`);
  console.log('════════════════════════════════════════════════\n');

  // 5. Show sample from DB
  const { data: sample } = await supabase
    .from('nlex_emissions')
    .select('*, nlex_exits(exit_name, direction)')
    .order('fetched_at', { ascending: false })
    .limit(5);

  if (sample && sample.length > 0) {
    console.log('  Latest 5 readings:');
    for (const row of sample) {
      console.log(`    ${row.nlex_exits.direction} ${row.nlex_exits.exit_name}: AQI=${row.aqi}, CO=${row.co}, PM2.5=${row.pm2_5}`);
    }
  }
}

main();
