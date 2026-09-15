const { Pool } = require('pg');

const p = new Pool(require("../config/db.cjs").poolConfig);

async function check() {
  await p.connect();
  const res = await p.query("SELECT * FROM gold.ml_predictive_volume LIMIT 5");
  console.log(res.rows);
  await p.end();
}

check();
