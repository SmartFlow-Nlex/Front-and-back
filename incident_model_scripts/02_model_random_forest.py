import os
import json
import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, mean_poisson_deviance

# Configurations
TRAIN_CSV = "output/train_incident.csv"
TEST_CSV = "output/test_incident.csv"
OUTPUT_DIR = "output"

def prepare_data(df):
    features = [
        "hour_of_day", "is_weekend", "is_rush_hour", "is_holiday", 
        "volume_total", "temperature", "rainfall", "wind_speed", 
        "humidity", "avg_speed_kmh", "avg_jam_level", "exit_code", "exit_km"
    ]
    target = "incident_count"
    
    # Ensure boolean columns are integers
    for col in ["is_holiday_window"]:
        if col in df.columns:
            df[col] = df[col].astype(int)
    
    # Drop rows where target is missing, but fill features with 0 to prevent dropping all rows
    df = df.dropna(subset=[target])
    df[features] = df[features].fillna(0)
    
    X = df[features]
    y = df[target]
    
    return X, y, features

def main():
    print("Loading data for Random Forest...")
    if not os.path.exists(TRAIN_CSV) or not os.path.exists(TEST_CSV):
        print(f"Error: Run 01_train_test_split.py first. Missing {TRAIN_CSV} or {TEST_CSV}")
        return

    train_df = pd.read_csv(TRAIN_CSV)
    test_df = pd.read_csv(TEST_CSV)
    
    X_train, y_train, feature_cols = prepare_data(train_df)
    X_test, y_test, _ = prepare_data(test_df)
    
    print(f"Training Random Forest on {len(X_train)} samples...")
    # Train Random Forest
    rf = RandomForestRegressor(n_estimators=50, max_depth=10, random_state=42, n_jobs=-1)
    rf.fit(X_train, y_train)
    
    print("Evaluating...")
    # Predict
    preds = rf.predict(X_test)
    # Ensure strictly positive predictions for Poisson Deviance
    preds = np.clip(preds, 1e-6, None)
    
    mae = mean_absolute_error(y_test, preds)
    rmse = np.sqrt(mean_squared_error(y_test, preds))
    
    # Calculate Poisson Deviance if target >= 0
    try:
        poisson_dev = mean_poisson_deviance(y_test, preds)
    except Exception as e:
        print(f"Poisson deviance error: {e}")
        poisson_dev = None

    metrics = {
        "model": "Random Forest",
        "MAE": mae,
        "RMSE": rmse,
        "Poisson_Deviance": poisson_dev
    }
    
    print("--- Metrics ---")
    for k, v in metrics.items():
        print(f"{k}: {v:.4f}" if isinstance(v, float) else f"{k}: {v}")
        
    # Feature Importance
    importances = pd.DataFrame({
        'feature': feature_cols,
        'importance': rf.feature_importances_
    }).sort_values('importance', ascending=False)
    
    # Save results
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(os.path.join(OUTPUT_DIR, "model02_rf_results.json"), "w") as f:
        json.dump(metrics, f, indent=4)
        
    importances.to_csv(os.path.join(OUTPUT_DIR, "model02_rf_feature_importance.csv"), index=False)
    
    print("Saved metrics and feature importances.")

if __name__ == "__main__":
    main()
