throw new Error("ARCHIVED - do not run. Medallion rebuild and metrics-table setup from a Gemini session (Jul 27 - Aug 1 2026); already applied. Kept only as a record; see smartflow_scripts/README.md.");
/**
 * Ingest ML predictions and model metrics into AWS Gold Layer.
 * 
 * Sources:
 *   - aws_live_predictions.csv  → gold.ml_predictive_volume
 *   - wf_*_results.json files   → gold.ml_model_metrics
 */
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
  connectionTimeoutMillis: 15000,
});

const PREDICTIONS_CSV = 'C:/Users/Hans/.gemini/antigravity/scratch/predictive folder/training_and_testing_outputs/04_aws_live_predictions/aws_live_predictions.csv';
const METRICS_DIR = 'C:/Users/Hans/.gemini/antigravity/scratch/predictive folder/training_and_testing_outputs/02_final_evaluation_walkforward/model_results';

async function run() {
  const client = await db.connect();
  try {
    console.log('=== Ingesting ML Predictions & Metrics into Gold Layer ===\n');

    // ─────────────────────────────────────
    // 1. Ingest ML Predictions
    // ─────────────────────────────────────
    console.log('1) Ingesting ML predictions from aws_live_predictions.csv...');
    
    // Clear existing predictions
    await client.query('DELETE FROM gold.ml_predictive_volume');
    
    const raw = fs.readFileSync(PREDICTIONS_CSV, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    const headers = lines[0].split(',').map(h => h.trim());
    console.log(`   Headers: ${headers.join(', ')}`);
    console.log(`   Data rows: ${lines.length - 1}`);

    // Parse the wide-format CSV into individual model rows
    const modelColumns = {
      'pred_lstm': 'LSTM',
      'pred_prophet': 'Prophet', 
      'pred_xgboost': 'XGBoost',
      'pred_holtwinters': 'HoltWinters',
      'pred_sarimax': 'SARIMAX',
      'pred_holts_linear': 'HoltsLinear',
    };

    let insertCount = 0;
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',');
      const row = {};
      headers.forEach((h, idx) => row[h] = vals[idx] ? vals[idx].trim() : '');

      const date = row.forecast_date;
      const actual = row.actual_volume && row.actual_volume !== '' ? parseFloat(row.actual_volume) : null;
      const isHoldout = row.is_holdout === 'True';
      const isFuture = row.is_future === 'True';
      
      let dataSplit = 'historical';
      if (isFuture) dataSplit = 'prediction';
      else if (isHoldout) dataSplit = 'test';

      for (const [col, modelName] of Object.entries(modelColumns)) {
        const pred = row[col] && row[col] !== '' ? parseFloat(row[col]) : null;
        if (pred === null && actual === null) continue;

        await client.query(`
          INSERT INTO gold.ml_predictive_volume (date, model_name, target, predicted_value, actual_value, data_split)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [date, modelName, 'total_traffic_volume', pred, actual, dataSplit]);
        insertCount++;
      }
    }
    console.log(`   ✅ ML predictions: ${insertCount} records ingested.\n`);

    // ─────────────────────────────────────
    // 2. Ingest ML Model Metrics
    // ─────────────────────────────────────
    console.log('2) Ingesting ML model metrics from JSON files...');
    
    // Clear existing metrics
    await client.query('DELETE FROM gold.ml_model_metrics');

    const metricFiles = [
      { file: 'wf_lstm_results.json', name: 'LSTM', rank: 1, accepted: true },
      { file: 'wf_prophet_results.json', name: 'Prophet', rank: 2, accepted: true },
      { file: 'wf_sarimax_results.json', name: 'SARIMAX', rank: 3, accepted: true },
      { file: 'wf_holtwinters_results.json', name: 'HoltWinters', rank: 4, accepted: true },
      { file: 'wf_holts_linear_results.json', name: 'HoltsLinear', rank: 5, accepted: true },
    ];

    for (const mf of metricFiles) {
      const filePath = path.join(METRICS_DIR, mf.file);
      if (!fs.existsSync(filePath)) {
        console.log(`   ⚠️  Skipped ${mf.file} (not found)`);
        continue;
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const m = data.metrics || data;

      await client.query(`
        INSERT INTO gold.ml_model_metrics 
          (model_name, target, rmse, mae, mse, wmape, r2, mase, mape, smape, rmsse, 
           me, mpe, adjusted_r2, theils_u, train_r2, val_r2, gap, diagnosis, rank, accepted)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      `, [
        mf.name,
        'total_traffic_volume',
        m.RMSE || m.rmse || null,
        m.MAE || m.mae || null,
        m.MSE || m.mse || null,
        m.WMAPE || m.wmape || null,
        m.R2 || m.r2 || null,
        m.MASE || m.mase || null,
        m.MAPE || m.mape || null,
        m.sMAPE || m.smape || null,
        m.RMSSE || m.rmsse || null,
        m.ME || m.me || null,
        m.MPE || m.mpe || null,
        m.Adjusted_R2 || m.adjusted_r2 || null,
        m.Theils_U || m.theils_u || null,
        m.Train_R2 || m.train_r2 || (data.split_r2 ? data.split_r2.train : null),
        m.Val_R2 || m.val_r2 || (data.split_r2 ? data.split_r2.val : null),
        m.Gap || m.gap || (data.split_r2 ? data.split_r2.gap : null),
        m.Diagnosis || m.diagnosis || (data.split_r2 ? data.split_r2.diagnosis : null),
        mf.rank,
        mf.accepted,
      ]);
      console.log(`   ✅ ${mf.name}: RMSE=${m.RMSE||m.rmse}, MAE=${m.MAE||m.mae}, R²=${m.R2||m.r2}`);
    }

    // ─────────────────────────────────────
    // 3. Verify
    // ─────────────────────────────────────
    console.log('\n3) Verifying...');
    const predCount = await client.query('SELECT model_name, COUNT(*) as cnt FROM gold.ml_predictive_volume GROUP BY model_name ORDER BY model_name');
    console.log('   Predictions by model:');
    predCount.rows.forEach(r => console.log(`     ${r.model_name}: ${r.cnt} rows`));

    const metricsCount = await client.query('SELECT model_name, rmse, mae, r2, rank FROM gold.ml_model_metrics ORDER BY rank');
    console.log('   Model metrics:');
    metricsCount.rows.forEach(r => console.log(`     #${r.rank} ${r.model_name}: RMSE=${r.rmse}, MAE=${r.mae}, R²=${r.r2}`));

    console.log('\n=== ✅ ML DATA INGESTION COMPLETE ===');

  } finally {
    client.release();
    await db.end();
  }
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
