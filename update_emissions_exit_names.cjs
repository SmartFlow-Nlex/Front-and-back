const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  console.log('=== Updating exit_name in bronze.nlex_emissions based on exit_id ===');
  const res = await pool.query(`
    UPDATE bronze.nlex_emissions e
    SET exit_name = x.exit_name
    FROM bronze.nlex_exits x
    WHERE e.exit_id = x.exit_id
  `);
  console.log(`Updated ${res.rowCount} rows in bronze.nlex_emissions.`);

  await pool.end();
}

main().catch(e => {
  console.error(e);
  pool.end();
});
