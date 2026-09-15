import pandas as pd
import numpy as np
from statsmodels.tsa.statespace.sarimax import SARIMAX
from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
import json
import warnings
warnings.filterwarnings("ignore")

def wmape(y_true, y_pred):
    return np.sum(np.abs(y_true - y_pred)) / np.sum(np.abs(y_true)) * 100

def main():
    print("Loading dataset...")
    df = pd.read_csv('C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs/traffic_speed_dataset.csv')
    df['date_time'] = pd.to_datetime(df['date_day']) + pd.to_timedelta(df['hour_of_day'], unit='h')
    df.sort_values(by='date_time', inplace=True)
    
    # Filter rows with actual volume data
    df = df.dropna(subset=['total_volume'])
    df = df[df['total_volume'] > 0].copy()
    
    # SARIMAX is computationally expensive with seasonal order on large datasets.
    # Use the last 6 months (~4320 hours) for a tractable fit while still capturing seasonality.
    df = df.tail(4320).copy()
    df.reset_index(drop=True, inplace=True)
    
    # Exogenous variables
    exo_cols = ['is_weekend', 'is_rush_hour', 'is_holiday', 'temperature', 'rainfall']
    
    # Split 80/20 temporally
    train_size = int(len(df) * 0.8)
    train_df = df.iloc[:train_size]
    test_df = df.iloc[train_size:]
    
    y_train = train_df['total_volume'].values
    X_train = train_df[exo_cols].values
    
    y_test = test_df['total_volume'].values
    X_test = test_df[exo_cols].values
    
    print(f"Training SARIMAX on {len(y_train)} hours, testing on {len(y_test)} hours...")
    print("Order=(1,1,1), Seasonal Order=(1,0,1,24) — this may take a few minutes...")
    
    # SARIMAX with daily seasonality (m=24 for hourly data)
    # order=(p,d,q) = (1,1,1): AR(1), differencing(1), MA(1)
    # seasonal_order=(P,D,Q,s) = (1,0,1,24): seasonal AR(1), no seasonal diff, seasonal MA(1), period=24h
    model = SARIMAX(
        y_train, 
        exog=X_train, 
        order=(1, 1, 1), 
        seasonal_order=(1, 0, 1, 24),
        enforce_stationarity=False,
        enforce_invertibility=False
    )
    model_fit = model.fit(disp=False, maxiter=200)
    
    print("Predicting...")
    y_pred = model_fit.forecast(steps=len(y_test), exog=X_test)
    
    # Clip negative predictions to 0
    y_pred = np.maximum(y_pred, 0)
    
    # Naive forecast for MASE
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
    
    date_range = f"{train_df['date_time'].min().date()} to {test_df['date_time'].max().date()}"
    
    results = {
        "model": "SARIMAX",
        "target": "total_volume",
        "granularity": "Hourly",
        "data_period": date_range,
        "data_note": "Last 6 months subset (SARIMAX computational constraint)",
        "order": "(1,1,1)",
        "seasonal_order": "(1,0,1,24)",
        "n_train": len(y_train),
        "n_test": len(y_test),
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
    with open(f"{out_dir}/model01_sarimax_volume_results.json", 'w') as f:
        json.dump(results, f, indent=4)
        
    print("SARIMAX training complete.")

if __name__ == "__main__":
    main()
