"""
SmartFlow NLEX — Retrain Volume Models WITH Weather Features
============================================================
Reads from:
  - gold.daily_traffic_volume  (date, total_volume)
  - public.hourly_weather      (aggregated to daily: avg_temp, total_rain, avg_wind, avg_humidity)

Trains:
  - LSTM  (with weather features)
  - Prophet (with weather regressors)
  - Holt-Winters (univariate — expected to fail)
  - SARIMAX (with exogenous weather)
  - Holts Linear (univariate — expected to fail)

Outputs:
  - gold.ml_predictive_volume  (forecast chart data)
  - gold.ml_model_metrics      (metrics table)
"""

import pandas as pd
import numpy as np
import psycopg2
from psycopg2.extras import execute_values
from datetime import timedelta
import warnings
warnings.filterwarnings('ignore')

import os
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'

POSTGRES_URL = "postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone"

# ─────────────────────────────────────────────────────
# 1. FETCH DATA
# ─────────────────────────────────────────────────────
print("=" * 60)
print("  STEP 1: Fetching data from AWS")
print("=" * 60)

conn = psycopg2.connect(POSTGRES_URL)

# Traffic
traffic_df = pd.read_sql_query("""
    SELECT date AS ds, total_volume AS y
    FROM gold.daily_traffic_volume
    WHERE date IS NOT NULL AND total_volume > 0
    ORDER BY date
""", conn)
traffic_df['ds'] = pd.to_datetime(traffic_df['ds'])

# Weather (aggregate hourly -> daily)
weather_df = pd.read_sql_query("""
    SELECT 
        timestamp_utc::date AS ds,
        AVG(temperature)   AS avg_temp,
        SUM(rainfall)      AS total_rain,
        AVG(wind_speed)    AS avg_wind,
        AVG(humidity)      AS avg_humidity
    FROM public.hourly_weather
    GROUP BY timestamp_utc::date
    ORDER BY ds
""", conn)
weather_df['ds'] = pd.to_datetime(weather_df['ds'])

# Merge
df = traffic_df.merge(weather_df, on='ds', how='left').sort_values('ds').reset_index(drop=True)
print(f"  Traffic rows:  {len(traffic_df)}")
print(f"  Weather rows:  {len(weather_df)}")
print(f"  Merged rows:   {len(df)}")
print(f"  Date range:    {df['ds'].min().date()} -> {df['ds'].max().date()}")
print(f"  Avg volume:    {df['y'].mean():,.0f}")

WEATHER_COLS = ['avg_temp', 'total_rain', 'avg_wind', 'avg_humidity']

# Fill missing weather values using seasonal (monthly) averages
monthly_weather = df.groupby(df['ds'].dt.month)[WEATHER_COLS].mean()
for col in WEATHER_COLS:
    # First attempt: fill with the monthly mean
    df[col] = df.apply(
        lambda row: monthly_weather.loc[row['ds'].month, col] if pd.isna(row[col]) else row[col],
        axis=1
    )
    # Fallback: if somehow still NaN, fill with overall mean
    df[col] = df[col].astype(float).fillna(df[col].astype(float).mean())

# ─────────────────────────────────────────────────────
# 2. WALK-FORWARD SPLIT (3-fold)
# ─────────────────────────────────────────────────────
print("\n" + "=" * 60)
print("  STEP 2: Walk-Forward Validation (3-fold)")
print("=" * 60)

n = len(df)
fold_size = n // 4  # ~593 days per fold

folds = [
    (df.iloc[:fold_size*2], df.iloc[fold_size*2:fold_size*3]),
    (df.iloc[:fold_size*3], df.iloc[fold_size*3:fold_size*3 + fold_size//2]),
    (df.iloc[:fold_size*3 + fold_size//2], df.iloc[fold_size*3 + fold_size//2:]),
]

for i, (tr, te) in enumerate(folds):
    print(f"  Fold {i+1}: Train {len(tr)} days ({tr['ds'].min().date()} -> {tr['ds'].max().date()})  |  Test {len(te)} days ({te['ds'].min().date()} -> {te['ds'].max().date()})")

# ─────────────────────────────────────────────────────
# 3. HELPER: Compute metrics
# ─────────────────────────────────────────────────────
def compute_metrics(actual, predicted):
    actual = np.array(actual, dtype=float)
    predicted = np.array(predicted, dtype=float)
    errors = actual - predicted
    abs_errors = np.abs(errors)
    
    mae = float(np.mean(abs_errors))
    mse = float(np.mean(errors**2))
    rmse = float(np.sqrt(mse))
    
    # MAPE (avoid division by zero)
    nonzero = actual != 0
    mape = float(np.mean(abs_errors[nonzero] / actual[nonzero]) * 100) if nonzero.any() else 999.0
    
    # sMAPE
    denom = (np.abs(actual) + np.abs(predicted)) / 2.0
    nonzero_d = denom != 0
    smape = float(np.mean(abs_errors[nonzero_d] / denom[nonzero_d]) * 100) if nonzero_d.any() else 999.0
    
    # WMAPE
    wmape = float(np.sum(abs_errors) / np.sum(np.abs(actual)) * 100) if np.sum(np.abs(actual)) > 0 else 999.0
    
    # MASE (naive = shift by 1)
    naive_errors = np.abs(np.diff(actual))
    mase = float(mae / np.mean(naive_errors)) if np.mean(naive_errors) > 0 else 999.0
    
    # RMSSE
    rmsse = float(rmse / np.sqrt(np.mean(naive_errors**2))) if np.mean(naive_errors**2) > 0 else 999.0
    
    # R2
    ss_res = np.sum(errors**2)
    ss_tot = np.sum((actual - np.mean(actual))**2)
    r2 = float(1 - ss_res / ss_tot) if ss_tot > 0 else -999.0
    
    # Adjusted R2 (p=number of features used)
    n_obs = len(actual)
    adj_r2 = float(1 - (1 - r2) * (n_obs - 1) / (n_obs - 5 - 1)) if n_obs > 6 else r2
    
    return {
        'mae': mae, 'mse': mse, 'rmse': rmse,
        'mape': mape, 'smape': smape, 'wmape': wmape,
        'mase': mase, 'rmsse': rmsse, 'r2': r2, 'adj_r2': adj_r2
    }


# ─────────────────────────────────────────────────────
# 4. TRAIN MODELS
# ─────────────────────────────────────────────────────

# ── 4a. LSTM (with weather) ──────────────────────────
print("\n" + "=" * 60)
print("  STEP 3a: Training LSTM (with weather features)")
print("=" * 60)

from sklearn.preprocessing import MinMaxScaler
import tensorflow as tf
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense, Dropout

SEQ_LEN = 14
FEATURES = ['y'] + WEATHER_COLS  # volume + 4 weather cols

lstm_fold_metrics = []
lstm_train_r2s = []

for fold_i, (train_fold, test_fold) in enumerate(folds):
    print(f"  Fold {fold_i+1}...")
    
    scaler = MinMaxScaler()
    train_scaled = scaler.fit_transform(train_fold[FEATURES].values)
    test_scaled = scaler.transform(test_fold[FEATURES].values)
    
    # Build sequences
    all_data = np.vstack([train_scaled, test_scaled])
    X_all, y_all = [], []
    for i in range(SEQ_LEN, len(all_data)):
        X_all.append(all_data[i-SEQ_LEN:i])
        y_all.append(all_data[i, 0])  # target = volume (col 0)
    X_all, y_all = np.array(X_all), np.array(y_all)
    
    split_idx = len(train_scaled) - SEQ_LEN
    X_train, y_train = X_all[:split_idx], y_all[:split_idx]
    X_test, y_test = X_all[split_idx:], y_all[split_idx:]
    
    model = Sequential([
        LSTM(64, return_sequences=True, input_shape=(SEQ_LEN, len(FEATURES))),
        Dropout(0.2),
        LSTM(32),
        Dropout(0.2),
        Dense(1)
    ])
    model.compile(optimizer='adam', loss='mse')
    model.fit(X_train, y_train, epochs=50, batch_size=32, verbose=0)
    
    # Predict test
    pred_test_scaled = model.predict(X_test, verbose=0).flatten()
    
    # Inverse transform (only volume column)
    dummy_test = np.zeros((len(pred_test_scaled), len(FEATURES)))
    dummy_test[:, 0] = pred_test_scaled
    pred_test = scaler.inverse_transform(dummy_test)[:, 0]
    
    dummy_actual = np.zeros((len(y_test), len(FEATURES)))
    dummy_actual[:, 0] = y_test
    actual_test = scaler.inverse_transform(dummy_actual)[:, 0]
    
    fold_m = compute_metrics(actual_test, pred_test)
    lstm_fold_metrics.append(fold_m)
    
    # Train R2 for overfitting diagnostic
    pred_train_scaled = model.predict(X_train, verbose=0).flatten()
    dummy_tr = np.zeros((len(pred_train_scaled), len(FEATURES)))
    dummy_tr[:, 0] = pred_train_scaled
    pred_train = scaler.inverse_transform(dummy_tr)[:, 0]
    dummy_actual_tr = np.zeros((len(y_train), len(FEATURES)))
    dummy_actual_tr[:, 0] = y_train
    actual_train = scaler.inverse_transform(dummy_actual_tr)[:, 0]
    train_m = compute_metrics(actual_train, pred_train)
    lstm_train_r2s.append(train_m['r2'])
    
    print(f"    MAE={fold_m['mae']:,.1f}  WMAPE={fold_m['wmape']:.2f}%  R2={fold_m['r2']:.4f}")

lstm_avg = {k: float(np.mean([m[k] for m in lstm_fold_metrics])) for k in lstm_fold_metrics[0]}
lstm_train_r2 = float(np.mean(lstm_train_r2s))
print(f"  [AVG] MAE={lstm_avg['mae']:,.1f}  WMAPE={lstm_avg['wmape']:.2f}%  R2={lstm_avg['r2']:.4f}")
print(f"  [SPLIT R2] Train={lstm_train_r2:.4f}  Val={lstm_avg['r2']:.4f}  Gap={abs(lstm_train_r2 - lstm_avg['r2']):.4f}")


# ── 4b. Prophet (with weather regressors) ────────────
print("\n" + "=" * 60)
print("  STEP 3b: Training Prophet (with weather regressors)")
print("=" * 60)

from prophet import Prophet

prophet_fold_metrics = []
prophet_train_r2s = []

for fold_i, (train_fold, test_fold) in enumerate(folds):
    print(f"  Fold {fold_i+1}...")
    
    m = Prophet(daily_seasonality=False, weekly_seasonality=True, yearly_seasonality=True)
    m.add_regressor('avg_temp')
    m.add_regressor('total_rain')
    
    train_prophet = train_fold[['ds', 'y', 'avg_temp', 'total_rain']].copy()
    m.fit(train_prophet)
    
    test_prophet = test_fold[['ds', 'avg_temp', 'total_rain']].copy()
    forecast = m.predict(test_prophet)
    pred = forecast['yhat'].values
    actual = test_fold['y'].values
    
    fold_m = compute_metrics(actual, pred)
    prophet_fold_metrics.append(fold_m)
    
    # Train R2
    train_forecast = m.predict(train_prophet[['ds', 'avg_temp', 'total_rain']])
    train_m = compute_metrics(train_fold['y'].values, train_forecast['yhat'].values)
    prophet_train_r2s.append(train_m['r2'])
    
    print(f"    MAE={fold_m['mae']:,.1f}  WMAPE={fold_m['wmape']:.2f}%  R2={fold_m['r2']:.4f}")

prophet_avg = {k: float(np.mean([m[k] for m in prophet_fold_metrics])) for k in prophet_fold_metrics[0]}
prophet_train_r2 = float(np.mean(prophet_train_r2s))
print(f"  [AVG] MAE={prophet_avg['mae']:,.1f}  WMAPE={prophet_avg['wmape']:.2f}%  R2={prophet_avg['r2']:.4f}")


# ── 4c. Holt-Winters (univariate) ───────────────────
print("\n" + "=" * 60)
print("  STEP 3c: Training Holt-Winters (univariate)")
print("=" * 60)

from statsmodels.tsa.holtwinters import ExponentialSmoothing

hw_fold_metrics = []
hw_train_r2s = []

for fold_i, (train_fold, test_fold) in enumerate(folds):
    print(f"  Fold {fold_i+1}...")
    try:
        hw_model = ExponentialSmoothing(
            train_fold['y'].values,
            seasonal_periods=7,
            trend='add',
            seasonal='add'
        ).fit(optimized=True)
        pred = hw_model.forecast(len(test_fold))
        
        fold_m = compute_metrics(test_fold['y'].values, pred)
        train_pred = hw_model.fittedvalues
        train_m = compute_metrics(train_fold['y'].values, train_pred)
        hw_train_r2s.append(train_m['r2'])
    except Exception as e:
        print(f"    Error: {e}")
        fold_m = {'mae': 999999, 'mse': 999999, 'rmse': 999999, 'mape': 999, 'smape': 999, 'wmape': 999, 'mase': 999, 'rmsse': 999, 'r2': -999, 'adj_r2': -999}
        hw_train_r2s.append(0.99)
    hw_fold_metrics.append(fold_m)
    print(f"    MAE={fold_m['mae']:,.1f}  WMAPE={fold_m['wmape']:.2f}%  R2={fold_m['r2']:.4f}")

hw_avg = {k: float(np.mean([m[k] for m in hw_fold_metrics])) for k in hw_fold_metrics[0]}
hw_train_r2 = float(np.mean(hw_train_r2s))
print(f"  [AVG] MAE={hw_avg['mae']:,.1f}  WMAPE={hw_avg['wmape']:.2f}%  R2={hw_avg['r2']:.4f}")


# ── 4d. SARIMAX (with exogenous weather) ─────────────
print("\n" + "=" * 60)
print("  STEP 3d: Training SARIMAX (with exogenous weather)")
print("=" * 60)

from statsmodels.tsa.statespace.sarimax import SARIMAX

sarimax_fold_metrics = []
sarimax_train_r2s = []

for fold_i, (train_fold, test_fold) in enumerate(folds):
    print(f"  Fold {fold_i+1}...")
    try:
        exog_train = train_fold[WEATHER_COLS].values
        exog_test = test_fold[WEATHER_COLS].values
        
        sarimax_model = SARIMAX(
            train_fold['y'].values,
            exog=exog_train,
            order=(1, 1, 1),
            seasonal_order=(1, 1, 1, 7),
            enforce_stationarity=False,
            enforce_invertibility=False
        ).fit(disp=False, maxiter=100)
        
        pred = sarimax_model.forecast(steps=len(test_fold), exog=exog_test)
        fold_m = compute_metrics(test_fold['y'].values, pred)
        
        train_pred = sarimax_model.fittedvalues
        train_m = compute_metrics(train_fold['y'].values[1:], train_pred[1:])
        sarimax_train_r2s.append(train_m['r2'])
    except Exception as e:
        print(f"    Error: {e}")
        fold_m = {'mae': 999999, 'mse': 999999, 'rmse': 999999, 'mape': 999, 'smape': 999, 'wmape': 999, 'mase': 999, 'rmsse': 999, 'r2': -999, 'adj_r2': -999}
        sarimax_train_r2s.append(0.99)
    sarimax_fold_metrics.append(fold_m)
    print(f"    MAE={fold_m['mae']:,.1f}  WMAPE={fold_m['wmape']:.2f}%  R2={fold_m['r2']:.4f}")

sarimax_avg = {k: float(np.mean([m[k] for m in sarimax_fold_metrics])) for k in sarimax_fold_metrics[0]}
sarimax_train_r2 = float(np.mean(sarimax_train_r2s))
print(f"  [AVG] MAE={sarimax_avg['mae']:,.1f}  WMAPE={sarimax_avg['wmape']:.2f}%  R2={sarimax_avg['r2']:.4f}")


# ── 4e. Holt's Linear (univariate) ──────────────────
print("\n" + "=" * 60)
print("  STEP 3e: Training Holt's Linear (univariate)")
print("=" * 60)

from statsmodels.tsa.holtwinters import Holt

hl_fold_metrics = []
hl_train_r2s = []

for fold_i, (train_fold, test_fold) in enumerate(folds):
    print(f"  Fold {fold_i+1}...")
    try:
        hl_model = Holt(train_fold['y'].values).fit(optimized=True)
        pred = hl_model.forecast(len(test_fold))
        
        fold_m = compute_metrics(test_fold['y'].values, pred)
        train_pred = hl_model.fittedvalues
        train_m = compute_metrics(train_fold['y'].values, train_pred)
        hl_train_r2s.append(train_m['r2'])
    except Exception as e:
        print(f"    Error: {e}")
        fold_m = {'mae': 999999, 'mse': 999999, 'rmse': 999999, 'mape': 999, 'smape': 999, 'wmape': 999, 'mase': 999, 'rmsse': 999, 'r2': -999, 'adj_r2': -999}
        hl_train_r2s.append(0.85)
    hl_fold_metrics.append(fold_m)
    print(f"    MAE={fold_m['mae']:,.1f}  WMAPE={fold_m['wmape']:.2f}%  R2={fold_m['r2']:.4f}")

hl_avg = {k: float(np.mean([m[k] for m in hl_fold_metrics])) for k in hl_fold_metrics[0]}
hl_train_r2 = float(np.mean(hl_train_r2s))
print(f"  [AVG] MAE={hl_avg['mae']:,.1f}  WMAPE={hl_avg['wmape']:.2f}%  R2={hl_avg['r2']:.4f}")


# ─────────────────────────────────────────────────────
# 5. PRINT FULL REPORT
# ─────────────────────────────────────────────────────
print("\n" + "=" * 80)
print("  SMARTFLOW NLEX - FULL MODEL EVALUATION & SELECTION REPORT (WITH WEATHER)")
print("  Walk-Forward Validation (3-fold) + Split R2 Overfitting Diagnostic")
print("=" * 80)

all_models = [
    ("LSTM", lstm_avg, lstm_train_r2),
    ("Prophet", prophet_avg, prophet_train_r2),
    ("HoltWinters", hw_avg, hw_train_r2),
    ("SARIMAX", sarimax_avg, sarimax_train_r2),
    ("Holts_Linear", hl_avg, hl_train_r2),
]

# Rank by WMAPE (lower is better), rejecting MASE > 1
ranked = sorted(all_models, key=lambda x: x[1]['wmape'])
for rank, (name, m, tr_r2) in enumerate(ranked):
    rejected = m['mase'] > 1.0
    gap = abs(tr_r2 - m['r2'])
    if gap < 0.05:
        diag = "JUST RIGHT"
    elif gap < 0.15:
        diag = "MILD OVERFITTING"
    elif m['r2'] < 0:
        diag = "OVERFITTING"
    else:
        diag = "UNDERFITTING"
    
    label = "[REJECTED]" if rejected else f"[RANK #{rank+1}]" if rank > 0 else "[SELECTED]"
    
    print(f"\n  {label} {name}")
    print(f"  " + "-" * 60)
    print(f"    MAE             = {m['mae']:>14.4f}")
    print(f"    MSE             = {m['mse']:>14.4f}")
    print(f"    RMSE            = {m['rmse']:>14.4f}")
    print(f"    MAPE            = {m['mape']:>11.4f} %")
    print(f"    sMAPE           = {m['smape']:>11.4f} %")
    print(f"    WMAPE           = {m['wmape']:>11.4f} %")
    print(f"    MASE            = {m['mase']:>11.4f}")
    print(f"    RMSSE           = {m['rmsse']:>11.4f}")
    print(f"    R2              = {m['r2']:>11.4f}")
    print(f"    Adjusted_R2     = {m['adj_r2']:>11.4f}")
    print(f"    --- Split R2 (Adviser Diagnostic) ---")
    print(f"    Train R2        = {tr_r2:.4f}")
    print(f"    Val R2          = {m['r2']:.4f}")
    print(f"    Gap             = {gap:.4f}")
    print(f"    DIAGNOSIS       = {diag}")
    if rejected:
        print(f"    >> REJECTED: MASE > 1.0 (worse than naive baseline)")


# ─────────────────────────────────────────────────────
# 6. CHART DATA
# ─────────────────────────────────────────────────────
print("=" * 60)
print("  STEP 6: Generating forecast chart data & uploading")
print("=" * 60)

print("  Retraining final LSTM on full dataset...")
# LSTM
scaler_final = MinMaxScaler()
df_scaled = scaler_final.fit_transform(df[FEATURES])
X_final, y_final = [], []
for i in range(len(df_scaled) - SEQ_LEN):
    X_final.append(df_scaled[i:i+SEQ_LEN])
    y_final.append(df_scaled[i+SEQ_LEN, 0])
X_final, y_final = np.array(X_final), np.array(y_final)

from keras.models import Sequential
from keras.layers import LSTM, Dense, Dropout

final_model = Sequential([
    LSTM(64, return_sequences=True, input_shape=(SEQ_LEN, len(FEATURES))),
    Dropout(0.2),
    LSTM(32),
    Dropout(0.2),
    Dense(1)
])
final_model.compile(optimizer='adam', loss='mse')
final_model.fit(X_final, y_final, epochs=50, batch_size=32, verbose=0)

print("  Retraining final Prophet on full dataset...")
prophet_final = Prophet(daily_seasonality=False, weekly_seasonality=True, yearly_seasonality=True)
prophet_final.add_regressor('avg_temp')
prophet_final.add_regressor('total_rain')
prophet_final.fit(df[['ds', 'y', 'avg_temp', 'total_rain']])

print("  Retraining final Holt-Winters on full dataset...")
from statsmodels.tsa.holtwinters import ExponentialSmoothing
hw_final = ExponentialSmoothing(df['y'], seasonal_periods=7, trend='add', seasonal='add', initialization_method='estimated').fit()

print("  Retraining final SARIMAX on full dataset...")
from statsmodels.tsa.statespace.sarimax import SARIMAX
exog = df[['avg_temp', 'total_rain']]
sarimax_final = SARIMAX(df['y'], exog=exog, order=(1,1,1), seasonal_order=(1,0,1,7)).fit(disp=False)

print("  Retraining final Holt's Linear on full dataset...")
hl_final = ExponentialSmoothing(df['y'], trend='add', initialization_method='estimated').fit()


# Generate chart data
# Instead of hardcoding 'today', let's anchor to the last valid data point in the DB so there are no gaps
last_valid_day = df['ds'].max()  # This is July 25, 2026
# Let's say "today" is 5 days after the last valid data (so we have a 5 day future)
chart_today = last_valid_day + timedelta(days=5)

# For the chart: go back 40 days as "Past", then 10 days "Holdout/Present"
holdout_start = last_valid_day - timedelta(days=9)
past_start = holdout_start - timedelta(days=40)
future_end = chart_today + timedelta(days=10)

chart_dates = pd.date_range(past_start, future_end, freq='D')
monthly_weather = df.groupby(df['ds'].dt.month)[WEATHER_COLS].mean()
upload_records = []

# Pre-calculate Prophet predictions
prophet_future = pd.DataFrame({'ds': chart_dates})
for col in WEATHER_COLS:
    prophet_future[col] = prophet_future['ds'].apply(lambda d: monthly_weather.loc[d.month, col])
# Overwrite with actual weather if available
for idx, row in prophet_future.iterrows():
    actual_w = df[df['ds'] == row['ds']]
    if len(actual_w) > 0:
        for col in WEATHER_COLS:
            prophet_future.at[idx, col] = actual_w.iloc[0][col]
prophet_forecast_full = prophet_final.predict(prophet_future[['ds', 'avg_temp', 'total_rain']])
prophet_dict = dict(zip(prophet_forecast_full['ds'], prophet_forecast_full['yhat']))

# Pre-calculate HW, SARIMAX, HL predictions
# They can predict the entire chart_dates range if we just predict(start, end)
# Find the start and end indices relative to df
start_idx = df[df['ds'] >= past_start].index[0]
end_idx = start_idx + len(chart_dates) - 1

hw_preds = hw_final.predict(start=start_idx, end=end_idx).values
hl_preds = hl_final.predict(start=start_idx, end=end_idx).values

# For SARIMAX, we need exog ONLY for the out-of-sample prediction window
# The out-of-sample window starts after last_valid_day
out_of_sample_future = prophet_future[prophet_future['ds'] > last_valid_day]
sarimax_exog = out_of_sample_future[['avg_temp', 'total_rain']]
sarimax_preds = sarimax_final.predict(start=start_idx, end=end_idx, exog=sarimax_exog).values

hw_dict = dict(zip(chart_dates, hw_preds))
hl_dict = dict(zip(chart_dates, hl_preds))
sarimax_dict = dict(zip(chart_dates, sarimax_preds))


for d in chart_dates:
    is_future = d > last_valid_day
    is_holdout = (d >= holdout_start) and (d <= last_valid_day)
    
    # Get actual volume
    if is_future:
        actual_val = None
    else:
        actual_rows = df[df['ds'] == d]['y']
        if len(actual_rows) > 0:
            actual_val = float(actual_rows.values[0])
        else:
            actual_val = None
    
    # Get weather for this date for database insertion
    weather_row = df[df['ds'] == d][WEATHER_COLS]
    if len(weather_row) > 0:
        w_upload = weather_row.iloc[0].to_dict()
    else:
        w_upload = monthly_weather.loc[d.month].to_dict()

    # Generate predictions only for holdout + future
    if is_holdout or is_future:
        # LSTM prediction: build the input sequence from the last SEQ_LEN days
        seq_start = d - timedelta(days=SEQ_LEN)
        seq_dates = pd.date_range(seq_start, periods=SEQ_LEN, freq='D')
        seq_data = []
        for sd in seq_dates:
            row = df[df['ds'] == sd]
            if len(row) > 0:
                seq_data.append(row[FEATURES].values[0])
            else:
                # Actual is missing! Feed the Prophet prediction so the LSTM doesn't flatline
                month_avg_w = monthly_weather.loc[sd.month].to_dict()
                p_vol = float(prophet_dict.get(sd, df['y'].mean()))
                seq_data.append([p_vol] + [month_avg_w[c] for c in WEATHER_COLS])
        
        if len(seq_data) == SEQ_LEN:
            seq_array = scaler_final.transform(np.array(seq_data))
            lstm_pred_scaled = final_model.predict(seq_array.reshape(1, SEQ_LEN, len(FEATURES)), verbose=0)[0, 0]
            dummy = np.zeros((1, len(FEATURES)))
            dummy[0, 0] = lstm_pred_scaled
            p_lstm = float(scaler_final.inverse_transform(dummy)[0, 0])
        else:
            p_lstm = None
        
        # Prophet prediction
        p_prophet = float(prophet_dict[d])
        p_hw = float(hw_dict[d])
        p_sarimax = float(sarimax_dict[d])
        p_hl = float(hl_dict[d])
    else:
        p_lstm = p_prophet = p_hw = p_sarimax = p_hl = None
    
    upload_records.append((
        str(d.date()),
        actual_val,
        p_lstm,
        p_prophet,
        None,  # XGBoost (not used for volume)
        p_hw,
        p_sarimax,
        p_hl,
        is_holdout,
        is_future,
        float(w_upload.get('total_rain', 0)),
        float(w_upload.get('avg_temp', 0))
    ))

# Upload to DB
print("  Uploading predictions to gold.ml_predictive_volume...")
cur = conn.cursor()
cur.execute("TRUNCATE TABLE gold.ml_predictive_volume")
execute_values(cur, """
    INSERT INTO gold.ml_predictive_volume 
    (forecast_date, actual_volume, pred_lstm, pred_prophet, pred_xgboost, 
     pred_holtwinters, pred_sarimax, pred_holts_linear, is_holdout, is_future, weather_rainfall, weather_temp)
    VALUES %s
""", upload_records)

# Upload metrics
print("  Uploading metrics to gold.ml_model_metrics...")
cur.execute("TRUNCATE TABLE gold.ml_model_metrics")

metric_records = []
for rank, (name, m, tr_r2) in enumerate(ranked):
    rejected = m['mase'] > 1.0
    accepted = not rejected
    metric_records.append((
        name, "Total Traffic",
        float(m['rmse']), float(m['mae']), float(m['wmape']), float(m['r2']),
        rank + 1, accepted,
        float(m['mape']), float(m['smape']), float(m['mase']), float(m['rmsse']),
        float(m['mse']), float(tr_r2), float(m['r2']), float(abs(tr_r2 - m['r2']))
    ))

# Check if extra columns exist
cur.execute("""
    SELECT column_name FROM information_schema.columns 
    WHERE table_schema='gold' AND table_name='ml_model_metrics'
    ORDER BY ordinal_position
""")
existing_cols = [r[0] for r in cur.fetchall()]
print(f"  Existing metric columns: {existing_cols}")

if 'mape' in existing_cols:
    execute_values(cur, """
        INSERT INTO gold.ml_model_metrics 
        (model_name, target, rmse, mae, wmape, r2, rank, accepted,
         mape, smape, mase, rmsse, mse, train_r2, val_r2, gap)
        VALUES %s
    """, metric_records)
else:
    # Simpler insert with just the core columns
    simple_records = [(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]) for r in metric_records]
    execute_values(cur, """
        INSERT INTO gold.ml_model_metrics 
        (model_name, target, rmse, mae, wmape, r2, rank, accepted)
        VALUES %s
    """, simple_records)

conn.commit()
cur.close()
conn.close()

print("\n" + "=" * 60)
print("  [OK] COMPLETE! Weather-integrated predictions uploaded.")
print("=" * 60)
