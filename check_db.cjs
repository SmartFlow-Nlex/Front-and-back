const { Pool } = require('pg');

const p = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'Hanszy123!',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function check() {
  await p.connect();
  const res = await p.query("SELECT * FROM gold.ml_predictive_volume LIMIT 5");
  console.log(res.rows);
  await p.end();
}

check();
