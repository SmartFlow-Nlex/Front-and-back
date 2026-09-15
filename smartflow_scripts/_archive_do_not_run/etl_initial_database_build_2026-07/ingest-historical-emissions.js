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

const OWM_API_KEY = 'REMOVED';

// Nov 27, 2020 00:00 UTC — the earliest date OWM historical air pollution supports
const START_UNIX = 1606435200;
const END_UNIX = Math.floor(Date.now() / 1000);

// Chunk size: 30 days in seconds
const CHUNK_SECONDS = 30 * 24 * 60 * 60;

// Rate limit: 1 call per second to be safe with free tier
const RATE_LIMIT_MS = 1100;

const pool = new pg.Pool(AWS_PG);

function unixToDate(unix) {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

async function fetchHistoricalPollution(lat, lon, start, end) {
  const url = `http://api.openweathermap.org/data/2.5/air_pollution/history?lat=${lat}&lon=${lon}&start=${start}&end=${end}&appid=${OWM_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OWM API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.list || [];
}

async function batchInsert(rows) {
  if (rows.length === 0) return;

  const values = [];
  const placeholders = [];
  let paramIndex = 1;

  for (const row of rows) {
    placeholders.push(`($${paramIndex}, $${paramIndex+1}, $${paramIndex+2}, $${paramIndex+3}, $${paramIndex+4}, $${paramIndex+5}, $${paramIndex+6}, $${paramIndex+7}, $${paramIndex+8}, $${paramIndex+9}, $${paramIndex+10})`);
    values.push(
      row.exit_id,
      row.aqi,
      row.co,
      row.no,
      row.no2,
      row.o3,
      row.so2,
      row.pm2_5,
      row.pm10,
      row.api_dt,
      JSON.stringify(row.raw_response)
    );
    paramIndex += 11;
  }

  const query = `
    INSERT into bronze.nlex_emissions (exit_id, aqi, co, "no", no2, o3, so2, pm2_5, pm10, api_dt, raw_response)
    VALUES ${placeholders.join(', ')}
  `;

  await pool.query(query, values);
}

async function main() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  🚀 HISTORICAL EMISSIONS BACKFILL (Nov 2020 → Present)');
  console.log('  📍 20 Unique NLEX Exit Locations (FIXED)');
  console.log('══════════════════════════════════════════════════════════════\n');

  try {
    // 1. Fetch the 20 unique exits
    const exitsRes = await pool.query("SELECT id, exit_name as name, latitude, longitude from bronze.nlex_exits ORDER BY latitude DESC");
    const exits = exitsRes.rows;
    console.log(`📍 Found ${exits.length} unique exit locations to backfill.\n`);

    // 2. Clear existing data
    await pool.query("TRUNCATE TABLE bronze.nlex_emissions");
    console.log("🗑️  Cleared existing data from bronze.nlex_emissions.\\n");

    // 3. Calculate total work
    const totalChunksPerExit = Math.ceil((END_UNIX - START_UNIX) / CHUNK_SECONDS);
    const totalApiCalls = exits.length * totalChunksPerExit;
    const estimatedMinutes = Math.ceil(totalApiCalls * (RATE_LIMIT_MS / 1000) / 60);
    console.log(`📊 Plan: ${totalChunksPerExit} chunks × ${exits.length} exits = ${totalApiCalls} API calls`);
    console.log(`⏱️  Estimated time: ~${estimatedMinutes} minutes\n`);

    let totalRowsInserted = 0;
    let totalApiCallsMade = 0;
    let exitIndex = 0;

    for (const exit of exits) {
      exitIndex++;
      const label = exit.name;
      let exitRows = 0;
      let chunkIndex = 0;
      let chunkStart = START_UNIX;

      while (chunkStart < END_UNIX) {
        chunkIndex++;
        const chunkEnd = Math.min(chunkStart + CHUNK_SECONDS, END_UNIX);

        try {
          await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS));

          const dataPoints = await fetchHistoricalPollution(exit.latitude, exit.longitude, chunkStart, chunkEnd);
          totalApiCallsMade++;

          if (dataPoints.length > 0) {
            const batchRows = dataPoints.map(item => ({
              exit_id: exit.id,
              aqi: Math.round(item.main.aqi),
              co: item.components.co,
              no: item.components.no,
              no2: item.components.no2,
              o3: item.components.o3,
              so2: item.components.so2,
              pm2_5: item.components.pm2_5,
              pm10: item.components.pm10,
              api_dt: item.dt,
              raw_response: item
            }));

            for (let i = 0; i < batchRows.length; i += 500) {
              const subBatch = batchRows.slice(i, i + 500);
              await batchInsert(subBatch);
            }

            exitRows += dataPoints.length;
          }

          if (chunkIndex % 5 === 0) {
            const progress = ((totalApiCallsMade / totalApiCalls) * 100).toFixed(1);
            console.log(`  📦 Exit ${exitIndex}/${exits.length} ${label.padEnd(25)} Chunk ${chunkIndex}/${totalChunksPerExit} | ${exitRows} rows | Overall: ${progress}%`);
          }

        } catch (err) {
          console.log(`  ⚠️  ${label} chunk ${chunkIndex} error: ${err.message} (skipping)`);
        }

        chunkStart = chunkEnd;
      }

      totalRowsInserted += exitRows;
      console.log(`  ✅ ${label.padEnd(25)} DONE — ${exitRows} hourly records ingested`);
    }

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('  📊 HISTORICAL BACKFILL COMPLETE');
    console.log(`  ✅ Total rows inserted: ${totalRowsInserted.toLocaleString()}`);
    console.log(`  📡 Total API calls made: ${totalApiCallsMade.toLocaleString()}`);
    console.log('══════════════════════════════════════════════════════════════\n');

  } catch (err) {
    console.error("Fatal Error:", err.message);
  } finally {
    await pool.end();
  }
}

main();
