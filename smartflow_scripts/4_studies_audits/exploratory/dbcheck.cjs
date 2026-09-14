const { Pool } = require('pg');
const p = new Pool(require("../../config/db.cjs").poolConfig);

(async () => {
  const r = await p.query(`
    SELECT forecast_date::date AS d, actual_volume, pred_lstm, pred_prophet,
           pred_holtwinters, pred_sarimax, pred_holts_linear, is_holdout, is_future
    FROM gold.ml_predictive_volume
    WHERE is_holdout = true OR is_future = true
    ORDER BY forecast_date`);
  console.log('rows:', r.rows.length);
  console.table(r.rows);

  const m = await p.query(`SELECT * FROM gold.ml_model_metrics ORDER BY rank`).catch(e => ({rows:[{err:e.message}]}));
  console.log('--- metrics table ---');
  console.table(m.rows);

  const t = await p.query(`
    SELECT table_schema, table_name FROM information_schema.tables
    WHERE table_schema='gold' ORDER BY table_name`);
  console.log('--- gold tables ---');
  console.log(t.rows.map(x => x.table_name).join(', '));
  await p.end();
})();
