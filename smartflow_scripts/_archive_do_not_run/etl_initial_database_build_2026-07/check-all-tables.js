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

async function checkAll() {
  try {
    console.log("Checking row counts for all tables in AWS RDS...\n");
    
    // We include all tables from our schema, plus 'source_scores' which your groupmate mentioned
    const tables = [
        'nlex_exits', 
        'nlex_emission_factors', 
        'nlex_emissions', 
        'hourly_weather', 
        'weather_cells', 
        'philippine_arena_events',
        'source_scores'
    ];
    
    for (const table of tables) {
      try {
        const res = await pool.query(`SELECT COUNT(*) FROM ${table}`);
        console.log(`✅ ${table.padEnd(25)}: ${res.rows[0].count} rows`);
      } catch (err) {
        console.log(`⚠️ ${table.padEnd(25)}: (Table does not exist or empty)`);
      }
    }
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await pool.end();
  }
}

checkAll();
