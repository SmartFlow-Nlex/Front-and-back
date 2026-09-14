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
  // Set the default search_path for the postgres user so all queries resolve across schemas
  await pool.query("ALTER DATABASE nlex_capstone SET search_path TO public, bronze, silver, gold;");
  console.log('✅ search_path updated for nlex_capstone database');

  // Also set it for the current session to verify
  await pool.query("SET search_path TO public, bronze, silver, gold;");

  // Verify
  const sp = await pool.query("SHOW search_path;");
  console.log('Current search_path:', sp.rows[0].search_path);

  // Test the queries the app uses
  try {
    const test = await pool.query("SELECT COUNT(*) as cnt FROM nlex_traffic_volume");
    console.log('✅ nlex_traffic_volume:', test.rows[0].cnt, 'rows');
  } catch(e) {
    console.log('❌ nlex_traffic_volume:', e.message);
  }

  try {
    const test2 = await pool.query("SELECT COUNT(*) as cnt FROM nlex_incidents");
    console.log('✅ nlex_incidents:', test2.rows[0].cnt, 'rows');
  } catch(e) {
    console.log('❌ nlex_incidents:', e.message);
  }

  try {
    const test3 = await pool.query("SELECT COUNT(*) as cnt FROM waze_hourly_jams");
    console.log('✅ waze_hourly_jams:', test3.rows[0].cnt, 'rows');
  } catch(e) {
    console.log('❌ waze_hourly_jams:', e.message);
  }

  await pool.end();
}
main();
