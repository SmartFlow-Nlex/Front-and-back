throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
import pg from 'pg';

const AWS_PG = {
  host: 'smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'REMOVED',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
};

const pool = new pg.Pool(AWS_PG);

async function check() {
  try {
    console.log("Checking hourly_weather row count in AWS RDS...");
    const res = await pool.query('SELECT COUNT(*) FROM hourly_weather');
    console.log(`\n✅ RESULT: The hourly_weather table currently has ${res.rows[0].count} rows.`);
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await pool.end();
  }
}

check();
