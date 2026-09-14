const { Pool } = require('pg');
const p = new Pool(require("../../config/db.cjs").poolConfig);
const q = (l, sql) => p.query(sql)
  .then(r => { console.log('\n=== ' + l + ' ==='); console.table(r.rows); })
  .catch(e => console.log('\n=== ' + l + ' ===\nERR: ' + e.message));

(async () => {
  // Do actuals exist in bronze for the dates the dashboard calls "Future"?
  await q('actuals available for the "Future" window', `
    SELECT f.forecast_date::date AS forecast_day,
           f.actual_volume AS actual_in_ml_table,
           SUM(b.total_volume)::bigint AS actual_in_bronze,
           f.pred_prophet, f.pred_lstm
    FROM gold.ml_predictive_volume f
    LEFT JOIN bronze.nlex_traffic_volume b ON b.date_day = f.forecast_date::date
    WHERE f.is_future
    GROUP BY 1,2,4,5 ORDER BY 1`);

  // How far past "today" (2026-08-11) does the warehouse actually hold data?
  await q('data beyond today', `
    SELECT COUNT(DISTINCT date_day) AS days_after_2026_08_11,
           MIN(date_day)::date AS first, MAX(date_day)::date AS last
    FROM bronze.nlex_traffic_volume
    WHERE date_day > '2026-08-11'`);

  await p.end();
})();
