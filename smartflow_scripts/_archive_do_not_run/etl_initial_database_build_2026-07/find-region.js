throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
import pg from 'pg';
const { Client } = pg;

const REF = 'cksprtvjsjrsldamlylc';
const PASSWORD = 'REMOVED';

// Try all possible Supabase connection formats
const attempts = [
  // Newer format: ref.pooler.supabase.com
  { host: `${REF}.pooler.supabase.com`, port: 5432, user: `postgres.${REF}`, label: 'ref.pooler (session 5432)' },
  { host: `${REF}.pooler.supabase.com`, port: 6543, user: `postgres.${REF}`, label: 'ref.pooler (transaction 6543)' },
  // Direct
  { host: `db.${REF}.supabase.co`, port: 5432, user: 'postgres', label: 'db.ref.supabase.co (direct)' },
  // Pooler with regions
  { host: `aws-0-ap-southeast-1.pooler.supabase.com`, port: 5432, user: `postgres.${REF}`, label: 'ap-southeast-1 (session)' },
  { host: `aws-0-ap-southeast-1.pooler.supabase.com`, port: 6543, user: `postgres.${REF}`, label: 'ap-southeast-1 (transaction)' },
  { host: `aws-0-us-east-1.pooler.supabase.com`, port: 5432, user: `postgres.${REF}`, label: 'us-east-1 (session)' },
  { host: `aws-0-us-east-1.pooler.supabase.com`, port: 6543, user: `postgres.${REF}`, label: 'us-east-1 (transaction)' },
  { host: `aws-0-ap-northeast-1.pooler.supabase.com`, port: 5432, user: `postgres.${REF}`, label: 'ap-northeast-1 (session)' },
  { host: `aws-0-ap-northeast-1.pooler.supabase.com`, port: 6543, user: `postgres.${REF}`, label: 'ap-northeast-1 (transaction)' },
  // Older format
  { host: `${REF}.supabase.co`, port: 5432, user: 'postgres', label: 'ref.supabase.co:5432' },
  { host: `${REF}.supabase.co`, port: 6543, user: `postgres.${REF}`, label: 'ref.supabase.co:6543' },
];

(async () => {
  console.log('Trying all possible Supabase connection formats...\n');
  for (const attempt of attempts) {
    const client = new Client({
      host: attempt.host,
      port: attempt.port,
      user: attempt.user,
      password: PASSWORD,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
    });

    try {
      await client.connect();
      const res = await client.query('SELECT current_database(), version()');
      console.log(`✅ SUCCESS: ${attempt.label}`);
      console.log(`   Host: ${attempt.host}:${attempt.port}`);
      console.log(`   User: ${attempt.user}`);
      console.log(`   DB: ${res.rows[0].current_database}`);
      await client.end();
      process.exit(0);
    } catch (err) {
      const msg = err.message.substring(0, 100);
      console.log(`❌ ${attempt.label}: ${msg}`);
      try { await client.end(); } catch {}
    }
  }
  console.log('\n❌ All attempts failed.');
})();
