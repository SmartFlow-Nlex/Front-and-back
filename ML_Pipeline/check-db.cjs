const pg = require('pg');
const pool = new pg.Pool({
  host: 'smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'Hanszy123',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const res = await pool.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    ORDER BY table_name
  `);
  console.log('=== ALL TABLES ===');
  res.rows.forEach(r => console.log('  ' + r.table_name));

  // Check row counts for each table
  for (const row of res.rows) {
    const cnt = await pool.query(`SELECT COUNT(*) as c FROM "${row.table_name}"`);
    console.log(`  ${row.table_name}: ${parseInt(cnt.rows[0].c).toLocaleString()} rows`);
  }

  pool.end();
}
main().catch(e => { console.error(e); pool.end(); });
