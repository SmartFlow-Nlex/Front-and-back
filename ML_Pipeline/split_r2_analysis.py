"""
Split R² Analysis — Training vs Validation
=============================================
Your adviser's recommended diagnostic:
  - Compute R² on the TRAINING data (how well the model fits what it learned from)
  - Compute R² on the VALIDATION data (how well it predicts unseen data)
  - Compare them to diagnose: Overfitting, Underfitting, or Just Right

Interpretation:
  Train R² HIGH, Val R² HIGH, Gap SMALL   → Just Right (good generalization)
  Train R² HIGH, Val R² LOW,  Gap LARGE   → Overfitting (memorized training data)
  Train R² LOW,  Val R² LOW               → Underfitting (model too simple)
"""
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import pandas as pd
import numpy as np
import json
import os
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import warnings
warnings.filterwarnings('ignore')
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'

from sklearn.preprocessing import MinMaxScaler
from sklearn.metrics import r2_score
import xgboost as xgb

out_dir = 'C:/Users/Hans/.gemini/antigravity/scratch/predictive folder/training_and_testing_outputs'
data_path = 'C:/Users/Hans/.gemini/antigravity/scratch/predictive folder/training_and_testing_outputs/01_dataset/traffic_speed_dataset.csv'


# ═══════════════════════════════════════════════════════════════════════════════
#  LSTM — Volume Forecasting
# ═══════════════════════════════════════════════════════════════════════════════
def create_sequences(data, seq_length):
    X, y = [], []
    for i in range(len(data) - seq_length):
        X.append(data[i:i + seq_length])
        y.append(data[i + seq_length, 0])
    return np.array(X), np.array(y)


def split_r2_lstm():
    import tensorflow as tf
    from tensorflow.keras.models import Sequential
    from tensorflow.keras.layers import LSTM, Dense, Dropout

    print("=" * 70)
    print("  LSTM — Split R² (Training vs Validation)")
    print("=" * 70)

    df = pd.read_csv(data_path)
    df = df.dropna(subset=['total_volume'])
    df = df[df['total_volume'] > 0].copy()
    df.sort_values(by=['date_day', 'hour_of_day'], inplace=True)
    df.reset_index(drop=True, inplace=True)

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

    fold_results = []

    for fold_i in range(3):
        tr_end = min_train + fold_i * test_size
        te_end = min(tr_end + test_size, n)
        if tr_end >= n:
            break

        print(f"\n  Fold {fold_i+1}: train 0→{tr_end} ({tr_end} rows), val {tr_end}→{te_end} ({te_end - tr_end} rows)")

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

        # ── Training predictions ──
        train_preds_scaled = model.predict(X_train, verbose=0)
        dummy_tr = np.zeros((len(train_preds_scaled), len(features)))
        dummy_tr[:, 0] = train_preds_scaled.flatten()
        y_train_pred = scaler.inverse_transform(dummy_tr)[:, 0]

        dummy_tr_actual = np.zeros((len(y_train), len(features)))
        dummy_tr_actual[:, 0] = y_train
        y_train_actual = scaler.inverse_transform(dummy_tr_actual)[:, 0]

        train_r2 = r2_score(y_train_actual, y_train_pred)

        # ── Validation predictions ──
        val_preds_scaled = model.predict(X_test, verbose=0)
        dummy_val = np.zeros((len(val_preds_scaled), len(features)))
        dummy_val[:, 0] = val_preds_scaled.flatten()
        y_val_pred = scaler.inverse_transform(dummy_val)[:, 0]

        dummy_val_actual = np.zeros((len(y_test), len(features)))
        dummy_val_actual[:, 0] = y_test
        y_val_actual = scaler.inverse_transform(dummy_val_actual)[:, 0]

        val_r2 = r2_score(y_val_actual, y_val_pred)

        gap = train_r2 - val_r2
        print(f"    Train R² = {train_r2:.4f}")
        print(f"    Val R²   = {val_r2:.4f}")
        print(f"    Gap      = {gap:.4f}")

        fold_results.append({
            'fold': fold_i + 1,
            'train_r2': round(train_r2, 4),
            'val_r2': round(val_r2, 4),
            'gap': round(gap, 4)
        })
        tf.keras.backend.clear_session()

    avg_train = np.mean([f['train_r2'] for f in fold_results])
    avg_val = np.mean([f['val_r2'] for f in fold_results])
    avg_gap = avg_train - avg_val

    print(f"\n  ── LSTM Average Across 3 Folds ──")
    print(f"    Avg Train R² = {avg_train:.4f}")
    print(f"    Avg Val R²   = {avg_val:.4f}")
    print(f"    Avg Gap      = {avg_gap:.4f}")
    print(f"    Diagnosis    = {diagnose(avg_train, avg_val, avg_gap)}")

    return {
        'model': 'LSTM',
        'target': 'total_volume',
        'folds': fold_results,
        'avg_train_r2': round(avg_train, 4),
        'avg_val_r2': round(avg_val, 4),
        'avg_gap': round(avg_gap, 4),
        'diagnosis': diagnose(avg_train, avg_val, avg_gap)
    }


# ═══════════════════════════════════════════════════════════════════════════════
#  XGBOOST — Speed/Congestion Forecasting
# ═══════════════════════════════════════════════════════════════════════════════
def split_r2_xgboost():
    print("\n" + "=" * 70)
    print("  XGBoost — Split R² (Training vs Validation)")
    print("=" * 70)

    df = pd.read_csv(data_path)
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

    fold_results = []

    for fold_i in range(3):
        tr_end = min_train + fold_i * test_size
        te_end = min(tr_end + test_size, n)
        if tr_end >= n:
            break

        print(f"\n  Fold {fold_i+1}: train 0→{tr_end} ({tr_end} rows), val {tr_end}→{te_end} ({te_end - tr_end} rows)")

        X_train = df[features].iloc[:tr_end]
        y_train = df[target].iloc[:tr_end]
        X_test = df[features].iloc[tr_end:te_end]
        y_test = df[target].iloc[tr_end:te_end]

        model = xgb.XGBRegressor(n_estimators=100, max_depth=6, learning_rate=0.1, random_state=42)
        model.fit(X_train, y_train)

        # ── Training predictions ──
        y_train_pred = model.predict(X_train)
        train_r2 = r2_score(y_train, y_train_pred)

        # ── Validation predictions ──
        y_val_pred = model.predict(X_test)
        val_r2 = r2_score(y_test, y_val_pred)

        gap = train_r2 - val_r2
        print(f"    Train R² = {train_r2:.4f}")
        print(f"    Val R²   = {val_r2:.4f}")
        print(f"    Gap      = {gap:.4f}")

        fold_results.append({
            'fold': fold_i + 1,
            'train_r2': round(train_r2, 4),
            'val_r2': round(val_r2, 4),
            'gap': round(gap, 4)
        })

    avg_train = np.mean([f['train_r2'] for f in fold_results])
    avg_val = np.mean([f['val_r2'] for f in fold_results])
    avg_gap = avg_train - avg_val

    print(f"\n  ── XGBoost Average Across 3 Folds ──")
    print(f"    Avg Train R² = {avg_train:.4f}")
    print(f"    Avg Val R²   = {avg_val:.4f}")
    print(f"    Avg Gap      = {avg_gap:.4f}")
    print(f"    Diagnosis    = {diagnose(avg_train, avg_val, avg_gap)}")

    return {
        'model': 'XGBoost',
        'target': 'avg_speed_kmh',
        'folds': fold_results,
        'avg_train_r2': round(avg_train, 4),
        'avg_val_r2': round(avg_val, 4),
        'avg_gap': round(avg_gap, 4),
        'diagnosis': diagnose(avg_train, avg_val, avg_gap)
    }


# ═══════════════════════════════════════════════════════════════════════════════
#  PROPHET — Volume Forecasting (Rank #2)
# ═══════════════════════════════════════════════════════════════════════════════
def split_r2_prophet():
    import logging
    logging.getLogger('cmdstanpy').setLevel(logging.WARNING)
    logging.getLogger('prophet').setLevel(logging.WARNING)
    from prophet import Prophet

    print("\n" + "=" * 70)
    print("  Prophet — Split R² (Training vs Validation)")
    print("=" * 70)

    df = pd.read_csv(data_path)
    df = df.dropna(subset=['total_volume'])
    df = df[df['total_volume'] > 0].copy()
    df['ds'] = pd.to_datetime(df['date_day']) + pd.to_timedelta(df['hour_of_day'], unit='h')
    df['y'] = df['total_volume']
    df.sort_values('ds', inplace=True)
    df.reset_index(drop=True, inplace=True)

    n = len(df)
    test_size = int(n * 0.08)
    min_train = int(n * 0.60)

    fold_results = []

    for fold_i in range(3):
        tr_end = min_train + fold_i * test_size
        te_end = min(tr_end + test_size, n)
        if tr_end >= n:
            break

        train_df = df.iloc[:tr_end].copy()
        test_df = df.iloc[tr_end:te_end].copy()
        print(f"\n  Fold {fold_i+1}: train {len(train_df)} rows, val {len(test_df)} rows")

        model = Prophet(seasonality_mode='multiplicative', daily_seasonality=True,
                        weekly_seasonality=True, yearly_seasonality=True)
        model.add_regressor('is_weekend')
        model.add_regressor('is_rush_hour')
        model.add_regressor('is_holiday')
        model.add_regressor('temperature')
        model.add_regressor('rainfall')

        cols = ['ds', 'y', 'is_weekend', 'is_rush_hour', 'is_holiday', 'temperature', 'rainfall']
        model.fit(train_df[cols])

        # ── Training predictions (in-sample) ──
        train_forecast = model.predict(train_df[['ds', 'is_weekend', 'is_rush_hour', 'is_holiday', 'temperature', 'rainfall']])
        y_train_pred = np.maximum(train_forecast['yhat'].values, 0)
        y_train_actual = train_df['y'].values
        train_r2 = r2_score(y_train_actual, y_train_pred)

        # ── Validation predictions (out-of-sample) ──
        val_forecast = model.predict(test_df[['ds', 'is_weekend', 'is_rush_hour', 'is_holiday', 'temperature', 'rainfall']])
        y_val_pred = np.maximum(val_forecast['yhat'].values, 0)
        y_val_actual = test_df['y'].values
        val_r2 = r2_score(y_val_actual, y_val_pred)

        gap = train_r2 - val_r2
        print(f"    Train R² = {train_r2:.4f}")
        print(f"    Val R²   = {val_r2:.4f}")
        print(f"    Gap      = {gap:.4f}")

        fold_results.append({
            'fold': fold_i + 1,
            'train_r2': round(train_r2, 4),
            'val_r2': round(val_r2, 4),
            'gap': round(gap, 4)
        })

    avg_train = np.mean([f['train_r2'] for f in fold_results])
    avg_val = np.mean([f['val_r2'] for f in fold_results])
    avg_gap = avg_train - avg_val

    print(f"\n  ── Prophet Average Across 3 Folds ──")
    print(f"    Avg Train R² = {avg_train:.4f}")
    print(f"    Avg Val R²   = {avg_val:.4f}")
    print(f"    Avg Gap      = {avg_gap:.4f}")
    print(f"    Diagnosis    = {diagnose(avg_train, avg_val, avg_gap)}")

    return {
        'model': 'Prophet',
        'target': 'total_volume',
        'folds': fold_results,
        'avg_train_r2': round(avg_train, 4),
        'avg_val_r2': round(avg_val, 4),
        'avg_gap': round(avg_gap, 4),
        'diagnosis': diagnose(avg_train, avg_val, avg_gap)
    }


# ═══════════════════════════════════════════════════════════════════════════════
#  DIAGNOSIS FUNCTION
# ═══════════════════════════════════════════════════════════════════════════════
def diagnose(train_r2, val_r2, gap):
    """
    Diagnose model fit based on training vs validation R².
    """
    if train_r2 < 0.50 and val_r2 < 0.50:
        return "UNDERFITTING — Both Train and Val R² are low. Model is too simple or target has high noise."
    elif gap > 0.15:
        return "OVERFITTING — Large gap between Train R² and Val R². Model memorized training data."
    elif gap > 0.05:
        return "MILD OVERFITTING — Moderate gap. Consider regularization or more data."
    elif train_r2 > 0.70 and val_r2 > 0.70 and gap <= 0.05:
        return "JUST RIGHT — Both R² are high with a small gap. Excellent generalization!"
    elif val_r2 >= 0 and gap <= 0.05:
        return "ACCEPTABLE — Small gap indicates good generalization relative to achievable performance."
    else:
        return "INCONCLUSIVE — Review per-fold details."


# ═══════════════════════════════════════════════════════════════════════════════
#  CHART GENERATION
# ═══════════════════════════════════════════════════════════════════════════════
def generate_split_r2_chart(all_results):
    """Generate a grouped bar chart comparing Train R² vs Val R² for each model."""

    fig, axes = plt.subplots(1, 2, figsize=(16, 7))
    fig.suptitle('Split R² Analysis — Training vs Validation\n(Adviser-Recommended Overfitting Diagnostic)',
                 fontsize=14, fontweight='bold')

    # ─── Chart 1: Per-Fold Breakdown ───
    ax = axes[0]
    all_bars = []
    x_labels = []
    train_vals = []
    val_vals = []

    for res in all_results:
        for fold in res['folds']:
            label = f"{res['model']}\nFold {fold['fold']}"
            x_labels.append(label)
            train_vals.append(fold['train_r2'])
            val_vals.append(fold['val_r2'])

    x = np.arange(len(x_labels))
    width = 0.35
    bars1 = ax.bar(x - width/2, train_vals, width, label='Train R²', color='#2196F3', edgecolor='white')
    bars2 = ax.bar(x + width/2, val_vals, width, label='Val R²', color='#FF9800', edgecolor='white')

    # Add value labels
    for bar in bars1:
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.01,
                f'{bar.get_height():.3f}', ha='center', fontsize=8, fontweight='bold')
    for bar in bars2:
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.01,
                f'{bar.get_height():.3f}', ha='center', fontsize=8, fontweight='bold')

    ax.set_xticks(x)
    ax.set_xticklabels(x_labels, fontsize=8)
    ax.set_ylabel('R² Score')
    ax.set_title('Per-Fold Train vs Val R²')
    ax.legend()
    ax.set_ylim(bottom=min(min(val_vals) - 0.1, 0), top=1.15)
    ax.axhline(y=1.0, color='gray', linestyle=':', alpha=0.5)

    # ─── Chart 2: Average Summary with Diagnosis ───
    ax2 = axes[1]
    model_names = [r['model'] for r in all_results]
    avg_trains = [r['avg_train_r2'] for r in all_results]
    avg_vals = [r['avg_val_r2'] for r in all_results]
    diagnoses = [r['diagnosis'].split('—')[0].strip() for r in all_results]

    x2 = np.arange(len(model_names))
    bars1 = ax2.bar(x2 - width/2, avg_trains, width, label='Avg Train R²', color='#2196F3', edgecolor='white')
    bars2 = ax2.bar(x2 + width/2, avg_vals, width, label='Avg Val R²', color='#FF9800', edgecolor='white')

    for bar in bars1:
        ax2.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.01,
                f'{bar.get_height():.4f}', ha='center', fontsize=9, fontweight='bold')
    for bar in bars2:
        ax2.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.01,
                f'{bar.get_height():.4f}', ha='center', fontsize=9, fontweight='bold')

    # Add diagnosis labels
    for i, diag in enumerate(diagnoses):
        color = '#4CAF50' if 'JUST RIGHT' in diag or 'ACCEPTABLE' in diag else '#F44336' if 'OVERFIT' in diag else '#FF9800'
        ax2.text(x2[i], max(avg_trains[i], avg_vals[i]) + 0.06, diag,
                ha='center', fontsize=10, fontweight='bold', color=color,
                bbox=dict(boxstyle='round,pad=0.3', facecolor=color, alpha=0.15))

    ax2.set_xticks(x2)
    ax2.set_xticklabels(model_names, fontsize=11, fontweight='bold')
    ax2.set_ylabel('R² Score')
    ax2.set_title('Average Train vs Val R² (with Diagnosis)')
    ax2.legend()
    ax2.set_ylim(bottom=min(min(avg_vals) - 0.1, 0), top=1.30)

    plt.tight_layout()
    chart_path = f"{out_dir}/chart_split_r2_analysis.png"
    plt.savefig(chart_path, dpi=200, bbox_inches='tight')
    plt.close()
    print(f"\nSaved chart: {chart_path}")
    return chart_path


# ═══════════════════════════════════════════════════════════════════════════════
#  REPORT GENERATION
# ═══════════════════════════════════════════════════════════════════════════════
def generate_report(all_results):
    lines = []
    lines.append("=" * 80)
    lines.append("  SPLIT R² ANALYSIS — TRAINING vs VALIDATION")
    lines.append("  (Adviser-Recommended Overfitting Diagnostic)")
    lines.append("=" * 80)
    lines.append("")
    lines.append("  Methodology:")
    lines.append("    - For each model, we compute R² on TRAINING data and VALIDATION data separately")
    lines.append("    - This is done for each of the 3 walk-forward folds")
    lines.append("    - The GAP (Train R² - Val R²) reveals overfitting behavior")
    lines.append("")
    lines.append("  Interpretation Key:")
    lines.append("    Train R² HIGH + Val R² HIGH + Gap SMALL  → JUST RIGHT")
    lines.append("    Train R² HIGH + Val R² LOW  + Gap LARGE  → OVERFITTING")
    lines.append("    Train R² LOW  + Val R² LOW               → UNDERFITTING")
    lines.append("")

    for res in all_results:
        lines.append("-" * 80)
        lines.append(f"  MODEL: {res['model']}  |  TARGET: {res['target']}")
        lines.append("-" * 80)
        for fold in res['folds']:
            lines.append(f"    Fold {fold['fold']}:  Train R² = {fold['train_r2']:.4f}  |  Val R² = {fold['val_r2']:.4f}  |  Gap = {fold['gap']:.4f}")
        lines.append("")
        lines.append(f"    ╔══════════════════════════════════════════════════╗")
        lines.append(f"    ║  Avg Train R² = {res['avg_train_r2']:.4f}                        ║")
        lines.append(f"    ║  Avg Val R²   = {res['avg_val_r2']:.4f}                        ║")
        lines.append(f"    ║  Avg Gap      = {res['avg_gap']:.4f}                        ║")
        lines.append(f"    ║  DIAGNOSIS:  {res['diagnosis'][:40]:40s}║")
        lines.append(f"    ╚══════════════════════════════════════════════════╝")
        lines.append("")

    report = "\n".join(lines)
    report_path = f"{out_dir}/SPLIT_R2_REPORT.txt"
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write(report)
    print(f"Saved report: {report_path}")

    # Also save as JSON for programmatic use
    json_path = f"{out_dir}/split_r2_results.json"
    with open(json_path, 'w') as f:
        json.dump(all_results, f, indent=4)
    print(f"Saved JSON: {json_path}")


# ===============================================================================
#  MAIN
# ===============================================================================
def main():
    print("\n" + "=" * 70)
    print("  SPLIT R2 ANALYSIS - ADVISER-RECOMMENDED OVERFITTING DIAGNOSTIC")
    print("=" * 70 + "\n")

    all_results = []

    # 1. LSTM (Volume)
    lstm_result = split_r2_lstm()
    all_results.append(lstm_result)

    # 2. XGBoost (Speed)
    xgb_result = split_r2_xgboost()
    all_results.append(xgb_result)

    # 3. Prophet (Volume - Rank #2)
    prophet_result = split_r2_prophet()
    all_results.append(prophet_result)

    # Generate outputs
    print("\n" + "=" * 70)
    print("  GENERATING OUTPUTS")
    print("=" * 70)

    generate_split_r2_chart(all_results)
    generate_report(all_results)

    print("\n" + "=" * 70)
    print("  SPLIT R2 ANALYSIS COMPLETE!")
    print("=" * 70)
    for res in all_results:
        print(f"  {res['model']:12s} | Train R² = {res['avg_train_r2']:.4f} | Val R² = {res['avg_val_r2']:.4f} | Gap = {res['avg_gap']:.4f} | {res['diagnosis'].split('—')[0].strip()}")
    print("")


if __name__ == "__main__":
    main()
