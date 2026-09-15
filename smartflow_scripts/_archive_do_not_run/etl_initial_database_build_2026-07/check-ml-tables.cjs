throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
const { Pool } = require('pg');
const p = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432, user: 'postgres', password: 'REMOVED',
  database: 'nlex_capstone', ssl: { rejectUnauthorized: false }
});

(async () => {
  console.log('--- gold.ml_predictive_volume columns ---');
  const c1 = await p.query("SELECT column_name FROM information_schema.columns WHERE table_schema='gold' AND table_name='ml_predictive_volume' ORDER BY ordinal_position");
  c1.rows.forEach(r => console.log('  ', r.column_name));

  console.log('\n--- gold.ml_predictive_congestion ---');
  try { const c2 = await p.query('SELECT COUNT(*) as cnt FROM gold.ml_predictive_congestion'); console.log('  rows:', c2.rows[0].cnt); }
  catch (e) { console.log('  MISSING:', e.message); }

  console.log('\n--- gold.ml_event_surge_forecast ---');
  try { const c3 = await p.query('SELECT COUNT(*) as cnt FROM gold.ml_event_surge_forecast'); console.log('  rows:', c3.rows[0].cnt); }
  catch (e) { console.log('  MISSING:', e.message); }

  console.log('\n--- Sample from ml_predictive_volume ---');
  try { const s = await p.query('SELECT * FROM gold.ml_predictive_volume LIMIT 3'); s.rows.forEach(r => console.log('  ', r)); }
  catch (e) { console.log('  ERROR:', e.message); }

  await p.end();
})();
