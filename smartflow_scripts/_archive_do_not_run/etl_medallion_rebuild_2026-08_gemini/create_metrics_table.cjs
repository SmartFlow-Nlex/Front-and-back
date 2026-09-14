throw new Error("ARCHIVED - do not run. Medallion rebuild and metrics-table setup from a Gemini session (Jul 27 - Aug 1 2026); already applied. Kept only as a record; see smartflow_scripts/README.md.");
const { Pool } = require("pg");

const db = new Pool({
  connectionString: "postgres://postgres:REMOVED@smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone",
  ssl: { rejectUnauthorized: false },
});

async function main() {
  console.log("Creating gold.ml_model_metrics table...");
  await db.query(`
    CREATE TABLE IF NOT EXISTS gold.ml_model_metrics (
      id SERIAL PRIMARY KEY,
      model_name TEXT NOT NULL,
      target TEXT NOT NULL,
      rmse DOUBLE PRECISION,
      mae DOUBLE PRECISION,
      wmape DOUBLE PRECISION,
      r2 DOUBLE PRECISION,
      mape DOUBLE PRECISION,
      smape DOUBLE PRECISION,
      mase DOUBLE PRECISION,
      rmsse DOUBLE PRECISION,
      me DOUBLE PRECISION,
      mpe DOUBLE PRECISION,
      adjusted_r2 TEXT,
      theils_u DOUBLE PRECISION,
      aic DOUBLE PRECISION,
      bic DOUBLE PRECISION,
      rank INT,
      accepted BOOLEAN DEFAULT false,
      rejected_reason TEXT,
      validation_method TEXT DEFAULT '3-fold walk-forward',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(model_name, target)
    )
  `);
  console.log("Table created.");

  // Latest metrics from the JSON result files in predictive folder
  const metrics = [
    {
      model_name: "LSTM", target: "total_volume",
      rmse: 6317.9592, mae: 4423.7506, wmape: 6.7642, r2: 0.9734,
      mape: 8.7892, smape: 8.9247, mase: 0.3730, rmsse: 0.4202,
      me: 559.8272, mpe: 0.2227, adjusted_r2: "0.9733", theils_u: 0.3412,
      rank: 1, accepted: true, rejected_reason: null
    },
    {
      model_name: "Prophet", target: "total_volume",
      rmse: 15909.7606, mae: 11666.7564, wmape: 17.9641, r2: 0.8284,
      mape: 22.5411, smape: 24.1394, mase: 0.9837, rmsse: 1.0580,
      me: 23.2219, mpe: -1.7532, adjusted_r2: "0.8282", theils_u: 0.8614,
      rank: 2, accepted: true, rejected_reason: null
    },
    {
      model_name: "Holt-Winters", target: "total_volume",
      rmse: 70704.4271, mae: 62589.3449, wmape: 94.7010, r2: -3.5637,
      mape: 152.6955, smape: 87.3882, mase: 4.3633, rmsse: 4.0122,
      me: -37531.3473, mpe: -108.089, adjusted_r2: "N/A", theils_u: 3.7916,
      rank: 3, accepted: false, rejected_reason: "MASE > 1.0 (worse than naive baseline)"
    },
    {
      model_name: "SARIMAX", target: "total_volume",
      rmse: 130329.1429, mae: 112243.9700, wmape: 168.8073, r2: -12.4108,
      mape: 260.8448, smape: 118.5471, mase: 7.7914, rmsse: 7.3754,
      me: -79865.1646, mpe: -206.5183, adjusted_r2: "N/A", theils_u: 6.9373,
      rank: 4, accepted: false, rejected_reason: "MASE > 1.0 (worse than naive baseline)"
    },
    {
      model_name: "Holts_Linear", target: "total_volume",
      rmse: 16027577.9803, mae: 13882240.2252, wmape: 22512.9675, r2: -566627.4778,
      mape: 36715.1317, smape: 199.2870, mase: 891.2514, rmsse: 839.6711,
      me: -13792299.3792, mpe: -36581.904, adjusted_r2: "N/A", theils_u: 915.4972,
      rank: 5, accepted: false, rejected_reason: "MASE > 1.0 (worse than naive baseline)"
    },
    {
      model_name: "XGBoost", target: "avg_speed_kmh",
      rmse: 2.4962, mae: 1.8219, wmape: 21.5768, r2: 0.0998,
      mape: 22.3896, smape: 20.5145, mase: 0.7122, rmsse: 0.6557,
      me: null, mpe: null, adjusted_r2: "0.0941", theils_u: null,
      rank: 1, accepted: true, rejected_reason: null
    },
    {
      model_name: "Random Forest", target: "avg_speed_kmh",
      rmse: 2.4782, mae: 1.8219, wmape: 21.5803, r2: 0.1123,
      mape: 22.4859, smape: 20.6115, mase: 0.7122, rmsse: 0.6510,
      me: null, mpe: null, adjusted_r2: "0.1068", theils_u: null,
      rank: 2, accepted: true, rejected_reason: null
    },
    {
      model_name: "Linear Regression", target: "avg_speed_kmh",
      rmse: 2.5093, mae: 1.8458, wmape: 21.8611, r2: 0.0897,
      mape: 22.7302, smape: 20.8763, mase: 0.7215, rmsse: 0.6592,
      me: null, mpe: null, adjusted_r2: "0.0840", theils_u: null,
      rank: 3, accepted: true, rejected_reason: null
    },
  ];

  console.log("Inserting metrics...");
  for (const m of metrics) {
    await db.query(`
      INSERT INTO gold.ml_model_metrics 
        (model_name, target, rmse, mae, wmape, r2, mape, smape, mase, rmsse, me, mpe, adjusted_r2, theils_u, aic, bic, rank, accepted, rejected_reason, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, NOW())
      ON CONFLICT (model_name, target) DO UPDATE SET
        rmse=EXCLUDED.rmse, mae=EXCLUDED.mae, wmape=EXCLUDED.wmape, r2=EXCLUDED.r2,
        mape=EXCLUDED.mape, smape=EXCLUDED.smape, mase=EXCLUDED.mase, rmsse=EXCLUDED.rmsse,
        me=EXCLUDED.me, mpe=EXCLUDED.mpe, adjusted_r2=EXCLUDED.adjusted_r2, theils_u=EXCLUDED.theils_u,
        aic=EXCLUDED.aic, bic=EXCLUDED.bic, rank=EXCLUDED.rank, accepted=EXCLUDED.accepted,
        rejected_reason=EXCLUDED.rejected_reason, updated_at=NOW()
    `, [m.model_name, m.target, m.rmse, m.mae, m.wmape, m.r2, m.mape, m.smape, m.mase, m.rmsse, m.me, m.mpe, m.adjusted_r2, m.theils_u, null, null, m.rank, m.accepted, m.rejected_reason]);
    console.log(`  ✓ ${m.model_name} (${m.target})`);
  }

  // Verify
  const { rows } = await db.query(`SELECT model_name, target, rmse, mae, wmape, r2, rank, accepted FROM gold.ml_model_metrics ORDER BY target, rank`);
  console.log("\nVerification:");
  console.table(rows);

  await db.end();
  console.log("\nDone!");
}

main().catch(e => { console.error(e); process.exit(1); });
