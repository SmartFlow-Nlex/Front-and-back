throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
const { Pool } = require('pg');
const pool = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'REMOVED',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});
async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bronze.nlex_theoretical_emissions (
      id SERIAL PRIMARY KEY,
      exit_id INTEGER,
      timestamp_utc TIMESTAMP,
      direction VARCHAR(50),
      vehicle_class INTEGER,
      volume INTEGER,
      segment_distance_km NUMERIC,
      co2_grams NUMERIC,
      co_grams NUMERIC,
      no2_grams NUMERIC,
      pm25_grams NUMERIC,
      pm10_grams NUMERIC,
      so2_grams NUMERIC
    );
  `);
  console.log('Table created.');
  await pool.end();
}
main();
