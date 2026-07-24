const pg = require('pg');

// Supabase projects found on the machine
const supabaseProjects = [
  {
    name: 'hunmrgnszbaqizpdmseq (LAB_REPORT2_DM)',
    url: 'postgresql://postgres.hunmrgnszbaqizpdmseq:TeraDrip1234_@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres?sslmode=require'
  },
  {
    name: 'eoyopmstogazaflwisbg (Date-Warehouse-Airline)',
    url: 'postgresql://postgres.eoyopmstogazaflwisbg:TeraDrip1234_@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require'
  }
];

async function checkProject(project) {
  console.log(`\nChecking: ${project.name}`);
  const pool = new pg.Pool({ connectionString: project.url });
  try {
    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name LIKE '%arena%' OR table_name LIKE '%philippine%' OR table_name LIKE '%event%'
      ORDER BY table_name
    `);
    if (tables.rows.length > 0) {
      console.log('  FOUND tables:');
      for (const t of tables.rows) {
        const cnt = await pool.query(`SELECT COUNT(*) as c FROM "${t.table_name}"`);
        console.log(`    ${t.table_name}: ${cnt.rows[0].c} rows`);
      }
    } else {
      console.log('  No arena/event tables found. Listing all tables:');
      const all = await pool.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' 
        ORDER BY table_name
      `);
      all.rows.forEach(r => console.log('    ' + r.table_name));
    }
    pool.end();
  } catch (err) {
    console.log('  Connection failed:', err.message);
    pool.end();
  }
}

async function main() {
  for (const p of supabaseProjects) {
    await checkProject(p);
  }
}
main();
