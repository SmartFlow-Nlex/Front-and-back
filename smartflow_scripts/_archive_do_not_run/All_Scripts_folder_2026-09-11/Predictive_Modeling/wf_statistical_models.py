"""
Walk-forward validation for statistical models:
  - Holt-Winters Exponential Smoothing (NEW)
  - Holt's Linear Trend (NEW)
  - SARIMAX (retrained properly)
  
3-fold expanding window walk-forward validation.
Target: total_volume (hourly)
"""
import pandas as pd
import numpy as np
import json
import warnings
warnings.filterwarnings("ignore")

from statsmodels.tsa.holtwinters import ExponentialSmoothing
from statsmodels.tsa.statespace.sarimax import SARIMAX
from metrics_utils import compute_all_metrics

def load_data():
    df = pd.read_csv('C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs/traffic_speed_dataset.csv')
    df['date_time'] = pd.to_datetime(df['date_day']) + pd.to_timedelta(df['hour_of_day'], unit='h')
    df.sort_values(by='date_time', inplace=True)
    df = df.dropna(subset=['total_volume'])
    df = df[df['total_volume'] > 0].copy()
    df.reset_index(drop=True, inplace=True)
    return df

def walk_forward_split(df, n_folds=3):
    """Generate expanding window walk-forward splits."""
    n = len(df)
    test_size = int(n * 0.08)  # ~8% per fold
    min_train = int(n * 0.60)  # minimum 60% training
    
    splits = []
    for i in range(n_folds):
        train_end = min_train + i * test_size
        test_end = train_end + test_size
        if test_end > n:
            test_end = n
        if train_end >= n:
            break
        splits.append((0, train_end, train_end, min(test_end, n)))
    return splits

def train_holtwinters(df, splits):
    """Holt-Winters Exponential Smoothing with walk-forward."""
    print("\n=== HOLT-WINTERS EXPONENTIAL SMOOTHING ===")
    all_metrics = []
    
    for fold_i, (tr_start, tr_end, te_start, te_end) in enumerate(splits):
        print(f"  Fold {fold_i+1}: train [{tr_start}:{tr_end}], test [{te_start}:{te_end}]")
        y_train = df['total_volume'].values[tr_start:tr_end]
        y_test = df['total_volume'].values[te_start:te_end]
        
        # Use last 4320 hours (6 months) for speed — HW struggles with very long series
        y_train_hw = y_train[-4320:] if len(y_train) > 4320 else y_train
        
        try:
            model = ExponentialSmoothing(
                y_train_hw,
                trend='add',
                seasonal='add',
                seasonal_periods=24,  # daily seasonality
                initialization_method='estimated'
            )
            fit = model.fit(optimized=True)
            y_pred = fit.forecast(steps=len(y_test))
            y_pred = np.maximum(y_pred, 0)
            
            metrics = compute_all_metrics(y_test, y_pred, y_train=y_train_hw)
            all_metrics.append(metrics)
            print(f"    WMAPE={metrics['WMAPE']:.2f}%, MASE={metrics['MASE']:.4f}, R2={metrics['R2']:.4f}")
        except Exception as e:
            print(f"    ERROR: {e}")
    
    return average_metrics(all_metrics) if all_metrics else None

def train_holts_linear(df, splits):
    """Holt's Linear Trend (no seasonality) with walk-forward."""
    print("\n=== HOLT'S LINEAR TREND ===")
    all_metrics = []
    
    for fold_i, (tr_start, tr_end, te_start, te_end) in enumerate(splits):
        print(f"  Fold {fold_i+1}: train [{tr_start}:{tr_end}], test [{te_start}:{te_end}]")
        y_train = df['total_volume'].values[tr_start:tr_end]
        y_test = df['total_volume'].values[te_start:te_end]
        
        y_train_hl = y_train[-4320:] if len(y_train) > 4320 else y_train
        
        try:
            model = ExponentialSmoothing(
                y_train_hl,
                trend='add',
                seasonal=None,  # No seasonality — that's what makes it "Holt's Linear"
                initialization_method='estimated'
            )
            fit = model.fit(optimized=True)
            y_pred = fit.forecast(steps=len(y_test))
            y_pred = np.maximum(y_pred, 0)
            
            metrics = compute_all_metrics(y_test, y_pred, y_train=y_train_hl)
            all_metrics.append(metrics)
            print(f"    WMAPE={metrics['WMAPE']:.2f}%, MASE={metrics['MASE']:.4f}, R2={metrics['R2']:.4f}")
        except Exception as e:
            print(f"    ERROR: {e}")
    
    return average_metrics(all_metrics) if all_metrics else None

def train_sarimax(df, splits):
    """SARIMAX with walk-forward."""
    print("\n=== SARIMAX ===")
    all_metrics = []
    aic_bic = []
    
    exo_cols = ['is_weekend', 'is_rush_hour', 'is_holiday']
    
    for fold_i, (tr_start, tr_end, te_start, te_end) in enumerate(splits):
        print(f"  Fold {fold_i+1}: train [{tr_start}:{tr_end}], test [{te_start}:{te_end}]")
        
        # SARIMAX is slow — use last 3000 hours for training
        actual_tr_start = max(tr_start, tr_end - 3000)
        y_train = df['total_volume'].values[actual_tr_start:tr_end]
        X_train = df[exo_cols].values[actual_tr_start:tr_end]
        y_test = df['total_volume'].values[te_start:te_end]
        X_test = df[exo_cols].values[te_start:te_end]
        
        try:
            model = SARIMAX(
                y_train, exog=X_train,
                order=(1, 1, 1),
                seasonal_order=(1, 0, 1, 24),
                enforce_stationarity=False,
                enforce_invertibility=False
            )
            fit = model.fit(disp=False, maxiter=200)
            y_pred = fit.forecast(steps=len(y_test), exog=X_test)
            y_pred = np.maximum(y_pred, 0)
            
            metrics = compute_all_metrics(y_test, y_pred, y_train=y_train)
            metrics['AIC'] = round(float(fit.aic), 2)
            metrics['BIC'] = round(float(fit.bic), 2)
            aic_bic.append({'AIC': fit.aic, 'BIC': fit.bic})
            all_metrics.append(metrics)
            print(f"    WMAPE={metrics['WMAPE']:.2f}%, MASE={metrics['MASE']:.4f}, AIC={fit.aic:.0f}, BIC={fit.bic:.0f}")
        except Exception as e:
            print(f"    ERROR: {e}")
    
    result = average_metrics(all_metrics) if all_metrics else None
    if result and aic_bic:
        result['AIC'] = round(float(np.mean([x['AIC'] for x in aic_bic])), 2)
        result['BIC'] = round(float(np.mean([x['BIC'] for x in aic_bic])), 2)
    return result

def average_metrics(metrics_list):
    """Average metrics across walk-forward folds."""
    result = {}
    keys = metrics_list[0].keys()
    for k in keys:
        vals = [m[k] for m in metrics_list if isinstance(m.get(k), (int, float)) and not np.isnan(m[k])]
        if vals:
            result[k] = round(float(np.mean(vals)), 4)
        else:
            result[k] = "N/A"
    return result

def main():
    df = load_data()
    print(f"Dataset: {len(df)} rows, {df['date_time'].min()} to {df['date_time'].max()}")
    
    splits = walk_forward_split(df, n_folds=3)
    print(f"Walk-forward splits: {len(splits)} folds")
    
    out_dir = 'C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs'
    
    # 1. Holt-Winters
    hw_metrics = train_holtwinters(df, splits)
    if hw_metrics:
        result = {"model": "Holt-Winters", "target": "total_volume", "validation": "3-fold walk-forward", "metrics": hw_metrics}
        with open(f"{out_dir}/wf_holtwinters_results.json", 'w') as f:
            json.dump(result, f, indent=4)
        print("  Saved: wf_holtwinters_results.json")
    
    # 2. Holt's Linear
    hl_metrics = train_holts_linear(df, splits)
    if hl_metrics:
        result = {"model": "Holts_Linear", "target": "total_volume", "validation": "3-fold walk-forward", "metrics": hl_metrics}
        with open(f"{out_dir}/wf_holts_linear_results.json", 'w') as f:
            json.dump(result, f, indent=4)
        print("  Saved: wf_holts_linear_results.json")
    
    # 3. SARIMAX
    sx_metrics = train_sarimax(df, splits)
    if sx_metrics:
        result = {"model": "SARIMAX", "target": "total_volume", "validation": "3-fold walk-forward",
                  "order": "(1,1,1)", "seasonal_order": "(1,0,1,24)", "metrics": sx_metrics}
        with open(f"{out_dir}/wf_sarimax_results.json", 'w') as f:
            json.dump(result, f, indent=4)
        print("  Saved: wf_sarimax_results.json")
    
    print("\nStatistical models complete!")

if __name__ == "__main__":
    main()
