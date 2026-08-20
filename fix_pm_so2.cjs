const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const factors = {
    1: { pm25: 0.005, pm10: 0.035, so2: 0.005 },
    2: { pm25: 0.030, pm10: 0.070, so2: 0.015 },
    3: { pm25: 0.020, pm10: 0.091, so2: 0.029 },
  };

  // Recalculate all emission rows using direct SQL with casted values
  console.log('=== Recalculating 4.6M emission rows ===');
  for (const cls of [1, 2, 3]) {
    const vals = factors[cls];
    console.log(`  Updating Class ${cls}: PM2.5=${vals.pm25}, PM10=${vals.pm10}, SO2=${vals.so2} g/km ...`);
    const result = await pool.query(`
      UPDATE bronze.nlex_theoretical_emissions
      SET pm25_grams = volume * ${vals.pm25} * segment_distance_km,
          pm10_grams = volume * ${vals.pm10} * segment_distance_km,
          so2_grams  = volume * ${vals.so2} * segment_distance_km
      WHERE vehicle_class = ${cls}
    `);
    console.log(`    ${result.rowCount} rows updated.`);
  }

  // Verify
  console.log('\n=== Verification ===');
  const verify = await pool.query(`
    SELECT vehicle_class,
      COUNT(*) as total,
      SUM(CASE WHEN pm25_grams::text = 'NaN' OR pm25_grams IS NULL THEN 1 ELSE 0 END) as bad_pm25,
      SUM(CASE WHEN pm10_grams::text = 'NaN' OR pm10_grams IS NULL THEN 1 ELSE 0 END) as bad_pm10,
      SUM(CASE WHEN so2_grams::text = 'NaN' OR so2_grams IS NULL THEN 1 ELSE 0 END) as bad_so2,
      ROUND((SUM(pm25_grams) / 1e3)::numeric, 2)::float as pm25_kg,
      ROUND((SUM(pm10_grams) / 1e3)::numeric, 2)::float as pm10_kg,
      ROUND((SUM(so2_grams) / 1e3)::numeric, 2)::float as so2_kg
    FROM nlex_theoretical_emissions
    GROUP BY vehicle_class ORDER BY vehicle_class
  `);
  console.log('Final state (0 bad = success):');
  console.table(verify.rows);

  await pool.end();
  console.log('\nDone!');
}

main().catch(e => { console.error(e); pool.end(); });
