"""
Walk-forward validation for LSTM (volume) and XGBoost (speed).
3-fold expanding window.
"""
import pandas as pd
import numpy as np
import json
import os
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'

from sklearn.preprocessing import MinMaxScaler
from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
import xgboost as xgb
import tensorflow as tf
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense, Dropout
from metrics_utils import compute_all_metrics

def create_sequences(data, seq_length):
    X, y = [], []
    for i in range(len(data) - seq_length):
        X.append(data[i:i + seq_length])
        y.append(data[i + seq_length, 0])
    return np.array(X), np.array(y)

def train_lstm_wf():
    """LSTM walk-forward for total_volume."""
    print("=== LSTM (Walk-Forward) ===")
    df = pd.read_csv('C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs/traffic_speed_dataset.csv')
    df = df.dropna(subset=['total_volume'])
    df = df[df['total_volume'] > 0].copy()
    df.sort_values(by=['date_day', 'hour_of_day'], inplace=True)
    df.reset_index(drop=True, inplace=True)
    
    # Feature engineering
    df['hour_sin'] = np.sin(2 * np.pi * df['hour_of_day'] / 24)
    df['hour_cos'] = np.cos(2 * np.pi * df['hour_of_day'] / 24)
    dow_map = {'Monday':0,'Tuesday':1,'Wednesday':2,'Thursday':3,'Friday':4,'Saturday':5,'Sunday':6}
    df['dow_num'] = df['day_of_week'].map(dow_map)
    df['dow_sin'] = np.sin(2 * np.pi * df['dow_num'] / 7)
    df['dow_cos'] = np.cos(2 * np.pi * df['dow_num'] / 7)
    
    features = ['total_volume', 'hour_of_day', 'is_weekend', 'is_rush_hour', 'is_holiday',
                'temperature', 'rainfall', 'wind_speed', 'humidity',
                'hour_sin', 'hour_cos', 'dow_sin', 'dow_cos']
    
    n = len(df)
    test_size = int(n * 0.08)
    min_train = int(n * 0.60)
    seq_length = 24
    
    all_metrics = []
    for fold_i in range(3):
        tr_end = min_train + fold_i * test_size
        te_end = min(tr_end + test_size, n)
        if tr_end >= n: break
        
        print(f"  Fold {fold_i+1}: train {tr_end} rows, test {te_end - tr_end} rows")
        
        data = df[features].values
        scaler = MinMaxScaler(feature_range=(0, 1))
        scaled_train = scaler.fit_transform(data[:tr_end])
        scaled_test = scaler.transform(data[tr_end - seq_length:te_end])
        
        X_train, y_train = create_sequences(scaled_train, seq_length)
        X_test, y_test = create_sequences(scaled_test, seq_length)
        
        model = Sequential([
            LSTM(50, return_sequences=True, input_shape=(seq_length, len(features))),
            Dropout(0.2),
            LSTM(50, return_sequences=False),
            Dropout(0.2),
            Dense(25),
            Dense(1)
        ])
        model.compile(optimizer='adam', loss='mean_squared_error')
        model.fit(X_train, y_train, batch_size=128, epochs=5, verbose=0)
        
        predictions = model.predict(X_test, verbose=0)
        
        # Inverse transform
        dummy = np.zeros((len(predictions), len(features)))
        dummy[:, 0] = predictions.flatten()
        y_pred = scaler.inverse_transform(dummy)[:, 0]
        
        dummy_y = np.zeros((len(y_test), len(features)))
        dummy_y[:, 0] = y_test
        y_test_unscaled = scaler.inverse_transform(dummy_y)[:, 0]
        
        y_train_raw = df['total_volume'].values[:tr_end]
        metrics = compute_all_metrics(y_test_unscaled, y_pred, y_train=y_train_raw, n_features=len(features))
        all_metrics.append(metrics)
        print(f"    WMAPE={metrics['WMAPE']:.2f}%, MASE={metrics['MASE']:.4f}, R2={metrics['R2']:.4f}")
        
        tf.keras.backend.clear_session()
    
    avg = {}
    for k in all_metrics[0]:
        vals = [m[k] for m in all_metrics if isinstance(m.get(k), (int, float)) and not np.isnan(m[k])]
        avg[k] = round(float(np.mean(vals)), 4) if vals else "N/A"
    
    result = {"model": "LSTM", "target": "total_volume", "validation": "3-fold walk-forward",
              "architecture": "2xLSTM(50)+Dropout(0.2)+Dense(25,1)", "seq_length": 24, "metrics": avg}
    
    out = 'C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs'
    with open(f"{out}/wf_lstm_results.json", 'w') as f:
        json.dump(result, f, indent=4)
    print(f"  Saved: wf_lstm_results.json")
    return avg

def train_xgboost_wf():
    """XGBoost walk-forward for avg_speed_kmh."""
    print("\n=== XGBOOST (Walk-Forward) ===")
    df = pd.read_csv('C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs/traffic_speed_dataset.csv')
    df.sort_values(by=['date_day', 'hour_of_day'], inplace=True)
    df = df.dropna(subset=['avg_speed_kmh']).copy()
    df.reset_index(drop=True, inplace=True)
    
    target = 'avg_speed_kmh'
    df['lag_24h'] = df[target].shift(24)
    df['lag_168h'] = df[target].shift(168)
    df['hour_sin'] = np.sin(2 * np.pi * df['hour_of_day'] / 24)
    df['hour_cos'] = np.cos(2 * np.pi * df['hour_of_day'] / 24)
    dow_map = {'Monday':0,'Tuesday':1,'Wednesday':2,'Thursday':3,'Friday':4,'Saturday':5,'Sunday':6}
    df['dow_num'] = df['day_of_week'].map(dow_map)
    df['dow_sin'] = np.sin(2 * np.pi * df['dow_num'] / 7)
    df['dow_cos'] = np.cos(2 * np.pi * df['dow_num'] / 7)
    df.dropna(subset=['lag_24h', 'lag_168h'], inplace=True)
    df.reset_index(drop=True, inplace=True)
    
    features = ['hour_of_day', 'is_weekend', 'is_rush_hour', 'is_holiday',
                'volume_class1', 'volume_class2', 'volume_class3', 'total_volume',
                'temperature', 'rainfall', 'wind_speed', 'humidity',
                'lag_24h', 'lag_168h', 'hour_sin', 'hour_cos', 'dow_sin', 'dow_cos']
    
    n = len(df)
    test_size = int(n * 0.08)
    min_train = int(n * 0.60)
    
    all_metrics = []
    feat_importances = []
    
    for fold_i in range(3):
        tr_end = min_train + fold_i * test_size
        te_end = min(tr_end + test_size, n)
        if tr_end >= n: break
        
        print(f"  Fold {fold_i+1}: train {tr_end} rows, test {te_end - tr_end} rows")
        
        X_train = df[features].iloc[:tr_end]
        y_train = df[target].iloc[:tr_end]
        X_test = df[features].iloc[tr_end:te_end]
        y_test = df[target].iloc[tr_end:te_end]
        
        model = xgb.XGBRegressor(n_estimators=100, max_depth=6, learning_rate=0.1, random_state=42)
        model.fit(X_train, y_train)
        y_pred = model.predict(X_test)
        
        metrics = compute_all_metrics(y_test.values, y_pred, y_train=y_train.values, n_features=len(features))
        all_metrics.append(metrics)
        feat_importances.append(dict(zip(features, model.feature_importances_)))
        print(f"    WMAPE={metrics['WMAPE']:.2f}%, MASE={metrics['MASE']:.4f}, R2={metrics['R2']:.4f}")
    
    avg = {}
    for k in all_metrics[0]:
        vals = [m[k] for m in all_metrics if isinstance(m.get(k), (int, float)) and not np.isnan(m[k])]
        avg[k] = round(float(np.mean(vals)), 4) if vals else "N/A"
    
    # Average feature importance
    avg_imp = {}
    for feat in features:
        avg_imp[feat] = round(float(np.mean([fi[feat] for fi in feat_importances])), 6)
    
    result = {"model": "XGBoost", "target": "avg_speed_kmh", "validation": "3-fold walk-forward",
              "n_features": len(features), "metrics": avg, "feature_importance": avg_imp}
    
    out = 'C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs'
    with open(f"{out}/wf_xgboost_results.json", 'w') as f:
        json.dump(result, f, indent=4)
    print(f"  Saved: wf_xgboost_results.json")
    return avg

def main():
    train_lstm_wf()
    train_xgboost_wf()
    print("\nML models walk-forward complete!")

if __name__ == "__main__":
    main()
