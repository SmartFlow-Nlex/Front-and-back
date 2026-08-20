const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  // The Climatiq API returned: 1.49227543 kg/km = 1492 g/km for Diesel HGV (>30t)
  // The emission factor table is already updated to co2_g_per_km = 1492
  // 
  // Formula (from Class 1 reverse-engineering):
  //   co2_grams = volume * co2_g_per_km * segment_distance_km
  //
  // Class 1: 192 g/km * 5.18 km = 994.56 g/vehicle  ✓ (matches DB)
  // Class 3: 1492 g/km * segment_distance_km = varies per exit

  const CO2_G_PER_KM = 1492;

  // Verify the current state — all Class 3 co2_grams should be 0
  const before = await pool.query(`
    SELECT COUNT(*) as total, 
           SUM(CASE WHEN co2_grams = 0 THEN 1 ELSE 0 END) as zero_rows,
           SUM(volume)::bigint as total_volume
    FROM nlex_theoretical_emissions 
    WHERE vehicle_class = 3
  `);
  console.log('=== BEFORE UPDATE (Class 3) ===');
  console.log(before.rows[0]);

  // Recalculate: co2_grams = volume * 1492 * segment_distance_km
  console.log(`\nUpdating 1,516,597 Class 3 rows with co2_g_per_km = ${CO2_G_PER_KM}...`);
  const result = await pool.query(`
    UPDATE nlex_theoretical_emissions
    SET co2_grams = volume * ${CO2_G_PER_KM} * segment_distance_km
    WHERE vehicle_class = 3
  `);
  console.log(`Rows updated: ${result.rowCount}`);

  // Verify after
  const after = await pool.query(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN co2_grams = 0 THEN 1 ELSE 0 END) as zero_rows,
           SUM(CASE WHEN co2_grams > 0 THEN 1 ELSE 0 END) as nonzero_rows,
           SUM(co2_grams)::bigint as total_co2_grams,
           ROUND((SUM(co2_grams) / 1e6)::numeric, 2)::float as total_co2_tonnes
    FROM nlex_theoretical_emissions
    WHERE vehicle_class = 3
  `);
  console.log('\n=== AFTER UPDATE (Class 3) ===');
  console.log(after.rows[0]);

  // Final comparison: all 3 classes
  const all = await pool.query(`
    SELECT vehicle_class,
           COUNT(*) as rows,
           SUM(volume)::bigint as total_volume,
           ROUND((SUM(co2_grams) / 1e6)::numeric, 2)::float as co2_tonnes,
           f.co2_g_per_km
    FROM nlex_theoretical_emissions t
    LEFT JOIN nlex_emission_factors f ON f.vehicle_class = t.vehicle_class
    GROUP BY t.vehicle_class, f.co2_g_per_km
    ORDER BY t.vehicle_class
  `);
  console.log('\n=== ALL CLASSES COMPARISON ===');
  console.table(all.rows);

  // Show updated emission factors table
  const factors = await pool.query('SELECT * FROM nlex_emission_factors ORDER BY vehicle_class');
  console.log('\n=== UPDATED nlex_emission_factors ===');
  console.table(factors.rows);

  await pool.end();
}

main().catch(e => { console.error(e); pool.end(); });
