const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  // 1. Check nlex_traffic_volume schema and toll_plaza values
  console.log('=== nlex_traffic_volume schema ===');
  const cols = await pool.query(`
    SELECT table_schema, column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'nlex_traffic_volume' 
    ORDER BY table_schema, ordinal_position
  `);
  console.table(cols.rows);

  console.log('\n=== Distinct toll_plaza values in nlex_traffic_volume ===');
  const plazas = await pool.query(`
    SELECT DISTINCT toll_plaza, COUNT(*) as row_count
    FROM nlex_traffic_volume
    GROUP BY toll_plaza
    ORDER BY toll_plaza
  `);
  console.table(plazas.rows);

  // 2. Check philippine_arena_events
  console.log('\n=== philippine_arena_events schema ===');
  const evCols = await pool.query(`
    SELECT table_schema, column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'philippine_arena_events' 
    ORDER BY table_schema, ordinal_position
  `);
  console.table(evCols.rows);

  console.log('\n=== philippine_arena_events nlex_exit_id values ===');
  const evExits = await pool.query(`
    SELECT DISTINCT nlex_exit_id, COUNT(*) as cnt
    FROM philippine_arena_events 
    GROUP BY nlex_exit_id
  `);
  console.table(evExits.rows);

  console.log('\n=== Sample philippine_arena_events ===');
  const evSample = await pool.query(`SELECT * FROM philippine_arena_events LIMIT 5`);
  console.table(evSample.rows);

  // 3. Check which tables reference toll_plaza
  console.log('\n=== Tables with toll_plaza column ===');
  const tpTables = await pool.query(`
    SELECT table_schema, table_name, column_name 
    FROM information_schema.columns 
    WHERE column_name = 'toll_plaza'
    ORDER BY table_schema, table_name
  `);
  console.table(tpTables.rows);

  // 4. Current nlex_exits for reference
  console.log('\n=== Current nlex_exits ===');
  const exits = await pool.query(`SELECT exit_id, exit_name FROM nlex_exits ORDER BY exit_id`);
  console.table(exits.rows);

  await pool.end();
}
main().catch(e => { console.error(e); pool.end(); });
