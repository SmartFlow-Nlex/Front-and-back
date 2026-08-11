const { Pool } = require('pg');

const p = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'Hanszy123!',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function calcRatio() {
  await p.connect();
  
  // Get average of descriptive
  const res1 = await p.query(`
    SELECT avg(total_volume) as avg_desc 
    FROM gold.daily_traffic_volume 
  `);
  
  // Get average of predictive (only where actual_volume is not null)
  const res2 = await p.query(`
    SELECT avg(actual_volume) as avg_pred 
    FROM gold.ml_predictive_volume 
  `);
  
  const avgDesc = parseFloat(res1.rows[0].avg_desc);
  const avgPred = parseFloat(res2.rows[0].avg_pred);
  const ratio = avgDesc / avgPred;
  
  console.log({ avgDesc, avgPred, ratio });
  
  // Let's also check current metrics to see what they are scaled to
  const res3 = await p.query(`
    SELECT model_name, mae, rmse FROM gold.ml_model_metrics WHERE model_name = 'LSTM'
  `);
  console.log("Current LSTM Metrics:", res3.rows[0]);

  await p.end();
}

calcRatio();
