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
  // Check current search_path
  const sp = await pool.query("SHOW search_path;");
  console.log('search_path:', sp.rows[0].search_path);

  // Check if nlex_traffic_volume exists in public
  const pub = await pool.query("SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema='public' AND table_name='nlex_traffic_volume'");
  console.log('nlex_traffic_volume in public?', pub.rows[0].cnt > 0 ? 'YES' : 'NO');

  // Check if there's a view or synonym
  const views = await pool.query("SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_name='nlex_traffic_volume'");
  console.log('nlex_traffic_volume locations:', views.rows);

  // Try querying it directly like the app would
  try {
    const test = await pool.query("SELECT COUNT(*) as cnt FROM nlex_traffic_volume");
    console.log('Direct query nlex_traffic_volume:', test.rows[0].cnt, 'rows');
  } catch(e) {
    console.log('Direct query FAILED:', e.message);
  }

  // Try querying vehicle_classes
  try {
    const vc = await pool.query("SELECT COUNT(*) as cnt FROM vehicle_classes");
    console.log('Direct query vehicle_classes:', vc.rows[0].cnt, 'rows');
  } catch(e) {
    console.log('Direct query vehicle_classes FAILED:', e.message);
  }

  await pool.end();
}
main();
