import pandas as pd
import numpy as np
from prophet import Prophet
from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
import json
import logging

logging.getLogger('cmdstanpy').setLevel(logging.WARNING)
logging.getLogger('prophet').setLevel(logging.WARNING)

def wmape(y_true, y_pred):
    return np.sum(np.abs(y_true - y_pred)) / np.sum(np.abs(y_true)) * 100

def main():
    print("Loading dataset...")
    df = pd.read_csv('C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs/traffic_speed_dataset.csv')
    
    # Filter rows with actual volume data
    df = df.dropna(subset=['total_volume'])
    df = df[df['total_volume'] > 0].copy()
    
    # Prophet requires 'ds' (datetime) and 'y' (target) columns
    df['ds'] = pd.to_datetime(df['date_day']) + pd.to_timedelta(df['hour_of_day'], unit='h')
    df['y'] = df['total_volume']
    
    # Sort chronologically
    df.sort_values(by='ds', inplace=True)
    df.reset_index(drop=True, inplace=True)
    
    # Split 80/20 temporally
    train_size = int(len(df) * 0.8)
    train_df = df.iloc[:train_size].copy()
    test_df = df.iloc[train_size:].copy()
    
    print(f"Training Prophet on {len(train_df)} rows, testing on {len(test_df)} rows...")
    
    # Configure Prophet with daily and weekly seasonality
    model = Prophet(
        seasonality_mode='multiplicative',
        daily_seasonality=True,
        weekly_seasonality=True,
        yearly_seasonality=True
    )
    
    # Add exogenous regressors
    model.add_regressor('is_weekend')
    model.add_regressor('is_rush_hour')
    model.add_regressor('is_holiday')
    model.add_regressor('temperature')
    model.add_regressor('rainfall')
    
    model.fit(train_df[['ds', 'y', 'is_weekend', 'is_rush_hour', 'is_holiday', 'temperature', 'rainfall']])
    
    print("Predicting...")
    forecast = model.predict(test_df[['ds', 'is_weekend', 'is_rush_hour', 'is_holiday', 'temperature', 'rainfall']])
    
    y_test = test_df['y'].values
    y_pred = forecast['yhat'].values
    
    # Clip negative predictions to 0 (volume can't be negative)
    y_pred = np.maximum(y_pred, 0)
    
    # Naive forecast for MASE (persistence: value at t = value at t-1)
    naive_forecast = np.roll(y_test, 1)
    naive_forecast[0] = naive_forecast[1]
    mae_naive = mean_absolute_error(y_test, naive_forecast)
    
    # Metrics
    r2 = r2_score(y_test, y_pred)
    mae = mean_absolute_error(y_test, y_pred)
    rmse = np.sqrt(mean_squared_error(y_test, y_pred))
    mape = np.mean(np.abs((y_test - y_pred) / np.maximum(y_test, 1))) * 100
    wmape_val = wmape(y_test, y_pred)
    mase = mae / mae_naive if mae_naive != 0 else np.nan
    
    results = {
        "model": "Prophet",
        "target": "total_volume",
        "granularity": "Hourly",
        "data_period": f"{train_df['ds'].min().date()} to {test_df['ds'].max().date()}",
        "n_train": len(train_df),
        "n_test": len(test_df),
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
    
    out_dir = 'C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs'
    with open(f"{out_dir}/model02_prophet_volume_results.json", 'w') as f:
        json.dump(results, f, indent=4)
        
    print("Prophet training complete.")

if __name__ == "__main__":
    main()
