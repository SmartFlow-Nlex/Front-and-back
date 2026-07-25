const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkTables() {
  try {
    const res = await pool.query(`SELECT * FROM nlex_emission_factors`);
    console.log("Emission Factors:");
    console.table(res.rows);
    pool.end();
  } catch (err) {
    console.error(err);
    pool.end();
  }
}

checkTables();
