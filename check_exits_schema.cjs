const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone', ssl: { rejectUnauthorized: false } });

async function main() {
  // Check schema of bronze.nlex_exits and public.nlex_exits view
  const cols = await pool.query(`
    SELECT table_schema, table_name, column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'nlex_exits'
    ORDER BY table_schema, ordinal_position
  `);
  console.log('=== nlex_exits Columns ===');
  console.table(cols.rows);

  const viewDef = await pool.query(`SELECT pg_get_viewdef('public.nlex_exits'::regclass, true)`);
  console.log('=== public.nlex_exits View Def ===');
  console.log(viewDef.rows[0].pg_get_viewdef);

  // Check tables referencing exit_id or containing exit information
  const tablesWithExit = await pool.query(`
    SELECT table_schema, table_name, column_name 
    FROM information_schema.columns 
    WHERE column_name IN ('exit_id', 'exit_name')
    ORDER BY table_schema, table_name
  `);
  console.log('=== Tables with exit_id/exit_name ===');
  console.table(tablesWithExit.rows);

  await pool.end();
}
main().catch(e => { console.error(e); pool.end(); });
