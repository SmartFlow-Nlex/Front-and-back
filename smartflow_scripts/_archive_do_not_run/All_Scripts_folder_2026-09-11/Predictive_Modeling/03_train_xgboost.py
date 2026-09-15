import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
import json
import os
import matplotlib.pyplot as plt

def wmape(y_true, y_pred):
    return np.sum(np.abs(y_true - y_pred)) / np.sum(np.abs(y_true)) * 100

def create_features(df):
    df = df.copy()
    
    # Target
    target = 'avg_speed_kmh'
    
    # Drop rows without speed data (e.g. 2020-2021)
    df.dropna(subset=[target], inplace=True)
    
    # Lags (Careful to only use lags that would be available in a real forecast)
    # E.g., if predicting 24h ahead, we can't use lag_1h. We use lag_24h, lag_168h.
    # To be safe from leakage for a 1-hour ahead forecast, lag_1h is okay.
    # But since XGBoost previously leaked on lag_1h, let's remove it to force it to learn actual patterns.
    df['lag_24h'] = df[target].shift(24)
    df['lag_168h'] = df[target].shift(168)
    
    # Cyclical time features
    df['hour_sin'] = np.sin(2 * np.pi * df['hour_of_day'] / 24)
    df['hour_cos'] = np.cos(2 * np.pi * df['hour_of_day'] / 24)
    
    dow_map = {'Monday':0, 'Tuesday':1, 'Wednesday':2, 'Thursday':3, 'Friday':4, 'Saturday':5, 'Sunday':6}
    df['dow_num'] = df['day_of_week'].map(dow_map)
    df['dow_sin'] = np.sin(2 * np.pi * df['dow_num'] / 7)
    df['dow_cos'] = np.cos(2 * np.pi * df['dow_num'] / 7)
    
    # Drop rows with NaN from lags
    df.dropna(subset=['lag_24h', 'lag_168h'], inplace=True)
    
    features = [
        'hour_of_day', 'is_weekend', 'is_rush_hour', 'is_holiday',
        'volume_class1', 'volume_class2', 'volume_class3', 'total_volume',
        'temperature', 'rainfall', 'wind_speed', 'humidity',
        'lag_24h', 'lag_168h', 'hour_sin', 'hour_cos', 'dow_sin', 'dow_cos'
    ]
    return df, features, target

def main():
    print("Loading dataset...")
    df = pd.read_csv('C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs/traffic_speed_dataset.csv')
    df.sort_values(by=['date_day', 'hour_of_day'], inplace=True)
    
    df, features, target = create_features(df)
    
    # Split 80/20 temporally
    train_size = int(len(df) * 0.8)
    train_df = df.iloc[:train_size]
    test_df = df.iloc[train_size:]
    
    X_train, y_train = train_df[features], train_df[target]
    X_test, y_test = test_df[features], test_df[target]
    
    print(f"Training XGBoost on {len(X_train)} rows with {len(features)} features...")
    model = xgb.XGBRegressor(n_estimators=100, max_depth=6, learning_rate=0.1, random_state=42)
    model.fit(X_train, y_train)
    
    print("Predicting...")
    y_pred = model.predict(X_test)
    
    # Metrics
    r2 = r2_score(y_test, y_pred)
    mae = mean_absolute_error(y_test, y_pred)
    rmse = np.sqrt(mean_squared_error(y_test, y_pred))
    mape = np.mean(np.abs((y_test - y_pred) / np.maximum(y_test, 1))) * 100
    wmape_val = wmape(y_test, y_pred)
    
    # Naive forecast for MASE (persistence: value at t is same as t-1)
    naive_forecast = np.roll(y_test, 1)
    naive_forecast[0] = naive_forecast[1] # handle first element
    mae_naive = mean_absolute_error(y_test, naive_forecast)
    mase = mae / mae_naive if mae_naive != 0 else np.nan

    results = {
        "model": "XGBoost",
        "target": target,
        "granularity": "Hourly",
        "metrics": {
            "R2": float(r2),
            "MAE": float(mae),
            "RMSE": float(rmse),
            "MAPE": float(mape),
            "WMAPE": float(wmape_val),
            "MASE": float(mase)
        }
    }
    
    print("Results:", json.dumps(results, indent=2))
    
    # Save Feature Importance
    importance = pd.DataFrame({
        'feature': features,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)
    
    out_dir = 'C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs'
    importance.to_csv(f"{out_dir}/model04_xgboost_speed_feature_importance.csv", index=False)
    
    with open(f"{out_dir}/model04_xgboost_speed_results.json", 'w') as f:
        json.dump(results, f, indent=4)
        
    print("XGBoost training complete.")

if __name__ == "__main__":
    main()
