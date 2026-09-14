throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
const { Pool } = require('pg');
const pool = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'REMOVED',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  // Get exact counts for tables showing -1 or 0
  const tables = [
    'bronze.hourly_weather',
    'bronze.nlex_emission_factors',
    'bronze.nlex_exits',
    'bronze.philippine_arena_events',
    'bronze.waze_raw_alerts',
    'bronze.waze_raw_jams',
    'bronze.weather_cells',
    'gold.daily_emissions_summary',
    'gold.daily_weather_summary',
    'gold.ml_model_metrics',
    'gold.ml_predictive_volume',
    'silver.dim_incident_type',
    'silver.dim_location',
    'silver.fact_incident_log',
    'silver.hourly_weather_clean',
    'silver.nlex_emissions_clean',
    'silver.philippine_arena_events_clean',
    'public.ml_daily_actuals',
    'public.ml_predictive_incidents',
    'public.ml_training_metadata',
  ];

  console.log('\n=== EXACT ROW COUNTS FOR QUESTIONABLE TABLES ===\n');
  for (const t of tables) {
    try {
      const res = await pool.query(`SELECT COUNT(*) as cnt FROM ${t}`);
      console.log(`  ${t}: ${Number(res.rows[0].cnt).toLocaleString()} rows`);
    } catch(e) {
      console.log(`  ${t}: ERROR - ${e.message}`);
    }
  }

  await pool.end();
}
main();
