const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

const checkNullsQuery = `
  SELECT 
    COUNT(*) as total_rows,
    SUM(CASE WHEN timestamp_utc IS NULL THEN 1 ELSE 0 END) as null_timestamps,
    SUM(CASE WHEN temperature IS NULL THEN 1 ELSE 0 END) as null_temperature,
    SUM(CASE WHEN rainfall IS NULL THEN 1 ELSE 0 END) as null_rainfall,
    SUM(CASE WHEN wind_speed IS NULL THEN 1 ELSE 0 END) as null_wind_speed,
    SUM(CASE WHEN humidity IS NULL THEN 1 ELSE 0 END) as null_humidity
  FROM public.hourly_weather;
`;

pool.query(checkNullsQuery)
  .then(res => { 
      console.log(res.rows[0]); 
      pool.end(); 
  })
  .catch(err => { 
      console.error(err); 
      pool.end(); 
  });
