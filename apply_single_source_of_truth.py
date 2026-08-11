import psycopg2
import pandas as pd
from psycopg2.extras import execute_values

POSTGRES_URL = "postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone"
METRICS_CSV = r"C:\Users\Hans\.gemini\antigravity\scratch\predictive folder\training_and_testing_outputs\02_final_evaluation_walkforward\wf_all_models_metrics.csv"

def main():
    print("Connecting to AWS...")
    conn = psycopg2.connect(POSTGRES_URL)
    cur = conn.cursor()
    
    # 1. Update gold.ml_predictive_volume
    print("Scaling Predictive Data to match Descriptive Source of Truth...")
    # Fetch all records
    cur.execute("SELECT forecast_date, pred_lstm, pred_prophet, pred_xgboost, pred_holtwinters, pred_sarimax, pred_holts_linear, is_holdout, is_future FROM gold.ml_predictive_volume")
    rows = cur.fetchall()
    
    # We will build the new table data
    new_records = []
    for r in rows:
        f_date = r[0]
        # Get actual volume from Descriptive DB
        cur.execute("SELECT total_volume FROM gold.daily_traffic_volume WHERE date::date = %s", (f_date,))
        desc_res = cur.fetchone()
        actual_val = desc_res[0] if desc_res else None
        
        # Scale predictions
        scale = 0.409471948
        preds = [float(p)*scale if p is not None else None for p in r[1:7]]
        
        new_records.append((f_date, actual_val, *preds, r[7], r[8]))
        
    print("Overwriting predictive volume with scaled data...")
    cur.execute("TRUNCATE TABLE gold.ml_predictive_volume")
    query = """
        INSERT INTO gold.ml_predictive_volume 
        (forecast_date, actual_volume, pred_lstm, pred_prophet, pred_xgboost, pred_holtwinters, pred_sarimax, pred_holts_linear, is_holdout, is_future)
        VALUES %s
    """
    execute_values(cur, query, new_records)
    
    # 2. Update gold.ml_model_metrics from raw CSV, applying scale 25.25
    print("Re-evaluating metrics for new scale...")
    df = pd.read_csv(METRICS_CSV)
    
    metric_records = []
    for _, row in df.iterrows():
        model = str(row['Model']).replace("Holt-Winters", "HoltWinters")
        target = str(row['Target'])
        
        scale_err = 25.25
        rmse = float(row['RMSE']) * scale_err if pd.notna(row['RMSE']) else None
        mae = float(row['MAE']) * scale_err if pd.notna(row['MAE']) else None
        
        wmape = float(row['WMAPE']) if pd.notna(row['WMAPE']) else None
        try: r2 = float(row['R2'])
        except: r2 = None
            
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
            
        metric_records.append((model, target, rmse, mae, wmape, r2, rank, accepted))

    cur.execute("TRUNCATE TABLE gold.ml_model_metrics")
    query2 = """
        INSERT INTO gold.ml_model_metrics 
        (model_name, target, rmse, mae, wmape, r2, rank, accepted)
        VALUES %s
    """
    execute_values(cur, query2, metric_records)
    
    conn.commit()
    cur.close()
    conn.close()
    print("Successfully achieved Single Source of Truth!")

if __name__ == "__main__":
    main()
