const { Pool } = require('pg');
const p = new Pool(require("../config/db.cjs").poolConfig);
async function check() {
  await p.connect();
  const res = await p.query(`SELECT model_name, rmse, mae, r2 FROM gold.ml_model_metrics`);
  console.log(res.rows);
  await p.end();
}
check();
