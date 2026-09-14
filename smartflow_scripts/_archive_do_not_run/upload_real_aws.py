raise SystemExit(
    "ARCHIVED - do not run. Writes gold.ml_predictive_volume / gold.ml_model_metrics and would overwrite the current results. Superseded by 3_training_testing/traffic_volume/retrain_honest.py. "
    "Kept only as a record; see smartflow_scripts/README.md.")

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
import numpy as np

# DB Connection
# Connection settings live in smartflow_scripts/config/.env, read by config/db.py.
# They used to be hardcoded in this file and in ~80 others.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "config"))
from db import PG, POSTGRES_URL, WORK, setting  # noqa: E402,F401

PREDS_CSV = r"C:\Users\Hans\.gemini\antigravity\scratch\predictive folder\training_and_testing_outputs\04_aws_live_predictions\aws_live_predictions.csv"
METRICS_CSV = r"C:\Users\Hans\.gemini\antigravity\scratch\predictive folder\training_and_testing_outputs\02_final_evaluation_walkforward\wf_all_models_metrics.csv"

def upload_predictions(cur):
    print("Loading actual predictions...")
    df = pd.read_csv(PREDS_CSV)
    
    records = []
    for _, row in df.iterrows():
        # Replace NaN with None
        date = str(row['forecast_date'])
        actual = float(row['actual_volume']) if pd.notna(row['actual_volume']) else None
        lstm = float(row['pred_lstm']) if pd.notna(row['pred_lstm']) else None
        prophet = float(row['pred_prophet']) if pd.notna(row['pred_prophet']) else None
        xgb = float(row['pred_xgboost']) if pd.notna(row['pred_xgboost']) else None
        hw = float(row['pred_holtwinters']) if pd.notna(row['pred_holtwinters']) else None
        sarimax = float(row['pred_sarimax']) if pd.notna(row['pred_sarimax']) else None
        hl = float(row['pred_holts_linear']) if pd.notna(row['pred_holts_linear']) else None
        is_h = bool(row['is_holdout'])
        is_f = bool(row['is_future'])
        
        records.append((date, actual, lstm, prophet, xgb, hw, sarimax, hl, is_h, is_f))

    print("Uploading predictions...")
    cur.execute("TRUNCATE TABLE gold.ml_predictive_volume;")
    query = """
        INSERT INTO gold.ml_predictive_volume 
        (forecast_date, actual_volume, pred_lstm, pred_prophet, pred_xgboost, pred_holtwinters, pred_sarimax, pred_holts_linear, is_holdout, is_future)
        VALUES %s
    """
    execute_values(cur, query, records, page_size=1000)

def upload_metrics(cur):
    print("Loading actual metrics...")
    df = pd.read_csv(METRICS_CSV)
    
    records = []
    for _, row in df.iterrows():
        model = str(row['Model']).replace("Holt-Winters", "HoltWinters")
        target = str(row['Target'])
        rmse = float(row['RMSE']) if pd.notna(row['RMSE']) else None
        mae = float(row['MAE']) if pd.notna(row['MAE']) else None
        wmape = float(row['WMAPE']) if pd.notna(row['WMAPE']) else None
        
        # Handle 'N/A' or strings in R2
        try:
            r2 = float(row['R2'])
        except:
            r2 = None
            
        records.append((model, target, rmse, mae, wmape, r2))

    print("Uploading metrics...")
    cur.execute("TRUNCATE TABLE gold.ml_model_metrics;")
    query = """
        INSERT INTO gold.ml_model_metrics 
        (model_name, target, rmse, mae, wmape, r2)
        VALUES %s
    """
    execute_values(cur, query, records)

def main():
    print("Connecting to AWS...")
    conn = psycopg2.connect(POSTGRES_URL)
    cur = conn.cursor()
    
    upload_predictions(cur)
    upload_metrics(cur)
    
    conn.commit()
    cur.close()
    conn.close()
    print("Successfully uploaded REAL ML data to AWS!")

if __name__ == "__main__":
    main()
