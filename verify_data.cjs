const {Pool}=require('pg'); 
const p=new Pool({
  host:'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port:5432,
  user:'postgres',
  password:'Hanszy123!',
  database:'nlex_capstone',
  ssl:{rejectUnauthorized:false}
}); 
(async()=>{ 
  console.log('--- Verifying Actual Volume ---');
  const actual = await p.query(`SELECT date_day, SUM(total_volume) as day_total FROM bronze.nlex_traffic_volume WHERE date_day BETWEEN '2026-08-01' AND '2026-08-14' GROUP BY date_day ORDER BY date_day`); 
  console.log(actual.rows);

  console.log('--- Verifying ML Predictive Volume ---');
  const ml = await p.query(`SELECT forecast_date, actual_volume, pred_lstm FROM gold.ml_predictive_volume WHERE forecast_date BETWEEN '2026-08-01' AND '2026-08-14' ORDER BY forecast_date`);
  console.log(ml.rows);

  console.log('--- Verifying ML Metrics ---');
  const metrics = await p.query(`SELECT model_name, rmse, r2 FROM gold.ml_model_metrics WHERE target = 'volume' ORDER BY rank LIMIT 3`);
  console.log(metrics.rows);

  await p.end();
})();
