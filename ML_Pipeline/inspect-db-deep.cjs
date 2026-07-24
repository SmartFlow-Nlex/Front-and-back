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
  // Get all tables with columns
  const tables = await pool.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  for (const t of tables.rows) {
    const cols = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [t.table_name]);

    const cnt = await pool.query(`SELECT COUNT(*) as c FROM "${t.table_name}"`);
    
    console.log(`\n=== ${t.table_name} (${parseInt(cnt.rows[0].c).toLocaleString()} rows) ===`);
    cols.rows.forEach(c => {
      console.log(`  ${c.column_name} [${c.data_type}] ${c.is_nullable === 'NO' ? 'NOT NULL' : ''}`);
    });
  }

  // Check existing schemas
  const schemas = await pool.query(`SELECT schema_name FROM information_schema.schemata ORDER BY schema_name`);
  console.log('\n=== EXISTING SCHEMAS ===');
  schemas.rows.forEach(s => console.log('  ' + s.schema_name));

  // Check DB size
  const size = await pool.query(`SELECT pg_size_pretty(pg_database_size('nlex_capstone')) as db_size`);
  console.log('\n=== TOTAL DATABASE SIZE ===');
  console.log('  ' + size.rows[0].db_size);

  pool.end();
}
main().catch(e => { console.error(e); pool.end(); });
