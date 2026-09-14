const { Pool } = require('pg');
const p = new Pool(require("../../config/db.cjs").poolConfig);

(async () => {
  // How many distinct weather values, and how much of the table is the constant?
  const a = await p.query(`
    SELECT weather_rainfall::text AS rain, COUNT(*) AS n,
           MIN(forecast_date)::date AS first, MAX(forecast_date)::date AS last
    FROM gold.ml_predictive_volume
    GROUP BY 1 ORDER BY n DESC LIMIT 6`);
  console.log('--- most common rainfall values ---');
  console.table(a.rows);

  const b = await p.query(`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE weather_rainfall IS NULL) AS rain_null,
           COUNT(DISTINCT weather_rainfall) AS distinct_rain,
           MIN(forecast_date)::date AS first, MAX(forecast_date)::date AS last,
           COUNT(*) FILTER (WHERE is_holdout) AS holdout,
           COUNT(*) FILTER (WHERE is_future) AS future,
           COUNT(pred_xgboost) AS xgb_filled
    FROM gold.ml_predictive_volume`);
  console.log('--- table shape ---');
  console.table(b.rows);

  // Weather variability inside the holdout window specifically
  const c = await p.query(`
    SELECT COUNT(DISTINCT weather_rainfall) AS distinct_rain_in_eval,
           COUNT(DISTINCT weather_temp) AS distinct_temp_in_eval
    FROM gold.ml_predictive_volume WHERE is_holdout OR is_future`);
  console.table(c.rows);

  // Real observed daily rainfall, for comparison with the imputed 324.72
  const d = await p.query(`
    SELECT ROUND(AVG(r)::numeric,2) AS mean_daily, ROUND(MIN(r)::numeric,2) AS min,
           ROUND(MAX(r)::numeric,2) AS max, COUNT(*) AS days
    FROM (SELECT (timestamp_utc + interval '8 hours')::date AS d, SUM(rainfall) AS r
          FROM hourly_weather GROUP BY 1) s`).catch(e => ({rows:[{err:e.message}]}));
  console.log('--- observed daily rainfall (hourly_weather) ---');
  console.table(d.rows);
  await p.end();
})();
