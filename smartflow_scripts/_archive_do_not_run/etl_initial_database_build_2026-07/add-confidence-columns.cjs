throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
const pg = require('pg');
const pool = new pg.Pool({
  host: 'smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'REMOVED',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    console.log('Adding methodology_tier to nlex_theoretical_emissions...');
    await pool.query("ALTER TABLE nlex_theoretical_emissions ADD COLUMN methodology_tier VARCHAR(50) DEFAULT 'IPCC Tier 2 (Climatiq API)'");
    console.log('Done.');

    console.log('Adding data_confidence to nlex_emissions...');
    await pool.query("ALTER TABLE nlex_emissions ADD COLUMN data_confidence VARCHAR(50) DEFAULT 'High (OpenWeatherMap)'");
    console.log('Done.');
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

run();
