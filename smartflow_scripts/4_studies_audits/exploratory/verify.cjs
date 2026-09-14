const { Pool } = require('pg');
const p = new Pool(require("../../config/db.cjs").poolConfig);

const q = (label, sql) => p.query(sql)
  .then(r => { console.log('\n=== ' + label + ' ==='); console.table(r.rows); })
  .catch(e => console.log('\n=== ' + label + ' ===\nERR: ' + e.message));

(async () => {
  // 1. Does the training scope claim of "2,398 days, 2020-01-01 to 2026-07-25" hold?
  await q('training scope: daily_traffic_volume', `
    SELECT COUNT(*) AS rows, COUNT(DISTINCT date_day) AS distinct_days,
           MIN(date_day) AS first_day, MAX(date_day) AS last_day
    FROM gold.daily_traffic_volume`);

  await q('training scope: bronze.nlex_traffic_volume', `
    SELECT COUNT(DISTINCT date_day) AS distinct_days,
           MIN(date_day) AS first_day, MAX(date_day) AS last_day
    FROM bronze.nlex_traffic_volume`);

  // 2. Recompute the weather correlations straight from the warehouse
  await q('recomputed correlations (daily, joined)', `
    WITH v AS (
      SELECT date_day AS d, SUM(total_volume)::float AS vol
      FROM bronze.nlex_traffic_volume GROUP BY 1
    ), w AS (
      SELECT (timestamp_utc + interval '8 hours')::date AS d,
             SUM(rainfall)::float AS rain,
             AVG(temperature)::float AS temp
      FROM hourly_weather GROUP BY 1
    )
    SELECT COUNT(*) AS n_days,
           ROUND(CORR(v.vol, w.rain)::numeric, 4) AS pearson_rain_vs_volume,
           ROUND(CORR(v.vol, w.temp)::numeric, 4) AS pearson_temp_vs_volume
    FROM v JOIN w USING (d)`);

  // 3. Recompute the dry / wet / heavy-rain group means the summary reports
  await q('recomputed weather shock impact', `
    WITH v AS (
      SELECT date_day AS d, SUM(total_volume)::float AS vol
      FROM bronze.nlex_traffic_volume GROUP BY 1
    ), w AS (
      SELECT (timestamp_utc + interval '8 hours')::date AS d, SUM(rainfall)::float AS rain
      FROM hourly_weather GROUP BY 1
    )
    SELECT CASE WHEN w.rain <= 0.3 THEN '1_dry'
                WHEN w.rain < 134  THEN '2_wet'
                ELSE '3_heavy' END AS bucket,
           COUNT(*) AS days,
           ROUND(AVG(v.vol)::numeric, 0) AS avg_volume
    FROM v JOIN w USING (d) GROUP BY 1 ORDER BY 1`);

  // 4. Confound check: are heavy-rain days skewed toward particular weekdays?
  await q('heavy-rain weekday confound', `
    WITH w AS (
      SELECT (timestamp_utc + interval '8 hours')::date AS d, SUM(rainfall)::float AS rain
      FROM hourly_weather GROUP BY 1
    )
    SELECT EXTRACT(dow FROM d)::int AS dow,
           COUNT(*) FILTER (WHERE rain >= 134) AS heavy_days,
           COUNT(*) AS total_days,
           ROUND(100.0 * COUNT(*) FILTER (WHERE rain >= 134) / COUNT(*), 1) AS pct_heavy
    FROM w GROUP BY 1 ORDER BY 1`);

  await p.end();
})();
