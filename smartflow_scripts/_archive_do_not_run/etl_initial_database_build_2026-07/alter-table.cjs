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
  try {
    await pool.query('ALTER TABLE bronze.nlex_emissions ADD COLUMN raw_response JSONB;');
    console.log('Added raw_response column.');
  } catch (e) {
    console.log(e.message);
  }
  await pool.end();
}
main();
