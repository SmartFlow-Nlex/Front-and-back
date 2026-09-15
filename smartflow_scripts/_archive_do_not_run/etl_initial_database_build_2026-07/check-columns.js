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
    console.log("Fetching columns for 'hourly_weather'...\n");
    
    // Get column definitions
    const colRes = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'hourly_weather'
      ORDER BY ordinal_position;
    `);
    
    console.log("📝 COLUMNS IN 'hourly_weather':");
    colRes.rows.forEach(row => {
        console.log(` - ${row.column_name.padEnd(20)} [${row.data_type}]`);
    });

    console.log("\n📊 ONE SAMPLE ROW OF DATA:");
    const rowRes = await pool.query('SELECT * FROM hourly_weather LIMIT 1');
    if (rowRes.rows.length > 0) {
        console.log(rowRes.rows[0]);
    } else {
        console.log("Table is empty.");
    }

  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await pool.end();
  }
}

check();
