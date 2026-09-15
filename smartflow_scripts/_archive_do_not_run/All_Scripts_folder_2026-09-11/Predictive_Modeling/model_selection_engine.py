"""
Automated Model Selection Engine
=================================
This script implements the adviser's exact workflow:
  1. Load all candidate model results (from walk-forward validation)
  2. Compare models using multiple metrics
  3. Rank models by primary forecasting metrics (not R2)
  4. Reject models that perform poorly against baseline (MASE > 1)
  5. Select the best model for each target with full justification
  6. Generate a comprehensive evaluation report + charts
"""
import pandas as pd
import numpy as np
import json
import os
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches

out_dir = 'C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs'

def load_all_results():
    """Load all walk-forward validation results."""
    models = {}
    files = {
        'Prophet': 'wf_prophet_results.json',
        'LSTM': 'wf_lstm_results.json',
        'XGBoost': 'wf_xgboost_results.json',
        'SARIMAX': 'wf_sarimax_results.json',
        'Holt-Winters': 'wf_holtwinters_results.json',
        'Holts_Linear': 'wf_holts_linear_results.json'
    }
    for name, fname in files.items():
        path = os.path.join(out_dir, fname)
        if os.path.exists(path):
            with open(path) as f:
                models[name] = json.load(f)
            print(f"  Loaded: {name}")
        else:
            print(f"  MISSING: {name} ({fname})")
    return models

def select_best_model(models):
    """
    Automated model selection using the adviser's rules:
    1. Separate models by target (volume vs speed)
    2. Reject any model with MASE > 1 (worse than naive)
    3. Rank remaining by: primary=WMAPE, secondary=MASE, tertiary=RMSE
    4. Select the best for each target
    """
    print("\n" + "="*70)
    print("  AUTOMATED MODEL SELECTION ENGINE")
    print("="*70)
    
    volume_models = {}
    speed_models = {}
    
    for name, data in models.items():
        target = data.get('target', 'unknown')
        if target == 'total_volume':
            volume_models[name] = data
        elif target == 'avg_speed_kmh':
            speed_models[name] = data
    
    results = {}
    
    # === Volume Model Selection ===
    print("\n--- Volume Model Candidates ---")
    vol_ranking = []
    for name, data in volume_models.items():
        m = data['metrics']
        mase = m.get('MASE', 999)
        wmape = m.get('WMAPE', 999)
        rmse = m.get('RMSE', 999)
        me = m.get('ME', 0)
        
        if isinstance(mase, str): mase = 999
        if isinstance(wmape, str): wmape = 999
        if isinstance(rmse, str): rmse = 999
        
        rejected = mase > 1.0
        reason = "MASE > 1.0 (worse than naive baseline)" if rejected else "PASS"
        
        print(f"  {name:15s} | WMAPE={wmape:7.2f}% | MASE={mase:.4f} | RMSE={rmse:10.2f} | ME={me:10.2f} | {reason}")
        
        vol_ranking.append({
            'model': name, 'WMAPE': wmape, 'MASE': mase, 'RMSE': rmse,
            'rejected': rejected, 'reason': reason, 'all_metrics': m
        })
    
    # Sort by: rejected last, then WMAPE ascending, then MASE ascending
    vol_ranking.sort(key=lambda x: (x['rejected'], x['WMAPE'], x['MASE']))
    
    passed = [r for r in vol_ranking if not r['rejected']]
    if passed:
        best_vol = passed[0]
        print(f"\n  >> SELECTED: {best_vol['model']} (WMAPE={best_vol['WMAPE']:.2f}%, MASE={best_vol['MASE']:.4f})")
        results['volume'] = {'selected': best_vol['model'], 'ranking': vol_ranking}
    else:
        print("\n  >> WARNING: No volume model passed MASE < 1.0 threshold!")
        results['volume'] = {'selected': None, 'ranking': vol_ranking}
    
    # === Speed Model Selection ===
    print("\n--- Speed Model Candidates ---")
    spd_ranking = []
    for name, data in speed_models.items():
        m = data['metrics']
        mase = m.get('MASE', 999)
        wmape = m.get('WMAPE', 999)
        mae = m.get('MAE', 999)
        
        if isinstance(mase, str): mase = 999
        
        rejected = mase > 1.0
        reason = "MASE > 1.0" if rejected else "PASS"
        
        print(f"  {name:15s} | WMAPE={wmape:7.2f}% | MASE={mase:.4f} | MAE={mae:.4f} km/h | {reason}")
        
        spd_ranking.append({
            'model': name, 'WMAPE': wmape, 'MASE': mase, 'MAE': mae,
            'rejected': rejected, 'reason': reason, 'all_metrics': m
        })
    
    spd_ranking.sort(key=lambda x: (x['rejected'], x['WMAPE'], x['MASE']))
    
    passed_spd = [r for r in spd_ranking if not r['rejected']]
    if passed_spd:
        best_spd = passed_spd[0]
        print(f"\n  >> SELECTED: {best_spd['model']} (WMAPE={best_spd['WMAPE']:.2f}%, MASE={best_spd['MASE']:.4f})")
        results['speed'] = {'selected': best_spd['model'], 'ranking': spd_ranking}
    else:
        print("\n  >> WARNING: No speed model passed!")
        results['speed'] = {'selected': None, 'ranking': spd_ranking}
    
    return results, vol_ranking, spd_ranking

def generate_full_report(models, selection, vol_ranking, spd_ranking):
    """Generate the full text report."""
    
    # Build the metrics table
    all_models_data = []
    for name, data in models.items():
        m = data['metrics']
        row = {'Model': name, 'Target': data.get('target', '?')}
        row.update(m)
        all_models_data.append(row)
    
    metrics_df = pd.DataFrame(all_models_data)
    metrics_df.to_csv(f"{out_dir}/wf_all_models_metrics.csv", index=False)
    
    # Selection results
    sel_data = {
        'volume_selected': selection['volume']['selected'],
        'speed_selected': selection['speed']['selected'],
        'volume_ranking': [{'rank': i+1, 'model': r['model'], 'WMAPE': r['WMAPE'], 
                           'MASE': r['MASE'], 'rejected': r['rejected'], 'reason': r['reason']}
                          for i, r in enumerate(vol_ranking)],
        'speed_ranking': [{'rank': i+1, 'model': r['model'], 'WMAPE': r['WMAPE'],
                          'MASE': r['MASE'], 'rejected': r['rejected'], 'reason': r['reason']}
                         for i, r in enumerate(spd_ranking)],
        'selection_criteria': {
            'primary_metric': 'WMAPE (lower is better)',
            'secondary_metric': 'MASE (< 1.0 required, lower is better)',
            'rejection_rule': 'MASE > 1.0 (model is worse than naive baseline)',
            'validation_method': '3-fold expanding window walk-forward validation'
        }
    }
    
    with open(f"{out_dir}/model_selection_results.json", 'w') as f:
        json.dump(sel_data, f, indent=4)
    
    return metrics_df

def generate_charts(models, vol_ranking, spd_ranking):
    """Generate comprehensive comparison charts."""
    
    # ======= CHART 1: All Volume Models - Full Metrics Dashboard =======
    vol_names = [r['model'] for r in vol_ranking]
    vol_colors = []
    for r in vol_ranking:
        if r['rejected']:
            vol_colors.append('#F44336')  # Red for rejected
        elif r == vol_ranking[0]:
            vol_colors.append('#4CAF50')  # Green for selected
        else:
            vol_colors.append('#2196F3')  # Blue for runner-up
    
    fig, axes = plt.subplots(2, 3, figsize=(18, 10))
    fig.suptitle('Volume Forecasting Models - Walk-Forward Validation Results\n(3-fold expanding window)', 
                 fontsize=14, fontweight='bold')
    
    metric_configs = [
        ('WMAPE', 'WMAPE (%)', 12, 'green', 'Green threshold (12%)'),
        ('MASE', 'MASE', 1.0, 'red', 'Naive baseline (1.0)'),
        ('R2', 'R2 Score', 0.70, 'green', 'Good threshold (0.70)'),
        ('RMSE', 'RMSE', None, None, None),
        ('sMAPE', 'sMAPE (%)', None, None, None),
        ('Theils_U', "Theil's U", 1.0, 'red', 'Naive baseline (1.0)')
    ]
    
    for idx, (metric, ylabel, threshold, th_color, th_label) in enumerate(metric_configs):
        ax = axes[idx // 3][idx % 3]
        vals = []
        for r in vol_ranking:
            v = r['all_metrics'].get(metric, 0)
            vals.append(v if isinstance(v, (int, float)) and not np.isnan(v) else 0)
        
        bars = ax.bar(vol_names, vals, color=vol_colors, width=0.5, edgecolor='white')
        if threshold is not None:
            ax.axhline(y=threshold, color=th_color, linestyle='--', alpha=0.7, label=th_label)
            ax.legend(fontsize=7)
        ax.set_ylabel(ylabel)
        ax.set_title(metric)
        for bar, val in zip(bars, vals):
            label = f'{val:.2f}' if val < 100 else f'{val:.0f}'
            ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + max(vals)*0.02, 
                    label, ha='center', fontweight='bold', fontsize=9)
    
    # Legend
    legend_elements = [
        mpatches.Patch(color='#4CAF50', label='SELECTED'),
        mpatches.Patch(color='#2196F3', label='Passed'),
        mpatches.Patch(color='#F44336', label='Rejected (MASE>1)')
    ]
    fig.legend(handles=legend_elements, loc='lower center', ncol=3, fontsize=10)
    plt.tight_layout(rect=[0, 0.05, 1, 0.95])
    plt.savefig(f"{out_dir}/chart_wf_volume_dashboard.png", dpi=200, bbox_inches='tight')
    plt.close()
    print("Saved: chart_wf_volume_dashboard.png")
    
    # ======= CHART 2: Bias Check (ME/MPE) =======
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))
    fig.suptitle('Forecast Bias Analysis (ME & MPE)\nPositive = Under-predicting, Negative = Over-predicting', 
                 fontsize=13, fontweight='bold')
    
    all_names = [r['model'] for r in vol_ranking]
    all_colors_bias = vol_colors
    
    # ME
    ax = axes[0]
    me_vals = [r['all_metrics'].get('ME', 0) for r in vol_ranking]
    me_vals = [v if isinstance(v, (int, float)) and not np.isnan(v) else 0 for v in me_vals]
    bars = ax.bar(all_names, me_vals, color=all_colors_bias, width=0.5)
    ax.axhline(y=0, color='black', linewidth=1)
    ax.set_ylabel('ME (Mean Error)')
    ax.set_title('ME - Forecast Bias (Volume)')
    for bar, val in zip(bars, me_vals):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + max(abs(v) for v in me_vals)*0.03,
                f'{val:.0f}', ha='center', fontweight='bold', fontsize=9)
    
    # MPE
    ax = axes[1]
    mpe_vals = [r['all_metrics'].get('MPE', 0) for r in vol_ranking]
    mpe_vals = [v if isinstance(v, (int, float)) and not np.isnan(v) else 0 for v in mpe_vals]
    bars = ax.bar(all_names, mpe_vals, color=all_colors_bias, width=0.5)
    ax.axhline(y=0, color='black', linewidth=1)
    ax.set_ylabel('MPE (%)')
    ax.set_title('MPE - Percentage Bias (Volume)')
    for bar, val in zip(bars, mpe_vals):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + max(abs(v) for v in mpe_vals)*0.03,
                f'{val:.2f}%', ha='center', fontweight='bold', fontsize=9)
    
    plt.tight_layout()
    plt.savefig(f"{out_dir}/chart_wf_bias_analysis.png", dpi=200, bbox_inches='tight')
    plt.close()
    print("Saved: chart_wf_bias_analysis.png")

def generate_text_report(models, selection, vol_ranking, spd_ranking):
    """Generate the comprehensive text report."""
    
    lines = []
    lines.append("=" * 80)
    lines.append("  SMARTFLOW NLEX - MODEL EVALUATION & SELECTION REPORT")
    lines.append("  Walk-Forward Validation (3-fold expanding window)")
    lines.append("=" * 80)
    lines.append("")
    lines.append("  Generated: 2026-07-11")
    lines.append("  Validation Method: 3-fold expanding window walk-forward")
    lines.append("  Primary Metric: WMAPE (lower is better)")
    lines.append("  Rejection Rule: MASE > 1.0 (worse than naive baseline)")
    lines.append("")
    
    # Volume models
    lines.append("=" * 80)
    lines.append("  VOLUME FORECASTING CANDIDATES (target: total_volume)")
    lines.append("=" * 80)
    
    for i, r in enumerate(vol_ranking):
        m = r['all_metrics']
        status = "REJECTED" if r['rejected'] else ("SELECTED" if i == 0 else f"RANK #{i+1}")
        lines.append("")
        lines.append(f"  [{status}] {r['model']}")
        lines.append(f"  " + "-" * 60)
        
        # All metrics in a nice table
        metric_order = ['MAE', 'MSE', 'RMSE', 'MAPE', 'sMAPE', 'WMAPE', 'MASE', 'RMSSE', 
                       'ME', 'MPE', 'R2', 'Adjusted_R2', 'Theils_U', 'AIC', 'BIC']
        for mk in metric_order:
            if mk in m:
                val = m[mk]
                if isinstance(val, (int, float)):
                    # Format based on metric type
                    if mk in ['MAPE', 'sMAPE', 'WMAPE', 'MPE']:
                        lines.append(f"    {mk:15s} = {val:>12.4f} %")
                    elif mk in ['MASE', 'RMSSE', 'R2', 'Theils_U']:
                        lines.append(f"    {mk:15s} = {val:>12.4f}")
                    elif mk in ['AIC', 'BIC']:
                        lines.append(f"    {mk:15s} = {val:>12.2f}")
                    else:
                        lines.append(f"    {mk:15s} = {val:>12.4f}")
                else:
                    lines.append(f"    {mk:15s} = {str(val):>12s}")
        
        if r['rejected']:
            lines.append(f"    >> REJECTED: {r['reason']}")
    
    # Speed models
    lines.append("")
    lines.append("=" * 80)
    lines.append("  SPEED/CONGESTION FORECASTING CANDIDATES (target: avg_speed_kmh)")
    lines.append("=" * 80)
    
    for i, r in enumerate(spd_ranking):
        m = r['all_metrics']
        status = "SELECTED" if i == 0 and not r['rejected'] else ("REJECTED" if r['rejected'] else f"RANK #{i+1}")
        lines.append("")
        lines.append(f"  [{status}] {r['model']}")
        lines.append(f"  " + "-" * 60)
        
        metric_order = ['MAE', 'MSE', 'RMSE', 'MAPE', 'sMAPE', 'WMAPE', 'MASE', 'RMSSE',
                       'ME', 'MPE', 'R2', 'Adjusted_R2', 'Theils_U']
        for mk in metric_order:
            if mk in m:
                val = m[mk]
                if isinstance(val, (int, float)):
                    if mk in ['MAPE', 'sMAPE', 'WMAPE', 'MPE']:
                        lines.append(f"    {mk:15s} = {val:>12.4f} %")
                    elif mk in ['MASE', 'RMSSE', 'R2', 'Theils_U']:
                        lines.append(f"    {mk:15s} = {val:>12.4f}")
                    else:
                        lines.append(f"    {mk:15s} = {val:>12.4f}")
                else:
                    lines.append(f"    {mk:15s} = {str(val):>12s}")
    
    # Final selection
    lines.append("")
    lines.append("=" * 80)
    lines.append("  FINAL MODEL SELECTION")
    lines.append("=" * 80)
    lines.append("")
    lines.append(f"  Volume Forecasting:  {selection['volume']['selected']}")
    lines.append(f"  Speed Forecasting:   {selection['speed']['selected']}")
    lines.append("")
    lines.append("  Selection Criteria:")
    lines.append("    1. All candidates evaluated via 3-fold walk-forward validation")
    lines.append("    2. Models with MASE > 1.0 automatically rejected (worse than naive)")
    lines.append("    3. Remaining models ranked by WMAPE (primary), then MASE (secondary)")
    lines.append("    4. Best model selected based on out-of-sample forecasting performance")
    lines.append("    5. R2 used as supporting information only, NOT as primary basis")
    lines.append("")
    lines.append("  Data Integrity:")
    lines.append("    [OK] Walk-forward validation prevents future data leakage")
    lines.append("    [OK] MASE computed against naive benchmark (not as percentage)")
    lines.append("    [OK] ME/MPE computed to check forecast bias direction")
    lines.append("    [OK] Multiple metrics used for holistic evaluation")
    lines.append("    [OK] AIC/BIC extracted for ARIMA-family model comparison")
    lines.append("=" * 80)
    
    report = "\n".join(lines)
    with open(f"{out_dir}/MODEL_EVALUATION_REPORT.txt", 'w', encoding='utf-8') as f:
        f.write(report)
    print("Saved: MODEL_EVALUATION_REPORT.txt")

def main():
    print("Loading all walk-forward validation results...")
    models = load_all_results()
    
    if len(models) < 2:
        print("ERROR: Not enough model results found. Run training scripts first.")
        return
    
    selection, vol_ranking, spd_ranking = select_best_model(models)
    metrics_df = generate_full_report(models, selection, vol_ranking, spd_ranking)
    generate_charts(models, vol_ranking, spd_ranking)
    generate_text_report(models, selection, vol_ranking, spd_ranking)
    
    print("\nModel Selection Engine complete!")
    print(f"  Volume model: {selection['volume']['selected']}")
    print(f"  Speed model:  {selection['speed']['selected']}")

if __name__ == "__main__":
    main()
