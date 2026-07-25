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
