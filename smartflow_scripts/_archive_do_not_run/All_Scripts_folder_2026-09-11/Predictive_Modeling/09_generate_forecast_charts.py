"""
SmartFlow NLEX - Forecast Visualization
========================================
Generates the adviser-required 3-zone forecast charts:
  BLUE shading  = PAST (Training data)
  ORANGE shading = PRESENT (Holdout/validation)
  GREEN shading  = FUTURE (Forecast projection)

Blue line  = Historical (Actual) values
Green line = Model forecast (holdout + future)
Orange dashed = Chosen model predictions on holdout
Vertical dashed line = Train/test split point

Includes a metrics table at the bottom of each chart.

Models:
  1. LSTM -> total_volume (traffic volume forecasting)
  2. XGBoost -> avg_speed_kmh (speed/congestion forecasting)
"""
import pandas as pd
import numpy as np
import json
import os
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from matplotlib.patches import Patch
from sklearn.preprocessing import MinMaxScaler
import xgboost as xgb
import tensorflow as tf
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense, Dropout

# Paths
DATASET_PATH = 'C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs/01_dataset/traffic_speed_dataset.csv'
OUT_DIR = 'C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs/02_final_evaluation_walkforward'
METRICS_DIR = f'{OUT_DIR}/model_results'

os.makedirs(OUT_DIR, exist_ok=True)

# =====================================================================
# HELPER: Create the 3-zone forecast chart
# =====================================================================
def plot_forecast_chart(dates_train, y_train_actual,
                        dates_holdout, y_holdout_actual, y_holdout_pred,
                        dates_future, y_future_pred,
                        model_name, target_label, y_label, metrics_dict,
                        filename, resample_rule='W'):
    """
    Creates adviser-style forecast chart with 3 colored zones.
    
    resample_rule: 'W' for weekly, 'D' for daily, 'M' for monthly
    """
    fig, ax = plt.subplots(figsize=(16, 8))
    
    # Convert to Series for resampling
    train_series = pd.Series(y_train_actual, index=pd.to_datetime(dates_train))
    holdout_actual_series = pd.Series(y_holdout_actual, index=pd.to_datetime(dates_holdout))
    holdout_pred_series = pd.Series(y_holdout_pred, index=pd.to_datetime(dates_holdout))
    future_series = pd.Series(y_future_pred, index=pd.to_datetime(dates_future))
    
    # Resample to reduce noise (weekly or monthly average)
    train_resampled = train_series.resample(resample_rule).mean().dropna()
    holdout_actual_resampled = holdout_actual_series.resample(resample_rule).mean().dropna()
    holdout_pred_resampled = holdout_pred_series.resample(resample_rule).mean().dropna()
    future_resampled = future_series.resample(resample_rule).mean().dropna()
    
    # Get boundary dates
    split_date = train_resampled.index[-1]
    holdout_end = holdout_actual_resampled.index[-1] if len(holdout_actual_resampled) > 0 else split_date
    future_end = future_resampled.index[-1] if len(future_resampled) > 0 else holdout_end
    
    # ---- COLORED ZONES (background shading) ----
    ax.axvspan(train_resampled.index[0], split_date, alpha=0.12, color='#4A90D9', label='_nolegend_')  # PAST (blue)
    ax.axvspan(split_date, holdout_end, alpha=0.12, color='#E8945A', label='_nolegend_')  # PRESENT (orange)
    ax.axvspan(holdout_end, future_end, alpha=0.12, color='#5CB85C', label='_nolegend_')  # FUTURE (green)
    
    # ---- VERTICAL SPLIT LINE ----
    ax.axvline(x=split_date, color='#333333', linestyle='--', linewidth=1.2, alpha=0.8)
    # Add "80/20 split" label
    ax.text(split_date, ax.get_ylim()[1] if ax.get_ylim()[1] > 0 else 1, '80/20 split',
            rotation=90, va='top', ha='right', fontsize=8, color='#333333', alpha=0.7)
    
    # ---- PLOT LINES ----
    # Historical (Actual) - Blue line
    ax.plot(train_resampled.index, train_resampled.values, 
            color='#2171B5', linewidth=1.8, label='Historical (Actual)', zorder=3)
    
    # Holdout actual continuation
    ax.plot(holdout_actual_resampled.index, holdout_actual_resampled.values,
            color='#2171B5', linewidth=1.8, label='_nolegend_', zorder=3)
    
    # Chosen model predictions on holdout - Orange dashed
    ax.plot(holdout_pred_resampled.index, holdout_pred_resampled.values,
            color='#E8945A', linewidth=2.0, linestyle='--', label='Chosen (holdout)', zorder=4)
    
    # Combined forecast line (holdout pred + future pred) - Green solid
    combined_pred_dates = list(holdout_pred_resampled.index) + list(future_resampled.index)
    combined_pred_values = list(holdout_pred_resampled.values) + list(future_resampled.values)
    ax.plot(combined_pred_dates, combined_pred_values,
            color='#2CA02C', linewidth=2.2, label='Forecast (holdout + future)', zorder=5)
    
    # ---- FORMATTING ----
    ax.set_xlabel('Month', fontsize=11, fontweight='bold')
    ax.set_ylabel(y_label, fontsize=11, fontweight='bold')
    ax.set_title(f'{model_name} -- 80/20 holdout -- SmartFlow NLEX -- {target_label}',
                 fontsize=12, fontweight='bold', pad=15)
    
    # Format x-axis
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m'))
    ax.xaxis.set_major_locator(mdates.MonthLocator(interval=2))
    plt.xticks(rotation=45, ha='right')
    
    # Grid
    ax.grid(True, alpha=0.3, linestyle='-')
    ax.set_axisbelow(True)
    
    # ---- LEGEND (matching adviser's reference) ----
    legend_elements = [
        plt.Line2D([0], [0], color='#2171B5', linewidth=2, label='Historical (Actual)'),
        Patch(facecolor='#4A90D9', alpha=0.3, label='PAST (Train)'),
        Patch(facecolor='#E8945A', alpha=0.3, label='PRESENT (Holdout)'),
        plt.Line2D([0], [0], color='#E8945A', linewidth=2, linestyle='--', label='Chosen (holdout)'),
        Patch(facecolor='#5CB85C', alpha=0.3, label='FUTURE (Forecast)'),
        plt.Line2D([0], [0], color='#2CA02C', linewidth=2, label='Forecast (holdout + future)'),
    ]
    ax.legend(handles=legend_elements, loc='upper right', fontsize=8, framealpha=0.9)
    
    # ---- METRICS TABLE AT BOTTOM ----
    table_cols = ['Model', 'MAE', 'RMSE', 'MAPE%', 'MASE', 'WMAPE%', 'MPE%']
    table_vals = [[
        model_name,
        f"{metrics_dict.get('MAE', 'N/A'):.2f}" if isinstance(metrics_dict.get('MAE'), (int, float)) else 'N/A',
        f"{metrics_dict.get('RMSE', 'N/A'):.2f}" if isinstance(metrics_dict.get('RMSE'), (int, float)) else 'N/A',
        f"{metrics_dict.get('MAPE', 'N/A'):.2f}" if isinstance(metrics_dict.get('MAPE'), (int, float)) else 'N/A',
        f"{metrics_dict.get('MASE', 'N/A'):.3f}" if isinstance(metrics_dict.get('MASE'), (int, float)) else 'N/A',
        f"{metrics_dict.get('WMAPE', 'N/A'):.2f}" if isinstance(metrics_dict.get('WMAPE'), (int, float)) else 'N/A',
        f"{metrics_dict.get('MPE', 'N/A'):.2f}" if isinstance(metrics_dict.get('MPE'), (int, float)) else 'N/A',
    ]]
    
    table = ax.table(cellText=table_vals, colLabels=table_cols,
                     loc='bottom', bbox=[0.0, -0.22, 1.0, 0.08],
                     cellLoc='center')
    table.auto_set_font_size(False)
    table.set_fontsize(9)
    for key, cell in table.get_celld().items():
        if key[0] == 0:  # Header row
            cell.set_facecolor('#E8E8E8')
            cell.set_text_props(fontweight='bold')
        cell.set_edgecolor('#CCCCCC')
    
    plt.subplots_adjust(bottom=0.22)
    plt.tight_layout(rect=[0, 0.08, 1, 1])
    
    filepath = f'{OUT_DIR}/{filename}'
    plt.savefig(filepath, dpi=200, bbox_inches='tight', facecolor='white')
    plt.close()
    print(f"  Saved: {filepath}")


# =====================================================================
# 1. LSTM VOLUME FORECAST CHART
# =====================================================================
def create_sequences(data, seq_length):
    X, y = [], []
    for i in range(len(data) - seq_length):
        X.append(data[i:i + seq_length])
        y.append(data[i + seq_length, 0])
    return np.array(X), np.array(y)

def generate_lstm_chart():
    print("\n=== Generating LSTM Volume Forecast Chart ===")
    
    df = pd.read_csv(DATASET_PATH)
    df = df.dropna(subset=['total_volume'])
    df = df[df['total_volume'] > 0].copy()
    df.sort_values(by=['date_day', 'hour_of_day'], inplace=True)
    df.reset_index(drop=True, inplace=True)
    
    # Create datetime index
    df['datetime'] = pd.to_datetime(df['date_day']) + pd.to_timedelta(df['hour_of_day'], unit='h')
    
    # Feature engineering (same as training)
    df['hour_sin'] = np.sin(2 * np.pi * df['hour_of_day'] / 24)
    df['hour_cos'] = np.cos(2 * np.pi * df['hour_of_day'] / 24)
    dow_map = {'Monday':0,'Tuesday':1,'Wednesday':2,'Thursday':3,'Friday':4,'Saturday':5,'Sunday':6}
    df['dow_num'] = df['day_of_week'].map(dow_map)
    df['dow_sin'] = np.sin(2 * np.pi * df['dow_num'] / 7)
    df['dow_cos'] = np.cos(2 * np.pi * df['dow_num'] / 7)
    
    features = ['total_volume', 'hour_of_day', 'is_weekend', 'is_rush_hour', 'is_holiday',
                'temperature', 'rainfall', 'wind_speed', 'humidity',
                'hour_sin', 'hour_cos', 'dow_sin', 'dow_cos']
    
    seq_length = 24
    n = len(df)
    split_idx = int(n * 0.80)
    
    print(f"  Total rows: {n}, Train: {split_idx}, Test: {n - split_idx}")
    print(f"  Train period: {df['datetime'].iloc[0]} to {df['datetime'].iloc[split_idx-1]}")
    print(f"  Test period:  {df['datetime'].iloc[split_idx]} to {df['datetime'].iloc[-1]}")
    
    # Scale data
    data = df[features].values
    scaler = MinMaxScaler(feature_range=(0, 1))
    scaled_train = scaler.fit_transform(data[:split_idx])
    scaled_test = scaler.transform(data[split_idx - seq_length:])
    
    # Create sequences
    X_train, y_train = create_sequences(scaled_train, seq_length)
    X_test, y_test = create_sequences(scaled_test, seq_length)
    
    # Build and train LSTM
    print("  Training LSTM (this may take a minute)...")
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
    
    # Predict on holdout
    predictions = model.predict(X_test, verbose=0)
    
    # Inverse transform predictions
    dummy = np.zeros((len(predictions), len(features)))
    dummy[:, 0] = predictions.flatten()
    y_pred_holdout = scaler.inverse_transform(dummy)[:, 0]
    
    dummy_y = np.zeros((len(y_test), len(features)))
    dummy_y[:, 0] = y_test
    y_test_actual = scaler.inverse_transform(dummy_y)[:, 0]
    
    # Get dates — after creating sequences, we lose seq_length samples from the start
    dates_train = df['datetime'].values[:split_idx]
    # The test predictions start at split_idx + seq_length (offset by sequence window)
    holdout_start = split_idx + seq_length
    n_holdout = min(len(y_test_actual), len(y_pred_holdout), len(df) - holdout_start)
    dates_holdout = df['datetime'].values[holdout_start:holdout_start + n_holdout]
    y_test_actual = y_test_actual[:n_holdout]
    y_pred_holdout = y_pred_holdout[:n_holdout]
    
    # Generate FUTURE forecast (extend 6 months beyond the last data point)
    print("  Generating 6-month future forecast...")
    last_date = pd.to_datetime(df['datetime'].iloc[-1])
    future_hours = 24 * 180  # 6 months
    
    # Use recursive forecasting: keep feeding predictions back
    last_sequence = scaled_test[-seq_length:].copy()
    future_predictions = []
    
    for step in range(future_hours):
        pred = model.predict(last_sequence.reshape(1, seq_length, len(features)), verbose=0)
        
        # Build next input row (use cyclical time features)
        next_hour = (df['hour_of_day'].iloc[-1] + step + 1) % 24
        next_day = ((df['dow_num'].iloc[-1] + (step + 1) // 24)) % 7
        
        next_row = np.zeros(len(features))
        next_row[0] = pred[0, 0]  # predicted volume (scaled)
        next_row[1] = next_hour / scaler.data_max_[1] if scaler.data_max_[1] > 0 else 0
        next_row[2] = 1 if next_day >= 5 else 0  # is_weekend
        next_row[3] = 1 if next_hour in [7,8,9,17,18,19] else 0  # is_rush_hour
        next_row[4] = 0  # is_holiday
        # Use median weather values
        next_row[5] = (30 - scaler.data_min_[5]) / (scaler.data_max_[5] - scaler.data_min_[5] + 1e-9)
        next_row[6] = 0  # rainfall
        next_row[7] = (10 - scaler.data_min_[7]) / (scaler.data_max_[7] - scaler.data_min_[7] + 1e-9)
        next_row[8] = (80 - scaler.data_min_[8]) / (scaler.data_max_[8] - scaler.data_min_[8] + 1e-9)
        next_row[9] = np.sin(2 * np.pi * next_hour / 24)
        next_row[10] = np.cos(2 * np.pi * next_hour / 24)
        next_row[11] = np.sin(2 * np.pi * next_day / 7)
        next_row[12] = np.cos(2 * np.pi * next_day / 7)
        # Scale cyclical features
        for idx in [9, 10, 11, 12]:
            if scaler.data_max_[idx] != scaler.data_min_[idx]:
                next_row[idx] = (next_row[idx] - scaler.data_min_[idx]) / (scaler.data_max_[idx] - scaler.data_min_[idx])
        
        future_predictions.append(pred[0, 0])
        
        # Slide window
        last_sequence = np.vstack([last_sequence[1:], next_row.reshape(1, -1)])
    
    # Inverse transform future predictions
    dummy_future = np.zeros((len(future_predictions), len(features)))
    dummy_future[:, 0] = future_predictions
    y_future = scaler.inverse_transform(dummy_future)[:, 0]
    y_future = np.clip(y_future, 0, None)  # No negative volumes
    
    # Future dates
    dates_future = pd.date_range(start=last_date + pd.Timedelta(hours=1), periods=future_hours, freq='h')
    
    # Load metrics
    with open(f'{METRICS_DIR}/wf_lstm_results.json', 'r') as f:
        lstm_metrics = json.load(f)['metrics']
    
    # Generate chart
    plot_forecast_chart(
        dates_train=dates_train,
        y_train_actual=df['total_volume'].values[:split_idx],
        dates_holdout=dates_holdout[:len(y_test_actual)],
        y_holdout_actual=y_test_actual,
        y_holdout_pred=y_pred_holdout[:len(y_test_actual)],
        dates_future=dates_future,
        y_future_pred=y_future,
        model_name='LSTM',
        target_label='Total Traffic Volume (Hourly)',
        y_label='Total Volume (vehicles/hour)',
        metrics_dict=lstm_metrics,
        filename='chart_lstm_volume_forecast.png',
        resample_rule='W'
    )
    
    tf.keras.backend.clear_session()
    print("  LSTM chart complete!")


# =====================================================================
# 2. XGBOOST SPEED FORECAST CHART
# =====================================================================
def generate_xgboost_chart():
    print("\n=== Generating XGBoost Speed Forecast Chart ===")
    
    df = pd.read_csv(DATASET_PATH)
    df.sort_values(by=['date_day', 'hour_of_day'], inplace=True)
    df = df.dropna(subset=['avg_speed_kmh']).copy()
    df.reset_index(drop=True, inplace=True)
    
    df['datetime'] = pd.to_datetime(df['date_day']) + pd.to_timedelta(df['hour_of_day'], unit='h')
    
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
    split_idx = int(n * 0.80)
    
    print(f"  Total rows: {n}, Train: {split_idx}, Test: {n - split_idx}")
    print(f"  Train period: {df['datetime'].iloc[0]} to {df['datetime'].iloc[split_idx-1]}")
    print(f"  Test period:  {df['datetime'].iloc[split_idx]} to {df['datetime'].iloc[-1]}")
    
    X_train = df[features].iloc[:split_idx]
    y_train = df[target].iloc[:split_idx]
    X_test = df[features].iloc[split_idx:]
    y_test = df[target].iloc[split_idx:]
    
    # Train XGBoost
    print("  Training XGBoost...")
    model = xgb.XGBRegressor(n_estimators=100, max_depth=6, learning_rate=0.1, random_state=42)
    model.fit(X_train, y_train)
    y_pred_holdout = model.predict(X_test)
    
    # Generate future forecast (6 months)
    print("  Generating 6-month future forecast...")
    last_date = pd.to_datetime(df['datetime'].iloc[-1])
    future_hours = 24 * 180
    
    future_preds = []
    last_speed_24 = list(df[target].values[-24:])
    last_speed_168 = list(df[target].values[-168:])
    
    for step in range(future_hours):
        next_hour = (df['hour_of_day'].iloc[-1] + step + 1) % 24
        next_day_num = (df['dow_num'].iloc[-1] + (step + 1) // 24) % 7
        
        row = {
            'hour_of_day': next_hour,
            'is_weekend': 1 if next_day_num >= 5 else 0,
            'is_rush_hour': 1 if next_hour in [7,8,9,17,18,19] else 0,
            'is_holiday': 0,
            'volume_class1': df['volume_class1'].median(),
            'volume_class2': df['volume_class2'].median(),
            'volume_class3': df['volume_class3'].median(),
            'total_volume': df['total_volume'].median(),
            'temperature': 30.0,
            'rainfall': 0.0,
            'wind_speed': 10.0,
            'humidity': 80.0,
            'lag_24h': last_speed_24[-24] if len(last_speed_24) >= 24 else df[target].median(),
            'lag_168h': last_speed_168[-168] if len(last_speed_168) >= 168 else df[target].median(),
            'hour_sin': np.sin(2 * np.pi * next_hour / 24),
            'hour_cos': np.cos(2 * np.pi * next_hour / 24),
            'dow_sin': np.sin(2 * np.pi * next_day_num / 7),
            'dow_cos': np.cos(2 * np.pi * next_day_num / 7),
        }
        
        pred = model.predict(pd.DataFrame([row]))[0]
        pred = max(pred, 0)
        future_preds.append(pred)
        last_speed_24.append(pred)
        last_speed_168.append(pred)
    
    dates_future = pd.date_range(start=last_date + pd.Timedelta(hours=1), periods=future_hours, freq='h')
    
    # Load metrics
    with open(f'{METRICS_DIR}/wf_xgboost_results.json', 'r') as f:
        xgb_metrics = json.load(f)['metrics']
    
    # Generate chart
    plot_forecast_chart(
        dates_train=df['datetime'].values[:split_idx],
        y_train_actual=df[target].values[:split_idx],
        dates_holdout=df['datetime'].values[split_idx:],
        y_holdout_actual=y_test.values,
        y_holdout_pred=y_pred_holdout,
        dates_future=dates_future,
        y_future_pred=np.array(future_preds),
        model_name='XGBoost',
        target_label='Average Speed (km/h) - Congestion',
        y_label='Average Speed (km/h)',
        metrics_dict=xgb_metrics,
        filename='chart_xgboost_speed_forecast.png',
        resample_rule='W'
    )
    
    print("  XGBoost chart complete!")


# =====================================================================
# MAIN
# =====================================================================
if __name__ == "__main__":
    print("=" * 60)
    print("  SMARTFLOW NLEX - FORECAST VISUALIZATION GENERATOR")
    print("=" * 60)
    
    generate_lstm_chart()
    generate_xgboost_chart()
    
    print("\n" + "=" * 60)
    print("  ALL FORECAST CHARTS GENERATED!")
    print("=" * 60)
    print(f"  Output: {OUT_DIR}/")
    print(f"    - chart_lstm_volume_forecast.png")
    print(f"    - chart_xgboost_speed_forecast.png")
