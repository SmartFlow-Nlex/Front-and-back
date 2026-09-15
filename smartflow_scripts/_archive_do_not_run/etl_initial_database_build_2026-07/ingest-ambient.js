throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
import pg from 'pg';

const AWS_PG = {
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'REMOVED',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
};

const OWM_API_KEY = process.env.OWM_API_KEY || '1dd60309c9bf3c93b599ab32b0c40e09';

const pool = new pg.Pool(AWS_PG);

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
  console.log('🚀 Phase 1: Dual-API Ingestion (OpenWeatherMap Ambient Data)...\n');
  
  try {
    // 1. Fetch the 40 exits from AWS
    console.log('🌍 Fetching Exits from AWS Database...');
    const exitsRes = await pool.query("SELECT id, name, direction, latitude, longitude from bronze.nlex_exits ORDER BY direction, name");
    const exits = exitsRes.rows;
    
    if (exits.length === 0) {
      console.error('❌ No exits found in the database. Please run seed-pdf-exits.js first.');
      process.exit(1);
    }
    console.log(`📍 Found ${exits.length} precise exit points to process.\n`);

    let successCount = 0;
    let failCount = 0;

    // 2. Loop through exits and pull OpenWeatherMap Air Pollution
    for (const exit of exits) {
      const label = `[${exit.direction}] ${exit.name}`;
      try {
        await new Promise(resolve => setTimeout(resolve, 300)); // Respect API Rate limits
        
        // Fetch Ambient data
        const pollution = await fetchAirPollution(exit.latitude, exit.longitude);

        // Insert into bronze.nlex_emissions
        const insertQuery = `
          INSERT into bronze.nlex_emissions (
            exit_id, aqi, co, "no", no2, o3, so2, nh3, pm2_5, pm10, api_dt, raw_response
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `;
        const values = [
          exit.id,
          pollution.aqi,
          pollution.co,
          pollution.no,
          pollution.no2,
          pollution.o3,
          pollution.so2,
          pollution.nh3,
          pollution.pm2_5,
          pollution.pm10,
          pollution.api_dt,
          JSON.stringify(pollution.raw_response)
        ];

        await pool.query(insertQuery, values);

        const aqiLabel = ['', 'Good', 'Fair', 'Moderate', 'Poor', 'Very Poor'][pollution.aqi] || 'Unknown';
        console.log(`  ✅ ${label.padEnd(35)} AQI: ${pollution.aqi} (${aqiLabel}) | CO: ${pollution.co} µg/m³ | NO₂: ${pollution.no2} µg/m³`);
        successCount++;
        
      } catch (err) {
        console.log(`  ❌ ${label.padEnd(35)} ERROR: ${err.message}`);
        failCount++;
      }
    }

    console.log('\n════════════════════════════════════════════════');
    console.log('  📊 INGESTION COMPLETE: AMBIENT EMISSIONS');
    console.log(`  ✅ Successfully pulled: ${successCount} locations`);
    if (failCount > 0) console.log(`  ❌ Failed: ${failCount} locations`);
    console.log('════════════════════════════════════════════════\n');

  } catch (err) {
    console.error("Fatal Error:", err.message);
  } finally {
    await pool.end();
  }
}

main();
