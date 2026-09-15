import pandas as pd
import numpy as np
import json
import os

from sklearn.preprocessing import MinMaxScaler
from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
import tensorflow as tf
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense, Dropout

def wmape(y_true, y_pred):
    return np.sum(np.abs(y_true - y_pred)) / np.sum(np.abs(y_true)) * 100

def create_sequences(data, seq_length):
    X, y = [], []
    for i in range(len(data) - seq_length):
        X.append(data[i:i + seq_length])
        # Predict the speed of the next hour
        y.append(data[i + seq_length, 0])
    return np.array(X), np.array(y)

def main():
    print("Loading dataset...")
    df = pd.read_csv('C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs/traffic_speed_dataset.csv')
    df.sort_values(by=['date_day', 'hour_of_day'], inplace=True)
    
    # Filter out future dates without volume (e.g. late 2024-2026)
    df = df.dropna(subset=['total_volume'])
    
    # Feature Engineering (Cyclical)
    df['hour_sin'] = np.sin(2 * np.pi * df['hour_of_day'] / 24)
    df['hour_cos'] = np.cos(2 * np.pi * df['hour_of_day'] / 24)
    dow_map = {'Monday':0, 'Tuesday':1, 'Wednesday':2, 'Thursday':3, 'Friday':4, 'Saturday':5, 'Sunday':6}
    df['dow_num'] = df['day_of_week'].map(dow_map)
    df['dow_sin'] = np.sin(2 * np.pi * df['dow_num'] / 7)
    df['dow_cos'] = np.cos(2 * np.pi * df['dow_num'] / 7)
    
    features = [
        'total_volume',  # Target must be index 0
        'hour_of_day', 'is_weekend', 'is_rush_hour', 'is_holiday',
        'temperature', 'rainfall', 'wind_speed', 'humidity',
        'hour_sin', 'hour_cos', 'dow_sin', 'dow_cos'
    ]
    
    data = df[features].values
    
    # Scale data
    scaler = MinMaxScaler(feature_range=(0, 1))
    scaled_data = scaler.fit_transform(data)
    
    # Create sequences: past 24 hours to predict next hour
    seq_length = 24
    X, y = create_sequences(scaled_data, seq_length)
    
    # Split 80/20 temporally
    train_size = int(len(X) * 0.8)
    X_train, X_test = X[:train_size], X[train_size:]
    y_train, y_test = y[:train_size], y[train_size:]
    
    print(f"Training LSTM on {len(X_train)} sequences...")
    model = Sequential()
    model.add(LSTM(50, return_sequences=True, input_shape=(X_train.shape[1], X_train.shape[2])))
    model.add(Dropout(0.2))
    model.add(LSTM(50, return_sequences=False))
    model.add(Dropout(0.2))
    model.add(Dense(25))
    model.add(Dense(1))
    
    model.compile(optimizer='adam', loss='mean_squared_error')
    
    # Train (keep epochs low for speed in this test)
    model.fit(X_train, y_train, batch_size=128, epochs=5, validation_data=(X_test, y_test), verbose=1)
    
    print("Predicting...")
    predictions = model.predict(X_test)
    
    # Inverse transform to get original scale
    dummy = np.zeros((len(predictions), scaled_data.shape[1]))
    dummy[:, 0] = predictions.flatten()
    y_pred = scaler.inverse_transform(dummy)[:, 0]
    
    dummy_y = np.zeros((len(y_test), scaled_data.shape[1]))
    dummy_y[:, 0] = y_test
    y_test_unscaled = scaler.inverse_transform(dummy_y)[:, 0]
    
    # Naive forecast for MASE (persistence: value at t is same as t-1)
    naive_forecast = np.roll(y_test_unscaled, 1)
    naive_forecast[0] = naive_forecast[1] # handle first element
    mae_naive = mean_absolute_error(y_test_unscaled, naive_forecast)
    
    # Metrics
    r2 = r2_score(y_test_unscaled, y_pred)
    mae = mean_absolute_error(y_test_unscaled, y_pred)
    rmse = np.sqrt(mean_squared_error(y_test_unscaled, y_pred))
    mape = np.mean(np.abs((y_test_unscaled - y_pred) / np.maximum(y_test_unscaled, 1))) * 100
    wmape_val = wmape(y_test_unscaled, y_pred)
    mase = mae / mae_naive if mae_naive != 0 else np.nan
    
    results = {
        "model": "LSTM",
        "target": "total_volume",
        "granularity": "Hourly",
        "seq_length_hours": seq_length,
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
    with open(f"{out_dir}/model03_lstm_volume_results.json", 'w') as f:
        json.dump(results, f, indent=4)
        
    print("LSTM training complete.")

if __name__ == "__main__":
    main()
