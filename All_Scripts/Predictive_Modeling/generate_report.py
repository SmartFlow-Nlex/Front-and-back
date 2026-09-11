import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import json

out_dir = 'C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs'

# Load all 4 model results
with open(f"{out_dir}/model03_lstm_volume_results.json") as f:
    lstm = json.load(f)
with open(f"{out_dir}/model04_xgboost_speed_results.json") as f:
    xgb_res = json.load(f)
with open(f"{out_dir}/model02_prophet_volume_results.json") as f:
    prophet = json.load(f)
with open(f"{out_dir}/model01_sarimax_volume_results.json") as f:
    sarimax = json.load(f)

feat_imp = pd.read_csv(f"{out_dir}/model04_xgboost_speed_feature_importance.csv")

# ============================================================
# 1. Full 4-Model Comparison Table (CSV)
# ============================================================
comparison = pd.DataFrame({
    'Model': ['Prophet', 'LSTM', 'XGBoost', 'SARIMAX'],
    'Target': ['total_volume', 'total_volume', 'avg_speed_kmh', 'total_volume'],
    'Data Period': ['2020-2024 (5yr)', '2020-2024 (5yr)', '2022-2024 (3yr)', 'Last 6 months'],
    'Train Rows': [prophet['n_train'], '~49,000 seq', '28,793', sarimax['n_train']],
    'Test Rows': [prophet['n_test'], '~12,000 seq', '7,199', sarimax['n_test']],
    'R2': [f"{prophet['metrics']['R2']:.4f}", f"{lstm['metrics']['R2']:.4f}", f"{xgb_res['metrics']['R2']:.4f}", f"{sarimax['metrics']['R2']:.4f}"],
    'MAE': [f"{prophet['metrics']['MAE']:.2f}", f"{lstm['metrics']['MAE']:.2f}", f"{xgb_res['metrics']['MAE']:.2f} km/h", f"{sarimax['metrics']['MAE']:.2f}"],
    'RMSE': [f"{prophet['metrics']['RMSE']:.2f}", f"{lstm['metrics']['RMSE']:.2f}", f"{xgb_res['metrics']['RMSE']:.2f} km/h", f"{sarimax['metrics']['RMSE']:.2f}"],
    'WMAPE (%)': [f"{prophet['metrics']['WMAPE']:.2f}", f"{lstm['metrics']['WMAPE']:.2f}", f"{xgb_res['metrics']['WMAPE']:.2f}", f"{sarimax['metrics']['WMAPE']:.2f}"],
    'MASE': [f"{prophet['metrics']['MASE']:.4f}", f"{lstm['metrics']['MASE']:.4f}", f"{xgb_res['metrics']['MASE']:.4f}", f"{sarimax['metrics']['MASE']:.4f}"],
    'Verdict': [
        'BEST - Volume',
        'PASS - Volume',
        'PASS - Speed (low R2 expected)',
        'FAIL - Volume'
    ]
})
comparison.to_csv(f"{out_dir}/model_comparison_table_all4.csv", index=False)
print("Saved: model_comparison_table_all4.csv")

# ============================================================
# 2. Volume Models Comparison (Prophet vs LSTM vs SARIMAX)
# ============================================================
fig, axes = plt.subplots(1, 3, figsize=(18, 6))
fig.suptitle('Traffic Volume Forecasting - Model Comparison\n(Prophet vs LSTM vs SARIMAX)', fontsize=15, fontweight='bold', y=1.04)

colors = ['#4CAF50', '#2196F3', '#F44336']
model_names = ['Prophet', 'LSTM', 'SARIMAX']

# R2
ax = axes[0]
r2_vals = [prophet['metrics']['R2'], lstm['metrics']['R2'], sarimax['metrics']['R2']]
bars = ax.bar(model_names, r2_vals, color=colors, width=0.5, edgecolor='white', linewidth=1.5)
ax.axhline(y=0.70, color='green', linestyle='--', alpha=0.7, label='Good threshold (0.70)')
ax.set_ylabel('R2 Score')
ax.set_title('R2 (Coefficient of Determination)')
ax.set_ylim(0, 1.15)
ax.legend(fontsize=8)
for bar, val in zip(bars, r2_vals):
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.02, f'{val:.4f}', ha='center', fontweight='bold', fontsize=11)

# WMAPE
ax = axes[1]
wmape_vals = [prophet['metrics']['WMAPE'], lstm['metrics']['WMAPE'], sarimax['metrics']['WMAPE']]
bars = ax.bar(model_names, wmape_vals, color=colors, width=0.5, edgecolor='white', linewidth=1.5)
ax.axhline(y=12, color='green', linestyle='--', alpha=0.7, label='Green threshold (12%)')
ax.set_ylabel('WMAPE (%)')
ax.set_title('WMAPE (Weighted Mean Abs % Error)')
ax.set_ylim(0, 45)
ax.legend(fontsize=8)
for bar, val in zip(bars, wmape_vals):
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.5, f'{val:.2f}%', ha='center', fontweight='bold', fontsize=11)

# MASE
ax = axes[2]
mase_vals = [prophet['metrics']['MASE'], lstm['metrics']['MASE'], sarimax['metrics']['MASE']]
bars = ax.bar(model_names, mase_vals, color=colors, width=0.5, edgecolor='white', linewidth=1.5)
ax.axhline(y=1.0, color='red', linestyle='--', alpha=0.7, label='Naive baseline (1.0)')
ax.set_ylabel('MASE')
ax.set_title('MASE (Mean Abs Scaled Error)')
ax.set_ylim(0, 2.1)
ax.legend(fontsize=8)
for bar, val in zip(bars, mase_vals):
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.03, f'{val:.4f}', ha='center', fontweight='bold', fontsize=11)

plt.tight_layout()
plt.savefig(f"{out_dir}/chart_volume_models_comparison.png", dpi=200, bbox_inches='tight')
plt.close()
print("Saved: chart_volume_models_comparison.png")

# ============================================================
# 3. All 4 Models Summary Chart
# ============================================================
fig, axes = plt.subplots(2, 2, figsize=(14, 10))
fig.suptitle('SmartFlow NLEX - All 4 Traffic Models Evaluation Dashboard', fontsize=15, fontweight='bold')

all_names = ['Prophet\n(Volume)', 'LSTM\n(Volume)', 'XGBoost\n(Speed)', 'SARIMAX\n(Volume)']
all_colors = ['#4CAF50', '#2196F3', '#FF9800', '#F44336']

# R2
ax = axes[0][0]
r2_all = [prophet['metrics']['R2'], lstm['metrics']['R2'], xgb_res['metrics']['R2'], sarimax['metrics']['R2']]
bars = ax.bar(all_names, r2_all, color=all_colors, width=0.5, edgecolor='white')
ax.axhline(y=0.70, color='green', linestyle='--', alpha=0.7, label='Good (0.70)')
ax.set_ylabel('R2')
ax.set_title('R2 Score')
ax.set_ylim(0, 1.15)
ax.legend(fontsize=8)
for bar, val in zip(bars, r2_all):
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.02, f'{val:.3f}', ha='center', fontweight='bold', fontsize=10)

# WMAPE
ax = axes[0][1]
wmape_all = [prophet['metrics']['WMAPE'], lstm['metrics']['WMAPE'], xgb_res['metrics']['WMAPE'], sarimax['metrics']['WMAPE']]
bars = ax.bar(all_names, wmape_all, color=all_colors, width=0.5, edgecolor='white')
ax.axhline(y=12, color='green', linestyle='--', alpha=0.7, label='Green (12%)')
ax.set_ylabel('WMAPE (%)')
ax.set_title('WMAPE')
ax.set_ylim(0, 45)
ax.legend(fontsize=8)
for bar, val in zip(bars, wmape_all):
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.5, f'{val:.1f}%', ha='center', fontweight='bold', fontsize=10)

# MASE
ax = axes[1][0]
mase_all = [prophet['metrics']['MASE'], lstm['metrics']['MASE'], xgb_res['metrics']['MASE'], sarimax['metrics']['MASE']]
bars = ax.bar(all_names, mase_all, color=all_colors, width=0.5, edgecolor='white')
ax.axhline(y=1.0, color='red', linestyle='--', alpha=0.7, label='Naive baseline (1.0)')
ax.set_ylabel('MASE')
ax.set_title('MASE (< 1.0 = beats naive)')
ax.set_ylim(0, 2.1)
ax.legend(fontsize=8)
for bar, val in zip(bars, mase_all):
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.03, f'{val:.4f}', ha='center', fontweight='bold', fontsize=10)

# MAE
ax = axes[1][1]
mae_all = [prophet['metrics']['MAE'], lstm['metrics']['MAE'], xgb_res['metrics']['MAE'], sarimax['metrics']['MAE']]
bars = ax.bar(all_names, mae_all, color=all_colors, width=0.5, edgecolor='white')
ax.set_ylabel('MAE')
ax.set_title('MAE (Mean Absolute Error)')
ax.legend(fontsize=8)
for bar, val in zip(bars, mae_all):
    label = f'{val:.0f}' if val > 100 else f'{val:.2f}'
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + max(mae_all)*0.01, label, ha='center', fontweight='bold', fontsize=10)

plt.tight_layout()
plt.savefig(f"{out_dir}/chart_all4_models_dashboard.png", dpi=200, bbox_inches='tight')
plt.close()
print("Saved: chart_all4_models_dashboard.png")

# ============================================================
# 4. Model Selection Ranking Table
# ============================================================
ranking = pd.DataFrame({
    'Rank': [1, 2, 3, 4],
    'Model': ['Prophet', 'LSTM', 'XGBoost', 'SARIMAX'],
    'Target': ['Volume', 'Volume', 'Speed', 'Volume'],
    'WMAPE': [f"{prophet['metrics']['WMAPE']:.2f}%", f"{lstm['metrics']['WMAPE']:.2f}%", f"{xgb_res['metrics']['WMAPE']:.2f}%", f"{sarimax['metrics']['WMAPE']:.2f}%"],
    'MASE': [f"{prophet['metrics']['MASE']:.4f}", f"{lstm['metrics']['MASE']:.4f}", f"{xgb_res['metrics']['MASE']:.4f}", f"{sarimax['metrics']['MASE']:.4f}"],
    'R2': [f"{prophet['metrics']['R2']:.4f}", f"{lstm['metrics']['R2']:.4f}", f"{xgb_res['metrics']['R2']:.4f}", f"{sarimax['metrics']['R2']:.4f}"],
    'Selection': ['SELECTED (Best Volume)', 'Runner-up (Volume)', 'SELECTED (Best Speed)', 'Rejected (MASE > 1)']
})
ranking.to_csv(f"{out_dir}/model_selection_ranking.csv", index=False)
print("Saved: model_selection_ranking.csv")

# ============================================================
# 5. Updated Full Report
# ============================================================
report = """
================================================================================
      SMARTFLOW NLEX - TRAFFIC FORECASTING MODEL EVALUATION REPORT
================================================================================

Generated: 2026-07-11
Capstone Project: SmartFlow NLEX Traffic Intelligence System
Group: 3ISB Group 4

================================================================================
  VOLUME FORECASTING MODELS (target: total_volume)
================================================================================

  Three models were trained to predict hourly total traffic volume across
  all NLEX toll plazas. The models are ranked by WMAPE (primary metric).

  --------------------------------------------------------------------------
  MODEL 1 (SELECTED): Prophet
  --------------------------------------------------------------------------
  Data Period:      2020-2024 (5 years, {n_train_p:,} training rows)
  Seasonality:      Daily + Weekly + Yearly (multiplicative)
  Regressors:       is_weekend, is_rush_hour, is_holiday, temperature, rainfall

  | Metric | Value          | Verdict                            |
  |--------|----------------|------------------------------------|
  | R2     | {r2_p:.4f}         | 97.3% variance explained           |
  | MAE    | {mae_p:,.2f} veh  | Avg error ~3,373 vehicles/hour     |
  | RMSE   | {rmse_p:,.2f} veh | Penalizes large deviations         |
  | WMAPE  | {wmape_p:.2f}%        | PASSES <= 12% green threshold      |
  | MASE   | {mase_p:.4f}        | 3.1x better than naive baseline    |

  --------------------------------------------------------------------------
  MODEL 2 (RUNNER-UP): LSTM
  --------------------------------------------------------------------------
  Data Period:      2020-2024 (5 years, ~49,000 sequences)
  Architecture:     2-layer stacked LSTM (50 units) + Dropout (20%)
  Sequence Length:  24-hour sliding window, 13 input features

  | Metric | Value          | Verdict                            |
  |--------|----------------|------------------------------------|
  | R2     | {r2_l:.4f}         | 98.1% variance explained           |
  | MAE    | {mae_l:,.2f} veh  | Avg error ~3,085 vehicles/hour     |
  | RMSE   | {rmse_l:,.2f} veh | Penalizes large deviations         |
  | WMAPE  | {wmape_l:.2f}%        | PASSES <= 12% green threshold      |
  | MASE   | {mase_l:.4f}        | 2.1x better than naive baseline    |

  --------------------------------------------------------------------------
  MODEL 3 (REJECTED): SARIMAX
  --------------------------------------------------------------------------
  Data Period:      Last 6 months ({n_train_s:,} training hours)
  Order:            (1,1,1) with seasonal (1,0,1,24)
  Note:             Limited to 6 months due to computational constraints

  | Metric | Value           | Verdict                            |
  |--------|-----------------|------------------------------------|
  | R2     | {r2_s:.4f}          | Only 35.5% variance explained      |
  | MAE    | {mae_s:,.2f} veh   | Very high average error             |
  | RMSE   | {rmse_s:,.2f} veh  | Large deviations                    |
  | WMAPE  | {wmape_s:.2f}%         | FAILS > 12% threshold              |
  | MASE   | {mase_s:.4f}         | FAILS - worse than naive baseline  |

================================================================================
  SPEED/CONGESTION FORECASTING MODEL (target: avg_speed_kmh)
================================================================================

  --------------------------------------------------------------------------
  MODEL 4 (SELECTED): XGBoost
  --------------------------------------------------------------------------
  Data Period:      2022-2024 (3 years, 28,793 training rows)
  Algorithm:        XGBoost Regressor (100 trees, max_depth=6)
  Features:         18 (temporal, volume, weather, lag-24h, lag-168h)

  | Metric | Value          | Verdict                            |
  |--------|----------------|------------------------------------|
  | R2     | {r2_x:.4f}         | Low due to narrow speed variance*  |
  | MAE    | {mae_x:.2f} km/h   | Off by less than 2 km/h on avg     |
  | RMSE   | {rmse_x:.2f} km/h  | Moderate                           |
  | WMAPE  | {wmape_x:.2f}%       | Moderate                           |
  | MASE   | {mase_x:.4f}        | Beats naive baseline (< 1.0)       |

  * R2 Note: Globally-aggregated Waze speed has very low variance
    (~6-12 km/h range). The MAE of 1.89 km/h is operationally accurate.

  Top 5 Feature Importance:
    1. hour_of_day  33.0%   (Time of day is the dominant driver)
    2. hour_sin     15.3%   (Cyclical hour encoding)
    3. lag_168h      6.1%   (Weekly seasonality pattern)
    4. hour_cos      5.4%   (Cyclical complement)
    5. dow_cos       5.0%   (Day-of-week pattern)

================================================================================
  MODEL SELECTION SUMMARY
================================================================================

  | Rank | Model   | Target  | WMAPE  | MASE   | Decision          |
  |------|---------|---------|--------|--------|-------------------|
  |  1   | Prophet | Volume  | {wmape_p:.2f}% | {mase_p:.4f} | SELECTED (Volume) |
  |  2   | LSTM    | Volume  | {wmape_l:.2f}% | {mase_l:.4f} | Runner-up         |
  |  3   | XGBoost | Speed   | {wmape_x:.2f}% | {mase_x:.4f} | SELECTED (Speed)  |
  |  4   | SARIMAX | Volume  | {wmape_s:.2f}% | {mase_s:.4f} | REJECTED          |

  Final Selection:
    - Volume Forecasting:  Prophet (lowest WMAPE 6.74%, lowest MASE 0.327)
    - Speed Forecasting:   XGBoost (only speed model, MAE = 1.89 km/h)

================================================================================
  DATA INTEGRITY SAFEGUARDS
================================================================================

  [OK] Chronological 80/20 train/test split (no future data leakage)
  [OK] No lag_1h feature in XGBoost (prevents trivial copy-paste)
  [OK] Speed data left as NaN for 2020-2021 (not fabricated)
  [OK] MASE benchmark confirms Prophet, LSTM, XGBoost beat naive baseline
  [OK] WMAPE used over MAPE to handle near-zero overnight volumes
  [OK] SARIMAX correctly rejected (MASE > 1 = worse than naive)

================================================================================
""".format(
    n_train_p=prophet['n_train'],
    r2_p=prophet['metrics']['R2'], mae_p=prophet['metrics']['MAE'],
    rmse_p=prophet['metrics']['RMSE'], wmape_p=prophet['metrics']['WMAPE'],
    mase_p=prophet['metrics']['MASE'],
    r2_l=lstm['metrics']['R2'], mae_l=lstm['metrics']['MAE'],
    rmse_l=lstm['metrics']['RMSE'], wmape_l=lstm['metrics']['WMAPE'],
    mase_l=lstm['metrics']['MASE'],
    n_train_s=sarimax['n_train'],
    r2_s=sarimax['metrics']['R2'], mae_s=sarimax['metrics']['MAE'],
    rmse_s=sarimax['metrics']['RMSE'], wmape_s=sarimax['metrics']['WMAPE'],
    mase_s=sarimax['metrics']['MASE'],
    r2_x=xgb_res['metrics']['R2'], mae_x=xgb_res['metrics']['MAE'],
    rmse_x=xgb_res['metrics']['RMSE'], wmape_x=xgb_res['metrics']['WMAPE'],
    mase_x=xgb_res['metrics']['MASE']
)

with open(f"{out_dir}/MODEL_EVALUATION_REPORT.txt", 'w', encoding='utf-8') as f:
    f.write(report)
print("Saved: MODEL_EVALUATION_REPORT.txt")

print("\nAll 4-model presentation files generated successfully!")
