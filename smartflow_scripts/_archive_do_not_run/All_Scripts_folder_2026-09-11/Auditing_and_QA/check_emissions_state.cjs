require('dotenv').config(); // DB credentials come from .env, never from source
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.PG_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  const r1 = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='bronze' AND table_name='nlex_emissions' ORDER BY ordinal_position`);
  console.log('=== bronze.nlex_emissions schema ===');
  console.table(r1.rows);

  const r2 = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='bronze' AND table_name='nlex_emission_factors' ORDER BY ordinal_position`);
  console.log('=== bronze.nlex_emission_factors schema ===');
  console.table(r2.rows);

  const r3 = await pool.query(`SELECT exit_id, exit_name, COUNT(*)::int as cnt FROM bronze.nlex_emissions GROUP BY exit_id, exit_name ORDER BY exit_id LIMIT 25`);
  console.log('=== nlex_emissions data distribution ===');
  console.table(r3.rows);

  const r4 = await pool.query(`SELECT * FROM bronze.nlex_emission_factors LIMIT 10`);
  console.log('=== nlex_emission_factors sample ===');
  console.table(r4.rows);

  const r5 = await pool.query(`SELECT COUNT(*)::int as total, MIN(date_day)::text as min_date, MAX(date_day)::text as max_date FROM bronze.nlex_emissions`);
  console.log('=== nlex_emissions date range ===');
  console.table(r5.rows);

  // Check emissions service
  const r6 = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema IN ('silver','gold') AND table_name ILIKE '%emiss%'`);
  console.log('=== Emissions tables in silver/gold ===');
  console.table(r6.rows);

  pool.end();
})().catch(e => { console.error(e); pool.end(); });
