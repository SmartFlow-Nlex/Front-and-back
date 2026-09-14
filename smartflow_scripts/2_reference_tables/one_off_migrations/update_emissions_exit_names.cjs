if (process.env.ALLOW_MIGRATION !== "1") {
  console.error("One-off migration, already applied to the database. Re-running it can duplicate or undo changes. Set ALLOW_MIGRATION=1 to run it deliberately.");
  process.exit(1);
}
const { Pool } = require('pg');
const pool = new Pool(require("../../config/db.cjs").poolConfig);

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
