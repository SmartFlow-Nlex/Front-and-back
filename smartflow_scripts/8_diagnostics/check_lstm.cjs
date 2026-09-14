const { Pool } = require('pg');
const p = new Pool(require("../config/db.cjs").poolConfig);

async function main() {
  const r = await p.query(`
    SELECT forecast_date, actual_volume, pred_lstm, pred_prophet, is_holdout, is_future 
    FROM gold.ml_predictive_volume 
    WHERE forecast_date >= '2026-07-20' 
    ORDER BY forecast_date
  `);
  console.table(r.rows);
  await p.end();
}
main();
