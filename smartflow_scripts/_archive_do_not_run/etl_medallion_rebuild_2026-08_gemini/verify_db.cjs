throw new Error("ARCHIVED - do not run. Medallion rebuild and metrics-table setup from a Gemini session (Jul 27 - Aug 1 2026); already applied. Kept only as a record; see smartflow_scripts/README.md.");
const { Pool } = require('pg');
const db = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432, database: 'nlex_capstone', user: 'postgres',
  password: 'REMOVED', ssl: { rejectUnauthorized: false }
});

(async () => {
  const tables = await db.query(
    "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('bronze','silver','gold') ORDER BY table_schema, table_name"
  );
  console.log('=== ALL TABLES IN DATABASE ===');
  tables.rows.forEach(r => console.log('  ' + r.table_schema + '.' + r.table_name));

  console.log('\n=== GOLD LAYER ROW COUNTS (Datamart on AWS) ===');
  const goldTables = ['gold.daily_traffic_volume','gold.daily_incident_summary','gold.incident_details','gold.ml_predictive_volume','gold.ml_model_metrics','gold.daily_emissions_summary','gold.daily_weather_summary'];
  for (const t of goldTables) {
    const r = await db.query('SELECT COUNT(*) as cnt FROM ' + t);
    console.log('  ' + t + ': ' + r.rows[0].cnt + ' rows');
  }

  console.log('\n=== BRONZE/SILVER LAYER (Empty - raw data stays LOCAL) ===');
  const otherTables = ['bronze.nlex_emissions','bronze.hourly_weather','bronze.philippine_arena_events','silver.nlex_emissions_clean','silver.hourly_weather_clean'];
  for (const t of otherTables) {
    const r = await db.query('SELECT COUNT(*) as cnt FROM ' + t);
    console.log('  ' + t + ': ' + r.rows[0].cnt + ' rows');
  }

  await db.end();
  console.log('\n=== VERIFICATION COMPLETE ===');
})();
