throw new Error("ARCHIVED - do not run. Medallion rebuild and metrics-table setup from a Gemini session (Jul 27 - Aug 1 2026); already applied. Kept only as a record; see smartflow_scripts/README.md.");
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const db = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  database: 'nlex_capstone',
  user: 'postgres',
  password: 'REMOVED',
  ssl: { rejectUnauthorized: false },
});

const dir = 'C:/Users/Hans/.gemini/antigravity/scratch/predictive folder/training_and_testing_outputs/02_final_evaluation_walkforward/model_results';

const models = [
  { file: 'wf_sarimax_results.json', name: 'SARIMAX', rank: 3 },
  { file: 'wf_holtwinters_results.json', name: 'HoltWinters', rank: 4 },
  { file: 'wf_holts_linear_results.json', name: 'HoltsLinear', rank: 5 },
];

function fix(v) {
  if (v === 'N/A' || v === 'nan' || v === 'NaN' || v === undefined || v === '') return null;
  return v;
}

async function run() {
  for (const mf of models) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, mf.file), 'utf8'));
    const m = data.metrics || data;
    const sr = data.split_r2 || {};

    await db.query(
      `INSERT INTO gold.ml_model_metrics 
        (model_name, target, rmse, mae, mse, wmape, r2, mase, mape, smape, rmsse,
         me, mpe, adjusted_r2, theils_u, train_r2, val_r2, gap, diagnosis, rank, accepted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        mf.name, 'total_traffic_volume',
        fix(m.RMSE || m.rmse), fix(m.MAE || m.mae), fix(m.MSE || m.mse),
        fix(m.WMAPE || m.wmape), fix(m.R2 || m.r2), fix(m.MASE || m.mase),
        fix(m.MAPE || m.mape), fix(m.sMAPE || m.smape), fix(m.RMSSE || m.rmsse),
        fix(m.ME || m.me), fix(m.MPE || m.mpe), fix(m.Adjusted_R2),
        fix(m.Theils_U || m.theils_u),
        fix(sr.avg_train_r2), fix(sr.avg_val_r2),
        fix(sr.gap || sr.avg_gap), fix(sr.diagnosis),
        mf.rank, true
      ]
    );
    console.log('Inserted', mf.name);
  }

  const rows = await db.query('SELECT model_name, rmse, mae, r2, rank FROM gold.ml_model_metrics ORDER BY rank');
  rows.rows.forEach(r => console.log(`#${r.rank} ${r.model_name}: RMSE=${r.rmse}, MAE=${r.mae}, R²=${r.r2}`));
  
  await db.end();
  console.log('DONE');
}

run().catch(e => { console.error(e.message); process.exit(1); });
