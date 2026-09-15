"""
Walk-forward validation for Prophet.
3-fold expanding window. Target: total_volume.
"""
import pandas as pd
import numpy as np
import json
import logging
logging.getLogger('cmdstanpy').setLevel(logging.WARNING)
logging.getLogger('prophet').setLevel(logging.WARNING)

from prophet import Prophet
from metrics_utils import compute_all_metrics

def main():
    print("=== PROPHET (Walk-Forward) ===")
    df = pd.read_csv('C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs/traffic_speed_dataset.csv')
    df = df.dropna(subset=['total_volume'])
    df = df[df['total_volume'] > 0].copy()
    df['ds'] = pd.to_datetime(df['date_day']) + pd.to_timedelta(df['hour_of_day'], unit='h')
    df['y'] = df['total_volume']
    df.sort_values('ds', inplace=True)
    df.reset_index(drop=True, inplace=True)
    
    n = len(df)
    test_size = int(n * 0.08)
    min_train = int(n * 0.60)
    
    all_metrics = []
    for fold_i in range(3):
        tr_end = min_train + fold_i * test_size
        te_end = min(tr_end + test_size, n)
        if tr_end >= n: break
        
        train_df = df.iloc[:tr_end].copy()
        test_df = df.iloc[tr_end:te_end].copy()
        print(f"  Fold {fold_i+1}: train {len(train_df)} rows, test {len(test_df)} rows")
        
        model = Prophet(seasonality_mode='multiplicative', daily_seasonality=True,
                        weekly_seasonality=True, yearly_seasonality=True)
        model.add_regressor('is_weekend')
        model.add_regressor('is_rush_hour')
        model.add_regressor('is_holiday')
        model.add_regressor('temperature')
        model.add_regressor('rainfall')
        
        model.fit(train_df[['ds', 'y', 'is_weekend', 'is_rush_hour', 'is_holiday', 'temperature', 'rainfall']])
        forecast = model.predict(test_df[['ds', 'is_weekend', 'is_rush_hour', 'is_holiday', 'temperature', 'rainfall']])
        
        y_test = test_df['y'].values
        y_pred = np.maximum(forecast['yhat'].values, 0)
        y_train = train_df['y'].values
        
        metrics = compute_all_metrics(y_test, y_pred, y_train=y_train, n_features=5)
        all_metrics.append(metrics)
        print(f"    WMAPE={metrics['WMAPE']:.2f}%, MASE={metrics['MASE']:.4f}, R2={metrics['R2']:.4f}")
    
    # Average across folds
    avg = {}
    for k in all_metrics[0]:
        vals = [m[k] for m in all_metrics if isinstance(m.get(k), (int, float)) and not np.isnan(m[k])]
        avg[k] = round(float(np.mean(vals)), 4) if vals else "N/A"
    
    result = {"model": "Prophet", "target": "total_volume", "validation": "3-fold walk-forward", "metrics": avg}
    
    out_dir = 'C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs'
    with open(f"{out_dir}/wf_prophet_results.json", 'w') as f:
        json.dump(result, f, indent=4)
    
    print(f"\nProphet walk-forward complete! Saved: wf_prophet_results.json")
    print(json.dumps(avg, indent=2))

if __name__ == "__main__":
    main()
