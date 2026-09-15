throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
const pg = require('pg');
const pool = new pg.Pool({
  host: 'smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'REMOVED',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

const sql = `
SELECT
  SUM(CASE WHEN timestamp_utc IS NULL THEN 1 ELSE 0 END) AS timestamp_utc_nulls,
  SUM(CASE WHEN temperature IS NULL THEN 1 ELSE 0 END) AS temperature_nulls,
  SUM(CASE WHEN rainfall IS NULL THEN 1 ELSE 0 END) AS rainfall_nulls,
  SUM(CASE WHEN humidity IS NULL THEN 1 ELSE 0 END) AS humidity_nulls,
  SUM(CASE WHEN wind_speed IS NULL THEN 1 ELSE 0 END) AS wind_speed_nulls,
  SUM(CASE WHEN wind_gusts IS NULL THEN 1 ELSE 0 END) AS wind_gusts_nulls,
  SUM(CASE WHEN dew_point IS NULL THEN 1 ELSE 0 END) AS dew_point_nulls,
  SUM(CASE WHEN surface_pressure IS NULL THEN 1 ELSE 0 END) AS surface_pressure_nulls,
  SUM(CASE WHEN weather_description IS NULL THEN 1 ELSE 0 END) AS weather_desc_nulls,
  SUM(CASE WHEN quality_score IS NULL THEN 1 ELSE 0 END) AS quality_score_nulls,
  SUM(CASE WHEN location_name IS NULL THEN 1 ELSE 0 END) AS location_name_nulls,
  COUNT(*) AS total_rows
FROM hourly_weather
`;

pool.query(sql).then(r => {
  console.log('NULL Value Check for hourly_weather:');
  console.table(r.rows);
  pool.end();
}).catch(console.error);
