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
  console.log('Creating Silver Views...');

  // 1. Traffic Volume (Unpivot)
  await pool.query('DROP VIEW IF EXISTS silver.traffic_volume CASCADE;');
  await pool.query(`
    CREATE VIEW silver.traffic_volume AS
    SELECT 
      date,
      direction,
      type,
      toll_plaza,
      vehicle_class,
      hour_of_day,
      volume
    FROM bronze.traffic_volume
    CROSS JOIN LATERAL (
      VALUES 
        (0, h00), (1, h01), (2, h02), (3, h03), (4, h04), (5, h05),
        (6, h06), (7, h07), (8, h08), (9, h09), (10, h10), (11, h11),
        (12, h12), (13, h13), (14, h14), (15, h15), (16, h16), (17, h17),
        (18, h18), (19, h19), (20, h20), (21, h21), (22, h22), (23, h23)
    ) AS unpivoted(hour_of_day, volume)
    WHERE volume IS NOT NULL AND volume > 0;
  `);

  // 2. Road Incidents (Union of crashes and stalled)
  // Need to parse times carefully. Often they are just '14:30'
  await pool.query('DROP VIEW IF EXISTS silver.road_incidents CASCADE;');
  await pool.query(`
    CREATE VIEW silver.road_incidents AS
    SELECT 
      'road_crash' as incident_type,
      date::date as incident_date,
      reported_time::time as reported_time,
      location,
      NULLIF(weather_condition, '') as weather_condition
    FROM bronze.road_crashes
    WHERE date IS NOT NULL AND date != ''
    UNION ALL
    SELECT 
      'motorcycle_crash' as incident_type,
      date::date as incident_date,
      reported_time::time as reported_time,
      location,
      NULLIF(weather_condition, '') as weather_condition
    FROM bronze.motorcycle_crashes
    WHERE date IS NOT NULL AND date != ''
    UNION ALL
    SELECT 
      'stalled_vehicle' as incident_type,
      date::date as incident_date,
      reported_time::time as reported_time,
      location,
      NULL as weather_condition
    FROM bronze.stalled_vehicles
    WHERE date IS NOT NULL AND date != '';
  `);

  // 3. Waze Hourly Views
  await pool.query('DROP VIEW IF EXISTS silver.waze_hourly_jams CASCADE;');
  await pool.query(`
    CREATE VIEW silver.waze_hourly_jams AS
    SELECT * FROM bronze.waze_hourly_jams;
  `);

  await pool.query('DROP VIEW IF EXISTS silver.waze_hourly_alerts CASCADE;');
  await pool.query(`
    CREATE VIEW silver.waze_hourly_alerts AS
    SELECT * FROM bronze.waze_hourly_alerts;
  `);

  await pool.query('DROP VIEW IF EXISTS silver.waze_hourly_irregularities CASCADE;');
  await pool.query(`
    CREATE VIEW silver.waze_hourly_irregularities AS
    SELECT * FROM bronze.waze_hourly_irregularities;
  `);

  // 4. Weather View
  await pool.query('DROP VIEW IF EXISTS silver.hourly_weather CASCADE;');
  await pool.query(`
    CREATE VIEW silver.hourly_weather AS
    SELECT 
      timestamp_utc,
      location_name,
      temperature,
      rainfall,
      wind_speed,
      humidity,
      weather_description,
      quality_score
    FROM bronze.hourly_weather
    WHERE validation_status = 'VALIDATED' OR quality_score > 80;
  `);

  // 5. Apprehensions
  await pool.query('DROP VIEW IF EXISTS silver.apprehensions CASCADE;');
  await pool.query(`
    CREATE VIEW silver.apprehensions AS
    SELECT 
      date::date as apprehension_date,
      time::time as apprehension_time,
      vehicle_model,
      driver_gender,
      trim(upper(violation)) as violation_type
    FROM bronze.apprehensions
    WHERE date IS NOT NULL AND date != '';
  `);

  console.log('✅ Silver views created successfully.');
  pool.end();
}

main().catch(e => { console.error('Error:', e); pool.end(); });
