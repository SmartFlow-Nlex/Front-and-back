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
    CREATE TABLE IF NOT EXISTS bronze.nlex_emissions (
      id SERIAL PRIMARY KEY,
      exit_id INTEGER,
      aqi INTEGER,
      co NUMERIC,
      "no" NUMERIC,
      no2 NUMERIC,
      o3 NUMERIC,
      so2 NUMERIC,
      pm2_5 NUMERIC,
      pm10 NUMERIC,
      api_dt BIGINT,
      raw_response JSONB
    );
  `);
  console.log('nlex_emissions table created.');
  await pool.end();
}
main();
