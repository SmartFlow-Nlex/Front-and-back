const https = require('https');
const pg = require('pg');

// Supabase source
const SUPABASE_URL = 'https://cksprtvjsjrsldamlylc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNrc3BydHZqc2pyc2xkYW1seWxjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MDk4NzgwMCwiZXhwIjoyMDk2NTYzODAwfQ.YUGqdGu5L4sZXIkTAuQ9-cadZv5zMADyMpX8xDFK0WU';

// AWS RDS target
const pool = new pg.Pool({
  host: 'smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'Hanszy123',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

function fetchFromSupabase(table) {
  return new Promise((resolve, reject) => {
    const url = `${SUPABASE_URL}/rest/v1/${table}?select=*`;
    const options = {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Failed to parse: ' + data.substring(0, 200))); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('Fetching philippine_arena_events from Supabase...');
  const events = await fetchFromSupabase('philippine_arena_events');
  console.log(`Fetched ${events.length} events from Supabase.`);

  // Clear existing (empty) table in AWS
  await pool.query('DELETE FROM philippine_arena_events');

  // Insert each event
  let inserted = 0;
  for (const e of events) {
    // Parse attendance to integer (handle "86,930 (Total)", "TBA", "", "37,000" etc.)
    let attendance = null;
    if (e.attendance) {
      const match = e.attendance.replace(/,/g, '').match(/(\d+)/);
      if (match) attendance = parseInt(match[1], 10);
    }

    // Parse capacity to integer
    let capacity = null;
    if (e.capacity) {
      const capMatch = String(e.capacity).replace(/,/g, '').match(/(\d+)/);
      if (capMatch) capacity = parseInt(capMatch[1], 10);
    }

    await pool.query(
      `INSERT INTO philippine_arena_events (id, title, date_raw, start_date, event_type, attendance, created_at, capacity, venue)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [e.id, e.title, e.date_raw, e.start_date, e.event_type, attendance, e.created_at, capacity, e.venue]
    );
    inserted++;
  }

  console.log(`\n✅ Successfully migrated ${inserted} Philippine Arena events from Supabase → AWS RDS!`);

  // Verify
  const count = await pool.query('SELECT COUNT(*) as c FROM philippine_arena_events');
  console.log(`Verification: ${count.rows[0].c} rows now in AWS philippine_arena_events table.`);

  // Show sample
  const sample = await pool.query('SELECT id, title, start_date, event_type, attendance, venue FROM philippine_arena_events ORDER BY start_date DESC LIMIT 5');
  console.log('\nLatest 5 events:');
  console.table(sample.rows);

  pool.end();
}

main().catch(e => { console.error('Error:', e); pool.end(); });
