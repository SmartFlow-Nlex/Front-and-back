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

async function checkNulls() {
  try {
    console.log("Checking for NULL values in hourly_weather...\n");
    const res = await pool.query(`
      SELECT 
        COUNT(*) as total_rows,
        COUNT(temperature) as temp_filled,
        COUNT(rainfall) as rain_filled,
        COUNT(quality_score) as quality_filled,
        COUNT(validation_version) as val_version_filled
      FROM hourly_weather;
    `);
    
    const row = res.rows[0];
    console.log(`Total Rows: ${row.total_rows}`);
    console.log(`Temperature Filled: ${row.temp_filled} / ${row.total_rows}`);
    console.log(`Rainfall Filled: ${row.rain_filled} / ${row.total_rows}`);
    console.log(`Quality Score Filled: ${row.quality_filled} / ${row.total_rows}`);
    console.log(`Validation Version Filled: ${row.val_version_filled} / ${row.total_rows}`);

  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await pool.end();
  }
}

checkNulls();
