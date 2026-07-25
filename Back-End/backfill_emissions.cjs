const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false }
});

const FACTORS = {
  1: { co2: 160, co: 1, no2: 0.08, pm25: 0.005, pm10: 0.012, so2: 0.002 },
  2: { co2: 550, co: 3.5, no2: 3, pm25: 0.1, pm10: 0.18, so2: 0.015 },
  3: { co2: 950, co: 4, no2: 7, pm25: 0.15, pm10: 0.28, so2: 0.03 }
};

const SEGMENT_KM = 11.61; // Average segment distance used in sample row

async function backfill() {
  try {
    console.log("Starting backfill for 2020-2021 Theoretical Emissions...");

    // 1. Get sample exit_id to use if we can't map
    const exitRes = await pool.query('SELECT exit_id FROM nlex_theoretical_emissions LIMIT 1');
    const defaultExitId = exitRes.rows[0]?.exit_id;

    if (!defaultExitId) {
      throw new Error("No exit_id found in nlex_theoretical_emissions to use as reference.");
    }

    // 2. Fetch traffic volumes for 2020-2021
    console.log("Querying nlex_traffic_volume for 2020-2021...");
    const volQuery = `
      SELECT * FROM nlex_traffic_volume 
      WHERE date >= '2020-01-01' AND date < '2022-01-01'
      AND type = 'Entries'
    `;
    const res = await pool.query(volQuery);
    const rows = res.rows;
    console.log(`Fetched ${rows.length} rows from traffic_volume.`);

    if (rows.length === 0) {
      console.log("No traffic volume data found for 2020-2021. Nothing to backfill.");
      pool.end();
      return;
    }

    // 3. Transform and build insert query
    let insertedCount = 0;
    const BATCH_SIZE = 5000;
    let valuesList = [];

    const insertPrefix = `
      INSERT INTO nlex_theoretical_emissions (
        id, exit_id, timestamp_utc, direction, vehicle_class, volume, 
        segment_distance_km, co2_grams, co_grams, no2_grams, pm25_grams, 
        pm10_grams, so2_grams, created_at, methodology_tier
      ) VALUES 
    `;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      let vClass = 1;
      if (r.vehicle_class === 'Class 2') vClass = 2;
      if (r.vehicle_class === 'Class 3') vClass = 3;

      const factor = FACTORS[vClass];
      const d = new Date(r.date);

      // Unnest hours h00..h23
      for (let h = 0; h < 24; h++) {
        const hKey = `h${String(h).padStart(2, '0')}`;
        const vol = r[hKey];
        
        if (vol > 0) {
          // Construct timestamp
          const ts = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, 0, 0));
          
          const co2 = vol * SEGMENT_KM * factor.co2;
          const co = vol * SEGMENT_KM * factor.co;
          const no2 = vol * SEGMENT_KM * factor.no2;
          const pm25 = vol * SEGMENT_KM * factor.pm25;
          const pm10 = vol * SEGMENT_KM * factor.pm10;
          const so2 = vol * SEGMENT_KM * factor.so2;

          valuesList.push(`(
            gen_random_uuid(), '${defaultExitId}', '${ts.toISOString()}', '${r.direction}', 
            ${vClass}, ${vol}, ${SEGMENT_KM}, ${co2}, ${co}, ${no2}, ${pm25}, ${pm10}, ${so2}, 
            NOW(), 'IPCC Tier 2 (Synthetic Backfill)'
          )`);

          if (valuesList.length >= BATCH_SIZE) {
            await pool.query(insertPrefix + valuesList.join(","));
            insertedCount += valuesList.length;
            console.log(`Inserted ${insertedCount} rows...`);
            valuesList = [];
          }
        }
      }
    }

    if (valuesList.length > 0) {
      await pool.query(insertPrefix + valuesList.join(","));
      insertedCount += valuesList.length;
    }

    console.log(`\nBackfill complete! Inserted total of ${insertedCount} rows into nlex_theoretical_emissions.`);
    pool.end();
  } catch (err) {
    console.error("Error during backfill:", err);
    pool.end();
  }
}

backfill();
