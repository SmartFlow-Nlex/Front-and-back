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
  console.log('1. Creating Gold Data Mart Tables...');

  // Gold Table: gold.daily_traffic_summary
  await pool.query('DROP TABLE IF EXISTS gold.daily_traffic_summary CASCADE;');
  await pool.query(`
    CREATE TABLE gold.daily_traffic_summary AS
    SELECT 
      date,
      toll_plaza,
      direction,
      vehicle_class,
      SUM(volume) as total_daily_volume,
      MAX(volume) as peak_volume,
      ROUND(AVG(volume), 2) as avg_hourly_volume
    FROM silver.traffic_volume
    GROUP BY date, toll_plaza, direction, vehicle_class;
  `);

  // Gold Table: gold.incident_analytics
  await pool.query('DROP TABLE IF EXISTS gold.incident_analytics CASCADE;');
  await pool.query(`
    CREATE TABLE gold.incident_analytics AS
    SELECT 
      date_trunc('month', incident_date)::date as month,
      incident_type,
      location,
      COUNT(*) as total_incidents
    FROM silver.road_incidents
    GROUP BY 1, 2, 3;
  `);

  // Gold Table: gold.aqi_daily_summary
  await pool.query('DROP TABLE IF EXISTS gold.aqi_daily_summary CASCADE;');
  await pool.query(`
    CREATE TABLE gold.aqi_daily_summary AS
    SELECT 
      e.created_at::date as date,
      x.name as exit_name,
      ROUND(AVG(e.aqi), 2) as avg_aqi,
      MAX(e.aqi) as max_aqi,
      ROUND(AVG(e.pm2_5)::numeric, 2) as avg_pm25,
      ROUND(AVG(e.co)::numeric, 2) as avg_co
    FROM silver.emissions e
    JOIN bronze.exits x ON e.exit_id = x.id
    GROUP BY e.created_at::date, x.name;
  `);

  console.log('✅ Gold layer tables created.');

  console.log('2. Creating Backward Compatibility Public Views...');

  // We need to recreate the original views in public schema so existing APIs don't break
  const views = {
    'nlex_traffic_volume': 'bronze.traffic_volume',
    'nlex_road_crashes': 'bronze.road_crashes',
    'nlex_motorcycle_crashes': 'bronze.motorcycle_crashes',
    'nlex_stalled_vehicles': 'bronze.stalled_vehicles',
    'nlex_apprehensions': 'bronze.apprehensions',
    'hourly_weather': 'bronze.hourly_weather',
    'nlex_emissions': 'bronze.emissions',
    'nlex_theoretical_emissions': 'bronze.theoretical_emissions',
    'nlex_emission_factors': 'bronze.emission_factors',
    'nlex_exits': 'bronze.exits',
    'philippine_arena_events': 'bronze.philippine_arena_events',
    'source_scores': 'bronze.source_scores',
    'fact_hourly_alerts': 'bronze.waze_hourly_alerts',
    'fact_hourly_jams': 'bronze.waze_hourly_jams',
    'fact_hourly_irregularities': 'bronze.waze_hourly_irregularities',
    'dim_time': 'dim.dim_time',
    'dim_weather': 'dim.dim_weather',
    'dim_incident_type': 'dim.dim_incident_type',
    'dim_location': 'dim.dim_location'
  };

  for (const [publicName, newTarget] of Object.entries(views)) {
    await pool.query(`DROP VIEW IF EXISTS public.${publicName} CASCADE;`);
    await pool.query(`CREATE VIEW public.${publicName} AS SELECT * FROM ${newTarget};`);
    console.log(`  ✅ Mapped public.${publicName} -> ${newTarget}`);
  }

  console.log('\n✅ Medallion Architecture Migration is complete!');
  pool.end();
}

main().catch(e => { console.error('Error:', e); pool.end(); });
