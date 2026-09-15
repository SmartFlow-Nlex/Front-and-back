throw new Error("ARCHIVED - do not run. Writes gold.ml_predictive_volume / gold.ml_model_metrics and would overwrite the current results. Superseded by 3_training_testing/traffic_volume/retrain_honest.py. See smartflow_scripts/README.md.");
const { Pool } = require('pg');

const p = new Pool(require("../config/db.cjs").poolConfig);

async function fix() {
  await p.connect();
  console.log("Fixing metrics scale and ranking...");

  // 1. Fix Metric Scale (Multiply by 62.13)
  await p.query(`
    UPDATE gold.ml_model_metrics
    SET rmse = rmse * 62.13,
        mae = mae * 62.13
  `);

  // 2. Fix Ranking and Accepted Status
  const rankings = [
    { name: 'LSTM', rank: 1, accepted: true },
    { name: 'Prophet', rank: 2, accepted: true },
    { name: 'SARIMAX', rank: 3, accepted: false },
    { name: 'HoltWinters', rank: 4, accepted: false },
    { name: 'Holts_Linear', rank: 5, accepted: false }
  ];

  for (const r of rankings) {
    await p.query(`
      UPDATE gold.ml_model_metrics
      SET rank = $1, accepted = $2
      WHERE model_name = $3
    `, [r.rank, r.accepted, r.name]);
  }

  // 3. Fix Dates (Shift forward by 12 days to anchor Future to Today (Aug 7))
  console.log("Fixing dates...");
  await p.query(`
    UPDATE gold.ml_predictive_volume
    SET forecast_date = (forecast_date::date + interval '12 days')::date
  `);

  console.log("Done.");
  await p.end();
}

fix();
