const { Pool } = require('pg');

const p = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'Hanszy123!',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

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
