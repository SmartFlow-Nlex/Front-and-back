throw new Error("ARCHIVED - do not run. Writes gold.ml_predictive_volume / gold.ml_model_metrics and would overwrite the current results. Superseded by 3_training_testing/traffic_volume/retrain_honest.py. See smartflow_scripts/README.md.");
const { Pool } = require('pg');

const p = new Pool(require("../config/db.cjs").poolConfig);

async function fixPast() {
  await p.connect();
  console.log("Connected. Erasing past predictions...");

  try {
    await p.query(`
      UPDATE gold.ml_predictive_volume
      SET pred_holts_linear = NULL,
          pred_sarimax = NULL
      WHERE is_holdout = false AND is_future = false
    `);
    console.log("Past predictions erased.");
  } catch (e) {
    console.error("Error:", e);
  } finally {
    await p.end();
  }
}

fixPast();
