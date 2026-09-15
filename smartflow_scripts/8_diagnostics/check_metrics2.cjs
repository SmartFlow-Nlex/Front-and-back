const { Pool } = require('pg');
const p = new Pool(require("../config/db.cjs").poolConfig);

async function check() {
  await p.connect();
  const res = await p.query(`SELECT model_name, rmse, mae, wmape, r2 FROM gold.ml_model_metrics WHERE target = 'total_traffic_volume'`);
  console.log(res.rows);
  await p.end();
}
check();
