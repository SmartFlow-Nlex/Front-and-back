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
  // Get all tables across all schemas
  const res = await pool.query(`
    SELECT table_schema, table_name, 
      (SELECT reltuples::bigint FROM pg_class WHERE oid = (quote_ident(table_schema) || '.' || quote_ident(table_name))::regclass) AS approx_rows
    FROM information_schema.tables 
    WHERE table_schema IN ('bronze', 'silver', 'gold', 'public')
    AND table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name;
  `);
  
  console.log('\n=== ALL TABLES IN DATABASE ===\n');
  let currentSchema = '';
  for (const row of res.rows) {
    if (row.table_schema !== currentSchema) {
      currentSchema = row.table_schema;
      console.log(`\n--- ${currentSchema.toUpperCase()} SCHEMA ---`);
    }
    console.log(`  ${row.table_name}: ~${Number(row.approx_rows).toLocaleString()} rows`);
  }
  
  await pool.end();
}
main();
