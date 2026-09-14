throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
import pg from 'pg';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const AWS_PG = {
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'REMOVED',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
};

const CSV_PATH = 'C:/Users/Hans/.gemini/antigravity/scratch/traffic_volume_synthetic.csv';

// Average segment distance (km) between NLEX exits
// NLEX is ~84 km with 20 unique exit locations ≈ 4.2 km average
const DEFAULT_SEGMENT_KM = 4.2;

const pool = new pg.Pool(AWS_PG);

// Haversine formula to calculate distance between two GPS points
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function main() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  🧮 THEORETICAL EMISSIONS COMPUTATION');
  console.log('  Formula: E = Volume × EF_class × Distance_km');
  console.log('  Sources: Climatiq Emission Factors × Traffic Volume CSV');
  console.log('══════════════════════════════════════════════════════════════\n');

  try {
    // Step 1: Load emission factors from database
    console.log('📊 Loading Climatiq emission factors from database...');
    const efRes = await pool.query('SELECT * FROM bronze.nlex_emission_factors ORDER BY vehicle_class');
    const emissionFactors = {};
    for (const row of efRes.rows) {
      emissionFactors[row.vehicle_class] = {
        co2: parseFloat(row.co2_g_per_km),
        co: parseFloat(row.co_g_per_km),
        no2: parseFloat(row.no2_g_per_km),
        pm25: parseFloat(row.pm25_g_per_km),
        pm10: parseFloat(row.pm10_g_per_km),
        so2: parseFloat(row.so2_g_per_km),
      };
    }
    console.log('  Class 1 (Light):', JSON.stringify(emissionFactors[1]));
    console.log('  Class 2 (Medium):', JSON.stringify(emissionFactors[2]));
    console.log('  Class 3 (Heavy):', JSON.stringify(emissionFactors[3]));

    // Step 2: Load exits and compute segment distances
    console.log('\n📍 Loading NLEX exits and computing segment distances...');
    const exitsRes = await pool.query("SELECT id, exit_name as name, latitude, longitude from bronze.nlex_exits ORDER BY latitude DESC");
    const exits = exitsRes.rows;

    // Build a lookup: "Toll Plaza Name|Direction" -> { exit_id, segment_km }
    const exitLookup = {};
    const sortedExits = exits; // Both NB and SB use the same 20 physical locations

    // Calculate segment distances for each direction
    for (const dir of ['NB', 'SB']) {
      for (let i = 0; i < sortedExits.length; i++) {
        let segmentKm = DEFAULT_SEGMENT_KM;
        if (i < sortedExits.length - 1) {
          segmentKm = haversineKm(
            parseFloat(sortedExits[i].latitude), parseFloat(sortedExits[i].longitude),
            parseFloat(sortedExits[i+1].latitude), parseFloat(sortedExits[i+1].longitude)
          );
        }
        const key = `${sortedExits[i].name.toLowerCase().trim()}|${dir}`;
        exitLookup[key] = { exit_id: sortedExits[i].id, segment_km: Math.round(segmentKm * 100) / 100, name: sortedExits[i].name };
      }
    }
    console.log(`  Mapped ${Object.keys(exitLookup).length} exit segments with computed distances.\n`);

    // Step 3: Clear the table using DELETE (avoids schema locking issues)
    console.log('\n🗄️  Clearing bronze.nlex_theoretical_emissions table...');
    await pool.query('TRUNCATE TABLE bronze.nlex_theoretical_emissions;');
    console.log('✅ Table cleared!\n');

    // Step 4: Stream the CSV and compute emissions
    console.log('📂 Reading traffic_volume_synthetic.csv and computing emissions...');
    const hours = ['00:00','01:00','02:00','03:00','04:00','05:00','06:00','07:00','08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00','21:00','22:00','23:00'];

    const rl = createInterface({ input: createReadStream(CSV_PATH), crlfDelay: Infinity });
    let lineNum = 0;
    let totalInserted = 0;
    let skipped = 0;
    let batchRows = [];
    const BATCH_SIZE = 1000;

    for await (const line of rl) {
      lineNum++;
      if (lineNum === 1) continue; // skip header

      const cols = line.split(',');
      if (cols.length < 28) continue;

      const date = cols[0];        // e.g., "2022-01-01"
      const direction = cols[1];   // "NB" or "SB"
      const tollPlaza = cols[3];   // e.g., "Balintawak"
      const vehClassStr = cols[4]; // "Class 1", "Class 2", "Class 3", "Total"

      // Skip "Total" rows — we compute per-class
      if (vehClassStr === 'Total') continue;

      // Parse vehicle class number
      const classNum = parseInt(vehClassStr.replace('Class ', ''));
      if (!emissionFactors[classNum]) continue;

      // Find matching exit
      const key = `${tollPlaza.toLowerCase().trim()}|${direction}`;
      const exitInfo = exitLookup[key];
      if (!exitInfo) {
        skipped++;
        continue;
      }

      const ef = emissionFactors[classNum];
      const segKm = exitInfo.segment_km;

      // Process each hour column (indices 5 through 28)
      for (let h = 0; h < 24; h++) {
        const volume = parseInt(cols[5 + h]) || 0;
        if (volume === 0) continue;

        const timestamp = `${date}T${hours[h].padStart(5, '0')}:00+08:00`;

        batchRows.push({
          exit_id: exitInfo.exit_id,
          timestamp_utc: timestamp,
          direction: direction,
          vehicle_class: classNum,
          volume: volume,
          segment_km: segKm,
          co2: Math.round(volume * ef.co2 * segKm * 100) / 100,
          co: Math.round(volume * ef.co * segKm * 10000) / 10000,
          no2: Math.round(volume * ef.no2 * segKm * 10000) / 10000,
          pm25: Math.round(volume * ef.pm25 * segKm * 10000) / 10000,
          pm10: Math.round(volume * ef.pm10 * segKm * 10000) / 10000,
          so2: Math.round(volume * ef.so2 * segKm * 10000) / 10000,
        });

        if (batchRows.length >= BATCH_SIZE) {
          await insertBatch(batchRows);
          totalInserted += batchRows.length;
          batchRows = [];

          if (totalInserted % 50000 === 0) {
            console.log(`  📦 ${totalInserted.toLocaleString()} rows inserted...`);
          }
        }
      }
    }

    // Flush remaining rows
    if (batchRows.length > 0) {
      await insertBatch(batchRows);
      totalInserted += batchRows.length;
    }

    console.log(`\n══════════════════════════════════════════════════════════════`);
    console.log(`  📊 THEORETICAL EMISSIONS COMPUTATION COMPLETE`);
    console.log(`  ✅ Total rows inserted: ${totalInserted.toLocaleString()}`);
    console.log(`  ⚠️  Skipped (unmatched toll plazas): ${skipped.toLocaleString()}`);
    console.log(`══════════════════════════════════════════════════════════════\n`);

  } catch (err) {
    console.error("Fatal Error:", err.message);
    console.error(err.stack);
  } finally {
    await pool.end();
  }
}

async function insertBatch(rows) {
  const values = [];
  const placeholders = [];
  let i = 1;

  for (const r of rows) {
    placeholders.push(`($${i}, $${i+1}, $${i+2}, $${i+3}, $${i+4}, $${i+5}, $${i+6}, $${i+7}, $${i+8}, $${i+9}, $${i+10}, $${i+11})`);
    values.push(r.exit_id, r.timestamp_utc, r.direction, r.vehicle_class, r.volume, r.segment_km, r.co2, r.co, r.no2, r.pm25, r.pm10, r.so2);
    i += 12;
  }

  const query = `
    INSERT INTO bronze.nlex_theoretical_emissions 
      (exit_id, timestamp_utc, direction, vehicle_class, volume, segment_distance_km, co2_grams, co_grams, no2_grams, pm25_grams, pm10_grams, so2_grams)
    VALUES ${placeholders.join(', ')}
  `;

  await pool.query(query, values);
}

main();
