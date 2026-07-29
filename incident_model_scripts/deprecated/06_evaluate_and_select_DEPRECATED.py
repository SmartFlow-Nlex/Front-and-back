"""
========================================================================
 DEPRECATED - DO NOT RUN
========================================================================
This script belongs to the first-generation pipeline (01-10, superseded
by 11-17 + incident_metrics.py). It is kept only for historical
reference and MUST NOT be executed:

  * get_forecast_predictions() below does not call any trained model.
    It synthesizes a sine wave ("Dummy legitimate future prediction
    generation" - see its own comment) and would be written to the
    dashboard as if it were a real forecast.
  * It writes to ml_predictive_incidents and ml_training_metadata with
    to_sql(if_exists="replace"), i.e. it DELETES the live, real
    walk-forward-validated data currently published by
    11_publish_rf_to_dashboard.py and replaces it with the sine wave
    above plus shallow, non-walk-forward metrics.
  * Verified 2026-07-28: the live AWS RDS tables were confirmed to still
    reflect 11_publish_rf_to_dashboard.py's output (champion_model =
    XGBoost, metrics_source = "3-fold expanding-window walk-forward"),
    i.e. this script has never actually been run against production -
    keep it that way.

A hard guard below prevents accidental execution even if this file is
run directly. Do not remove the guard without team sign-off.
========================================================================
"""
import sys

raise SystemExit(
    "06_evaluate_and_select_DEPRECATED.py is disabled: it overwrites the "
    "live ml_predictive_incidents / ml_training_metadata tables with a "
    "fabricated sine-wave forecast, not a real model prediction. Use "
    "11_publish_rf_to_dashboard.py instead. See the module docstring."
)

import os
import json
import pandas as pd
import glob
from datetime import datetime, timezone, timedelta
from sqlalchemy import create_engine

OUTPUT_DIR = "output"
# Credentials come from the environment, never hardcoded.
# Set PGURL (or POSTGRES_URL) before running, e.g. from Back-End/.env
DB_URL = os.environ.get("PGURL") or os.environ.get("POSTGRES_URL")
if not DB_URL:
    raise SystemExit("Set PGURL (or POSTGRES_URL) to the AWS RDS connection string.")
def get_forecast_predictions(champion_name, last_actual):
    # Dummy legitimate future prediction generation for the Champion model.
    # In a real scenario, this would apply the saved model object to 7 days of future covariates.
    import numpy as np
    # 7-day forecast (daily points)
    # Generate a smooth continuation based on the last actual
    return [max(0, last_actual + np.sin(i / 7 * 2 * np.pi) * 5) for i in range(1, 8)]

def main():
    print("=============================================================")
    print("INCIDENT FORECASTING CANDIDATES (target: incident_count)")
    print("=============================================================")

    # Load all results
    result_files = glob.glob(os.path.join(OUTPUT_DIR, "*_results.json"))
    models = []
    
    for f in result_files:
        with open(f, "r") as file:
            data = json.load(file)
            models.append(data)
            
    if not models:
        print("No model results found. Please run the training scripts first.")
        return
        
    # Rank models based on Poisson Deviance (primary) and MAE (secondary)
    models = sorted(models, key=lambda x: (x.get('Poisson_Deviance', 999), x.get('MAE', 999)))

    champion = models[0]
    
    # Console Output formatting matching the required style
    print(f"[SELECTED] {champion['model']}")
    print("-------------------------------------------------------------")
    print(f"MAE              = {champion['MAE']:.4f}")
    print(f"Poisson Deviance = {champion['Poisson_Deviance']:.4f}")
    print("\n")
    
    for idx, model in enumerate(models[1:], start=2):
        print(f"[RANK #{idx}] {model['model']}")
        print("-------------------------------------------------------------")
        print(f"MAE              = {model['MAE']:.4f}")
        print(f"Poisson Deviance = {model['Poisson_Deviance']:.4f}")
        print("\n")

    # Save comparison report
    with open(os.path.join(OUTPUT_DIR, "eval01_model_comparison.json"), "w") as f:
        json.dump({"rankings": models, "champion": champion['model']}, f, indent=4)

    print("Connecting to AWS RDS to store predictions and metadata...")
    engine = create_engine(DB_URL)
    
    # 1. Store Predictions in AWS RDS
    # Load test set to get validation dates
    test_df = pd.read_csv(os.path.join(OUTPUT_DIR, "test_incident.csv"))
    val_dates = test_df['date_day'].tolist()
    
    val_preds = champion['predictions']
    
    # Aggregate hourly predictions to daily sum
    val_pred_df = pd.DataFrame({'date': val_dates, 'pred': val_preds})
    val_daily = val_pred_df.groupby('date')['pred'].sum().reset_index()
    
    pred_records = []
    # Validation predictions
    for _, row in val_daily.iterrows():
        pred_records.append({
            "forecast_date": row['date'],
            "prediction_type": "validation",
            "predicted_incident_count": float(row['pred'])
        })
        
    # Future forecasts (7 days)
    last_date_str = val_dates[-1]
    last_date = datetime.strptime(last_date_str, "%Y-%m-%d")
    
    # Legitimately check if model allows future forecasting
    if not val_daily.empty:
        last_pred = val_daily['pred'].iloc[-1]
        future_preds = get_forecast_predictions(champion['model'], last_pred)
        for i, p in enumerate(future_preds, 1):
            fd = (last_date + timedelta(days=i)).strftime("%Y-%m-%d")
            pred_records.append({
                "forecast_date": fd,
                "prediction_type": "future",
                "predicted_incident_count": float(p)
            })

    pred_df = pd.DataFrame(pred_records)
    pred_df['champion_model'] = champion['model']
    pred_df['created_at'] = datetime.now(timezone.utc)
    
    pred_df.to_sql("ml_predictive_incidents", engine, if_exists="replace", index=False)
    print(f"Saved {len(pred_df)} prediction records to ml_predictive_incidents table.")

    # 2. Store Metadata Record
    train_df = pd.read_csv(os.path.join(OUTPUT_DIR, "train_incident.csv"))
    
    # Find matching feature importance file
    fi_files = glob.glob(os.path.join(OUTPUT_DIR, "*_feature_importance.csv"))
    fi_dict = {}
    if fi_files:
        # Just grab the most recent or matching one for the champion
        # In a real pipeline, the filename should match the model
        latest_fi = max(fi_files, key=os.path.getctime)
        fi_df = pd.read_csv(latest_fi)
        fi_dict = dict(zip(fi_df['feature'], fi_df['importance']))

    metadata = {
        "champion_model": champion['model'],
        "metrics": {
            "MAE": champion['MAE'],
            "Poisson_Deviance": champion['Poisson_Deviance']
        },
        "training_timestamp": datetime.now(timezone.utc).isoformat(),
        "training_period": f"{train_df['date_day'].iloc[0]} to {train_df['date_day'].iloc[-1]}",
        "validation_period": f"{test_df['date_day'].iloc[0]} to {test_df['date_day'].iloc[-1]}",
        "training_samples": len(train_df),
        "validation_samples": len(test_df),
        "feature_importance": fi_dict,
        "models_evaluated": [m['model'] for m in models]
    }
    
    metadata_df = pd.DataFrame([{"metadata_json": json.dumps(metadata), "created_at": datetime.now(timezone.utc)}])
    metadata_df.to_sql("ml_training_metadata", engine, if_exists="replace", index=False)
    print("Saved training metadata to ml_training_metadata table.")
    
    print("Pipeline Execution Complete!")

if __name__ == "__main__":
    main()
