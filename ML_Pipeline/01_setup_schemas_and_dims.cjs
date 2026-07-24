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
  console.log('1. Creating Schemas...');
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS bronze;
    CREATE SCHEMA IF NOT EXISTS silver;
    CREATE SCHEMA IF NOT EXISTS gold;
    CREATE SCHEMA IF NOT EXISTS dim;
  `);

  console.log('2. Populating dim_time...');
  // We recreate dim_time to ensure it has the correct columns
  await pool.query('DROP TABLE IF EXISTS dim_time CASCADE;');
  await pool.query(`
    CREATE TABLE dim_time (
      time_id SERIAL PRIMARY KEY,
      date_day DATE NOT NULL,
      hour_of_day INTEGER NOT NULL,
      day_of_week VARCHAR(10),
      is_weekend BOOLEAN,
      month_name VARCHAR(15),
      quarter VARCHAR(2),
      is_rush_hour BOOLEAN,
      UNIQUE(date_day, hour_of_day)
    );
  `);

  // Insert 5 years of time data (2022-01-01 to 2026-12-31)
  await pool.query(`
    INSERT INTO dim_time (date_day, hour_of_day, day_of_week, is_weekend, month_name, quarter, is_rush_hour)
    SELECT
      d.date_day,
      h.hour_of_day,
      trim(to_char(d.date_day, 'Day')) as day_of_week,
      extract(dow from d.date_day) IN (0, 6) as is_weekend,
      trim(to_char(d.date_day, 'Month')) as month_name,
      'Q' || to_char(d.date_day, 'Q') as quarter,
      h.hour_of_day IN (7, 8, 9, 17, 18, 19) as is_rush_hour
    FROM
      (SELECT date::date as date_day FROM generate_series('2022-01-01'::date, '2026-12-31'::date, '1 day'::interval) date) d
    CROSS JOIN
      (SELECT generate_series(0, 23) as hour_of_day) h
    ON CONFLICT DO NOTHING;
  `);
  const dimTimeCount = await pool.query('SELECT COUNT(*) as c FROM dim_time');
  console.log(`   -> Created ${dimTimeCount.rows[0].c} rows in dim_time`);

  console.log('3. Populating dim_weather...');
  // Recreate dim_weather
  await pool.query('DROP TABLE IF EXISTS dim_weather CASCADE;');
  await pool.query(`
    CREATE TABLE dim_weather (
      weather_id SERIAL PRIMARY KEY,
      weather_description VARCHAR(100) UNIQUE,
      is_rainy BOOLEAN,
      severity_level INTEGER
    );
  `);

  // Extract distinct weather from hourly_weather
  await pool.query(`
    INSERT INTO dim_weather (weather_description, is_rainy, severity_level)
    SELECT DISTINCT 
      weather_description,
      CASE 
        WHEN weather_description ILIKE '%rain%' OR weather_description ILIKE '%drizzle%' OR weather_description ILIKE '%storm%' THEN true
        ELSE false
      END as is_rainy,
      CASE
        WHEN weather_description ILIKE '%heavy rain%' OR weather_description ILIKE '%storm%' THEN 3
        WHEN weather_description ILIKE '%moderate rain%' THEN 2
        WHEN weather_description ILIKE '%light rain%' OR weather_description ILIKE '%drizzle%' THEN 1
        ELSE 0
      END as severity_level
    FROM hourly_weather
    WHERE weather_description IS NOT NULL
    ON CONFLICT (weather_description) DO NOTHING;
  `);
  const dimWeatherCount = await pool.query('SELECT COUNT(*) as c FROM dim_weather');
  console.log(`   -> Created ${dimWeatherCount.rows[0].c} rows in dim_weather`);

  console.log('\n✅ Schemas created and Dimensions populated successfully.');
  pool.end();
}

main().catch(e => { console.error('Error:', e); pool.end(); });
