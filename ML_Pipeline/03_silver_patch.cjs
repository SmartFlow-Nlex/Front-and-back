const pg = require('pg');

const pool = new pg.Pool({
  host: 'smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'Hanszy123',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  console.log('Patching Silver Views...');

  // Emissions View
  await pool.query('DROP VIEW IF EXISTS silver.emissions CASCADE;');
  await pool.query(`
    CREATE VIEW silver.emissions AS
    SELECT * FROM bronze.emissions;
  `);

  // Theoretical Emissions View
  await pool.query('DROP VIEW IF EXISTS silver.theoretical_emissions CASCADE;');
  await pool.query(`
    CREATE VIEW silver.theoretical_emissions AS
    SELECT * FROM bronze.theoretical_emissions;
  `);

  console.log('✅ Silver views patched successfully.');
  pool.end();
}

main().catch(e => { console.error('Error:', e); pool.end(); });
