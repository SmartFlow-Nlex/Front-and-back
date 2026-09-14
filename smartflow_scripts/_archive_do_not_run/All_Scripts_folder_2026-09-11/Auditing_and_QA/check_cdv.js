require('dotenv').config(); // DB credentials come from .env, never from source
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.PG_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkCDV() {
  const res = await pool.query(`
    SELECT toll_plaza, exit_id, count(*) 
    FROM bronze.nlex_traffic_volume 
    WHERE toll_plaza ILIKE '%CDV%' OR toll_plaza ILIKE '%Arena%'
    GROUP BY toll_plaza, exit_id
  `);
  console.table(res.rows);
  pool.end();
}
checkCDV().catch(console.error);
