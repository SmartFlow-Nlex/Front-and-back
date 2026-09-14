throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://cksprtvjsjrsldamlylc.supabase.co';
const SERVICE_ROLE_KEY = 'REMOVED';
// Using a known generic free testing key for OpenWeatherMap (replace if needed)
const OWM_API_KEY = process.env.OWM_API_KEY || 'b6907d289e10d714a6e88b30761fae22';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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

async function fetchAirPollution(lat, lon) {
  const url = `https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${OWM_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OWM API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  const item = data.list[0];
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

async function main() {
  console.log('🚀 Setting up NLEX Emission Factors...');
  
  // 1. Seed emission factors if empty
  const { data: existingFactors } = await supabase.from('nlex_emission_factors').select('id');
  if (!existingFactors || existingFactors.length === 0) {
    const { error } = await supabase.from('nlex_emission_factors').insert(EMISSION_FACTORS);
    if (error) console.error('Failed to seed emission factors:', error);
    else console.log('✅ Emission factors seeded.');
  } else {
    console.log('✅ Emission factors already exist.');
  }

  // 2. Fetch exits
  console.log('\n🌍 Fetching Exits from Supabase...');
  const { data: exits, error: exitsErr } = await supabase.from('nlex_exits').select('*').order('direction').order('km_marker');
  
  if (exitsErr || !exits) {
    console.error('Failed to fetch exits:', exitsErr);
    process.exit(1);
  }
  console.log(`📍 Found ${exits.length} exit points to process.\n`);

  let successCount = 0;
  let failCount = 0;

  // 3. Process each exit from OWM API
  for (const exit of exits) {
    const label = `[${exit.direction} KM ${exit.km_marker}] ${exit.name || exit.exit_name || exit.id}`;
    try {
      await new Promise(resolve => setTimeout(resolve, 300)); // Rate limiting
      
      const pollution = await fetchAirPollution(exit.latitude, exit.longitude);

      const { error: insertErr } = await supabase.from('nlex_emissions').insert({
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

      if (insertErr) {
        console.log(`  ❌ ${label} — Insert failed: ${insertErr.message}`);
        failCount++;
      } else {
        const aqiLabel = ['', 'Good', 'Fair', 'Moderate', 'Poor', 'Very Poor'][pollution.aqi] || 'Unknown';
        console.log(`  ✅ ${label} — AQI: ${pollution.aqi} (${aqiLabel}) | CO: ${pollution.co} | NO₂: ${pollution.no2} | PM2.5: ${pollution.pm2_5}`);
        successCount++;
      }
    } catch (err) {
      console.log(`  ❌ ${label} — ${err.message}`);
      failCount++;
    }
  }

  console.log('\n════════════════════════════════════════════════');
  console.log('  📊 INGESTION COMPLETE');
  console.log(`  ✅ Success: ${successCount}`);
  if (failCount > 0) console.log(`  ❌ Failed:  ${failCount}`);
  console.log('════════════════════════════════════════════════\n');
}

main();
