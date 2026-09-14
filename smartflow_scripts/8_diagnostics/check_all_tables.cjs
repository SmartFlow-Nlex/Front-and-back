const { Pool } = require('pg');

const p = new Pool(require("../config/db.cjs").poolConfig);

async function checkAllTables() {
  await p.connect();
  console.log("Connected. Fetching all tables in all schemas...");

  try {
    const res = await p.query(`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
      ORDER BY table_schema, table_name
    `);
    
    console.log("Tables found:");
    for (const row of res.rows) {
        console.log(`- ${row.table_schema}.${row.table_name}`);
    }
  } catch (e) {
    console.error("Error:", e);
  } finally {
    await p.end();
  }
}

checkAllTables();
