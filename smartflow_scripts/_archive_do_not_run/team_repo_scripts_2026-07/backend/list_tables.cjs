throw new Error("ARCHIVED - do not run. Team repo scripts from July 2026 (Kia's descriptive branch); superseded by the current trainers. Kept only as a record; see smartflow_scripts/README.md.");
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.POSTGRES_URL, ssl: { rejectUnauthorized: false } });
pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('nlex_traffic_volume', 'fact_waze_jams')").then(res => {
  console.log("COLUMNS:");
  res.rows.forEach(r => console.log(`${r.table_name}.${r.column_name}`));
  pool.end();
}).catch(err => {
  console.error(err);
  pool.end();
});
