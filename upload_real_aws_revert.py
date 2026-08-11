import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

# DB Connection
POSTGRES_URL = "postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone"

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
        
        try:
            r2 = float(row['R2'])
        except:
            r2 = None
            
        rank = None
        accepted = False
        if model == "LSTM":
            rank = 1; accepted = True
        elif model == "Prophet":
            rank = 2; accepted = True
        elif model == "SARIMAX":
            rank = 3
        elif model == "HoltWinters":
            rank = 4
        elif model == "Holts_Linear":
            rank = 5
            
        records.append((model, target, rmse, mae, wmape, r2, rank, accepted))

    print("Uploading metrics...")
    cur.execute("TRUNCATE TABLE gold.ml_model_metrics;")
    query = """
        INSERT INTO gold.ml_model_metrics 
        (model_name, target, rmse, mae, wmape, r2, rank, accepted)
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
    print("Successfully REVERTED to original RAW ML data!")

if __name__ == "__main__":
    main()
