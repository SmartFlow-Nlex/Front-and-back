const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  // Check the column types
  const cols = await pool.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_schema = 'bronze' AND table_name = 'nlex_theoretical_emissions'
    AND column_name IN ('pm25_grams', 'pm10_grams', 'so2_grams', 'co2_grams', 'co_grams', 'no2_grams', 'volume', 'segment_distance_km')
    ORDER BY ordinal_position
  `);
  console.log('=== Column types ===');
  console.table(cols.rows);

  await pool.end();
}
main().catch(e => { console.error(e); pool.end(); });
