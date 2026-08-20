const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone', ssl: { rejectUnauthorized: false } });

async function main() {
  // Check exit_id vs exit_name in bronze.nlex_emissions
  const emSample = await pool.query(`
    SELECT DISTINCT exit_id, exit_name 
    FROM bronze.nlex_emissions 
    ORDER BY exit_id
  `);
  console.log('=== bronze.nlex_emissions (exit_id, exit_name) ===');
  console.table(emSample.rows);

  // Check exit_id in bronze.nlex_theoretical_emissions
  const teSample = await pool.query(`
    SELECT DISTINCT exit_id 
    FROM bronze.nlex_theoretical_emissions 
    ORDER BY exit_id
  `);
  console.log('=== bronze.nlex_theoretical_emissions exit_ids ===');
  console.table(teSample.rows);

  // Check silver.nlex_emissions_clean
  const secSample = await pool.query(`
    SELECT DISTINCT exit_id, exit_name 
    FROM silver.nlex_emissions_clean 
    ORDER BY exit_id
  `);
  console.log('=== silver.nlex_emissions_clean (exit_id, exit_name) ===');
  console.table(secSample.rows);

  // Check gold tables
  try {
    const gold1 = await pool.query(`SELECT DISTINCT exit_name FROM gold.daily_emissions_summary ORDER BY exit_name`);
    console.log('=== gold.daily_emissions_summary exit_names ===');
    console.table(gold1.rows);
  } catch(e) { console.log('gold summary err:', e.message); }

  await pool.end();
}
main().catch(e => { console.error(e); pool.end(); });
