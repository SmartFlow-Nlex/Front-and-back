const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  try {
    // 1. nlex_exits table
    console.log("=== nlex_exits schema ===");
    const exitCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'nlex_exits' ORDER BY ordinal_position");
    console.log(exitCols.rows.map(r => r.column_name));
    console.log("\n=== ALL nlex_exits rows ===");
    const exits = await pool.query("SELECT * FROM nlex_exits ORDER BY km_post");
    console.log(exits.rows);

    // 2. Distinct toll plazas from traffic volume
    console.log("\n=== Distinct toll_plaza from nlex_traffic_volume ===");
    const plazas = await pool.query("SELECT DISTINCT toll_plaza FROM nlex_traffic_volume ORDER BY toll_plaza");
    console.log(plazas.rows);

    // 3. Waze fact_hourly_jams columns
    console.log("\n=== fact_hourly_jams columns ===");
    const wazeCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'fact_hourly_jams' ORDER BY ordinal_position");
    console.log(wazeCols.rows.map(r => r.column_name));

    // 4. Distinct locations in road crashes
    console.log("\n=== Distinct locations in nlex_road_crashes (sample) ===");
    const crashLocs = await pool.query("SELECT DISTINCT location FROM nlex_road_crashes ORDER BY location LIMIT 20");
    console.log(crashLocs.rows);

    pool.end();
  } catch (err) {
    console.error(err);
    pool.end();
  }
}

check();
