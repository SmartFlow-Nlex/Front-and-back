throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://cksprtvjsjrsldamlylc.supabase.co';
const SERVICE_ROLE_KEY = 'REMOVED';
const OWM_API_KEY = process.env.OWM_API_KEY || '1dd60309c9bf3c93b599ab32b0c40e09';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Define start and end times
// Start: Jan 1, 2022
const START_DATE = new Date('2022-01-01T00:00:00Z');
const END_DATE = new Date(); // Present

const START_TS = Math.floor(START_DATE.getTime() / 1000);
const END_TS = Math.floor(END_DATE.getTime() / 1000);

async function fetchHistoricalAirPollution(lat, lon, start, end) {
  const url = `https://api.openweathermap.org/data/2.5/air_pollution/history?lat=${lat}&lon=${lon}&start=${start}&end=${end}&appid=${OWM_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OWM API error ${res.status}: ${text}`);
  }
  return await res.json();
}

async function main() {
  console.log(`🚀 NLEX Historical Emissions Ingestion`);
  console.log(`📅 Date Range: ${START_DATE.toISOString()} to ${END_DATE.toISOString()}`);
  
  console.log('\n🌍 Fetching Exits from Supabase...');
  const { data: exits, error: exitsErr } = await supabase.from('nlex_exits').select('*').order('direction').order('km_marker');
  
  if (exitsErr || !exits) {
    console.error('Failed to fetch exits:', exitsErr);
    process.exit(1);
  }
  console.log(`📍 Found ${exits.length} exit points to process.\n`);

  let totalInserted = 0;

  for (const exit of exits) {
    const label = `[${exit.direction} KM ${exit.km_marker}] ${exit.name || exit.exit_name || exit.id}`;
    console.log(`\n▶️ Processing ${label}...`);
    
    // We fetch in chunks of 1 year to avoid massive API responses and timeouts
    const ONE_YEAR_SEC = 365 * 24 * 60 * 60;
    let currentStart = START_TS;

    while (currentStart < END_TS) {
      let currentEnd = currentStart + ONE_YEAR_SEC;
      if (currentEnd > END_TS) currentEnd = END_TS;

      console.log(`   Fetching ${new Date(currentStart * 1000).toISOString().split('T')[0]} to ${new Date(currentEnd * 1000).toISOString().split('T')[0]}`);
      
      try {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting (1 req/sec)
        const data = await fetchHistoricalAirPollution(exit.latitude, exit.longitude, currentStart, currentEnd);
        
        if (!data.list || data.list.length === 0) {
          console.log(`   ⚠️ No data found for this period.`);
          currentStart = currentEnd;
          continue;
        }

        // Map API response to our database schema
        const rows = data.list.map(item => ({
          exit_id: exit.id,
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
          raw_response: item // storing raw JSON just in case
        }));

        // Insert in batches of 1000 to avoid request size limits
        const BATCH_SIZE = 1000;
        let batchInserted = 0;
        
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          const { error: insertErr } = await supabase.from('nlex_emissions').insert(batch);
          
          if (insertErr) {
            console.error(`   ❌ DB Insert failed for batch: ${insertErr.message}`);
          } else {
            batchInserted += batch.length;
          }
        }
        
        console.log(`   ✅ Inserted ${batchInserted} hourly records.`);
        totalInserted += batchInserted;

      } catch (err) {
        console.error(`   ❌ API/Fetch error: ${err.message}`);
      }

      currentStart = currentEnd;
    }
  }

  console.log('\n════════════════════════════════════════════════');
  console.log('  📊 HISTORICAL INGESTION COMPLETE');
  console.log(`  ✅ Total rows inserted: ${totalInserted}`);
  console.log('════════════════════════════════════════════════\n');
}

main();
