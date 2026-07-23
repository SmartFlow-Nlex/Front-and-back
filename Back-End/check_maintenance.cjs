const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkMaintenance() {
  try {
    // 1. Find the maintenance table
    const tableRes = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name LIKE '%maintenance%' OR table_name LIKE '%schedule%' OR table_name LIKE '%event%'
    `);
    
    console.log("Matching tables:");
    console.log(tableRes.rows);
    
    for (const row of tableRes.rows) {
      const t = row.table_name;
      console.log(`\n--- Latest rows from ${t} ---`);
      try {
        const dataRes = await pool.query(`SELECT * FROM ${t} ORDER BY created_at DESC LIMIT 5`);
        console.log(dataRes.rows);
      } catch (e) {
        console.log("Could not query created_at, falling back to unordered...");
        const fallback = await pool.query(`SELECT * FROM ${t} LIMIT 5`);
        console.log(fallback.rows);
      }
    }

    pool.end();
  } catch (err) {
    console.error(err);
    pool.end();
  }
}

checkMaintenance();
