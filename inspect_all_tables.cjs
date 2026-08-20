const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone', ssl: { rejectUnauthorized: false } });

async function main() {
  const currentExits = await pool.query('SELECT * FROM bronze.nlex_exits ORDER BY exit_id');
  console.log('=== bronze.nlex_exits Current Rows ===');
  console.table(currentExits.rows);

  try {
    const silverExits = await pool.query('SELECT * FROM silver.nlex_exit_reference ORDER BY 1 LIMIT 25');
    console.log('=== silver.nlex_exit_reference ===');
    console.table(silverExits.rows);
  } catch (e) {
    console.log('silver.nlex_exit_reference query error:', e.message);
  }

  // Check exit_id min/max across tables
  for (const tbl of ['bronze.nlex_theoretical_emissions', 'bronze.nlex_emissions', 'silver.nlex_emissions_clean']) {
    try {
      const res = await pool.query(`SELECT MIN(exit_id) as min_id, MAX(exit_id) as max_id, COUNT(DISTINCT exit_id) as unique_exits FROM ${tbl}`);
      console.log(`=== ${tbl} exit_id Stats ===`);
      console.table(res.rows);
    } catch(e) {
      console.log(`Error checking ${tbl}:`, e.message);
    }
  }

  await pool.end();
}
main().catch(e => { console.error(e); pool.end(); });
