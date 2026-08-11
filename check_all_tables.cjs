const { Pool } = require('pg');

const p = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'Hanszy123!',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

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
