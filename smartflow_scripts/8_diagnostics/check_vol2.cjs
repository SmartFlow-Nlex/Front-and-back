const { Pool } = require('pg');

const p = new Pool(require("../config/db.cjs").poolConfig);

async function check() {
  await p.connect();
  const res = await p.query(`SELECT forecast_date, actual_volume FROM gold.ml_predictive_volume LIMIT 5`);
  console.log(res.rows);
  const res2 = await p.query(`SELECT date, total_volume FROM gold.daily_traffic_volume WHERE date >= '2026-07-01' LIMIT 5`);
  console.log(res2.rows);
  await p.end();
}

check();
