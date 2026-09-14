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
  // Check columns of nlex_traffic_volume
  const tv = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='bronze' AND table_name='nlex_traffic_volume' ORDER BY ordinal_position");
  console.log('\n=== bronze.nlex_traffic_volume columns ===');
  tv.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

  // Check a sample row
  const sample = await pool.query("SELECT * FROM bronze.nlex_traffic_volume LIMIT 1");
  console.log('\nSample row:', sample.rows[0]);

  await pool.end();
}
main();
