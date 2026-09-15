throw new Error("ARCHIVED - do not run. Medallion rebuild and metrics-table setup from a Gemini session (Jul 27 - Aug 1 2026); already applied. Kept only as a record; see smartflow_scripts/README.md.");
const { Pool } = require("pg");
const fs = require('fs');
const path = require('path');

const db = new Pool({
  connectionString: "postgres://postgres:REMOVED@smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone",
  ssl: { rejectUnauthorized: false },
});

async function main() {
  console.log("Updating gold.ml_model_metrics table schema...");
  await db.query(`
    ALTER TABLE gold.ml_model_metrics
    ADD COLUMN IF NOT EXISTS mse DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS train_r2 DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS val_r2 DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS r2_gap DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS diagnosis TEXT;
  `);
  console.log("Schema updated.");

  // Read JSON files for actual metrics
  const predictiveFolder = "C:\\Users\\Hans\\.gemini\\antigravity\\scratch\\predictive folder\\training_and_testing_outputs\\02_final_evaluation_walkforward\\model_results";
  const files = fs.readdirSync(predictiveFolder).filter(f => f.endsWith('.json'));

  console.log("Inserting/Updating metrics from JSON files...");
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(predictiveFolder, file), 'utf8'));
    const metrics = data.metrics;
    const split = data.split_r2;
    
    // Default ranks based on previous logic (LSTM=1, Prophet=2, etc.)
    let rank = 99;
    let accepted = false;
    let rejected_reason = null;
    
    if (data.model === "LSTM") { rank = 1; accepted = true; }
    else if (data.model === "Prophet") { rank = 2; accepted = true; }
    else if (data.model === "Holt-Winters") { rank = 3; accepted = false; rejected_reason = "MASE > 1.0"; }
    else if (data.model === "SARIMAX") { rank = 4; accepted = false; rejected_reason = "MASE > 1.0"; }
    else if (data.model === "Holts_Linear") { rank = 5; accepted = false; rejected_reason = "MASE > 1.0"; }
    else if (data.model === "XGBoost") { rank = 1; accepted = true; }
    else if (data.model === "Random Forest") { rank = 2; accepted = true; }
    else if (data.model === "Linear Regression") { rank = 3; accepted = true; }

    const model_name = data.model;
    const target = data.target;

    await db.query(`
      INSERT INTO gold.ml_model_metrics 
        (model_name, target, rmse, mae, wmape, r2, mape, smape, mase, rmsse, me, mpe, adjusted_r2, theils_u, mse, train_r2, val_r2, r2_gap, diagnosis, rank, accepted, rejected_reason, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, NOW())
      ON CONFLICT (model_name, target) DO UPDATE SET
        rmse=EXCLUDED.rmse, mae=EXCLUDED.mae, wmape=EXCLUDED.wmape, r2=EXCLUDED.r2,
        mape=EXCLUDED.mape, smape=EXCLUDED.smape, mase=EXCLUDED.mase, rmsse=EXCLUDED.rmsse,
        me=EXCLUDED.me, mpe=EXCLUDED.mpe, adjusted_r2=EXCLUDED.adjusted_r2, theils_u=EXCLUDED.theils_u,
        mse=EXCLUDED.mse, train_r2=EXCLUDED.train_r2, val_r2=EXCLUDED.val_r2, r2_gap=EXCLUDED.r2_gap, diagnosis=EXCLUDED.diagnosis,
        rank=EXCLUDED.rank, accepted=EXCLUDED.accepted, rejected_reason=EXCLUDED.rejected_reason, updated_at=NOW()
    `, [
      model_name, target, 
      metrics.RMSE, metrics.MAE, metrics.WMAPE, metrics.R2,
      metrics.MAPE, metrics.sMAPE, metrics.MASE, metrics.RMSSE,
      metrics.ME, metrics.MPE, metrics.Adjusted_R2, metrics.Theils_U,
      metrics.MSE, split?.avg_train_r2, split?.avg_val_r2, split ? Math.abs(split.avg_train_r2 - split.avg_val_r2) : null, 
      split?.diagnosis,
      rank, accepted, rejected_reason
    ]);
    console.log(`  ✓ ${model_name} (${target}) updated with MSE & Adviser Diagnostics`);
  }

  await db.end();
  console.log("\nDone!");
}

main().catch(e => { console.error(e); process.exit(1); });
