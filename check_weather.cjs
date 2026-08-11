const { Pool } = require('pg');
const p = new Pool({
  connectionString: 'postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  // gold.daily_weather_summary is empty. Let's aggregate from public.hourly_weather directly.
  const range = await p.query(`
    SELECT 
      MIN(timestamp_utc::date) as earliest, 
      MAX(timestamp_utc::date) as latest, 
      COUNT(DISTINCT timestamp_utc::date) as total_days
    FROM public.hourly_weather
  `);
  console.log("=== hourly_weather date range ===");
  console.log(range.rows[0]);

  // Sample daily aggregate
  const sample = await p.query(`
    SELECT 
      timestamp_utc::date as date,
      AVG(temperature) as avg_temp,
      SUM(rainfall) as total_rain,
      AVG(wind_speed) as avg_wind,
      AVG(humidity) as avg_humidity,
      COUNT(*) as hourly_records
    FROM public.hourly_weather
    WHERE timestamp_utc::date >= '2026-06-25'
    GROUP BY timestamp_utc::date
    ORDER BY date DESC
    LIMIT 10
  `);
  console.log("\n=== Sample daily aggregates (latest days) ===");
  console.log(sample.rows);

  // Check traffic range overlap
  const overlap = await p.query(`
    SELECT COUNT(DISTINCT t.date) as overlap_days
    FROM gold.daily_traffic_volume t
    JOIN (
      SELECT DISTINCT timestamp_utc::date as date 
      FROM public.hourly_weather
    ) w ON t.date = w.date
  `);
  console.log("\n=== OVERLAP (traffic days with weather) ===");
  console.log(overlap.rows[0]);

  await p.end();
}
main().catch(e => { console.error(e); p.end(); });
