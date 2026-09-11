"""
Walk-forward validation for Incident Prediction Models (GLOBAL).
================================================================
Classification: has_incident (0/1)
  - XGBoost Classifier
  - Random Forest Classifier
  - Logistic Regression

Regression: incident_count
  - XGBoost Regressor
  - Random Forest Regressor

3-fold expanding window walk-forward validation.
Full 14+ metrics for regression, full classification metrics for classification.
"""
import pandas as pd
import numpy as np
import json
import os
import warnings
warnings.filterwarnings("ignore")

from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (accuracy_score, precision_score, recall_score, f1_score,
                             roc_auc_score, average_precision_score, brier_score_loss,
                             log_loss, confusion_matrix, classification_report,
                             mean_squared_error, mean_absolute_error, r2_score)
from sklearn.preprocessing import StandardScaler
import xgboost as xgb

# Add parent dir for metrics_utils
import sys
sys.path.insert(0, os.path.dirname(__file__))
from metrics_utils import compute_all_metrics

OUT_DIR = 'C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs/02_final_evaluation_walkforward'
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(f"{OUT_DIR}/incident_models", exist_ok=True)

def load_data():
    df = pd.read_csv('C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs/01_dataset/incident_dataset_global.csv')
    df['date_day'] = pd.to_datetime(df['date_day'])
    df.sort_values(['date_day', 'hour_of_day'], inplace=True)
    df.reset_index(drop=True, inplace=True)
    return df

def get_features(df):
    """Select feature columns for modeling."""
    feature_cols = [
        'hour_of_day', 'is_weekend', 'is_rush_hour', 'is_holiday',
        'total_volume', 'temperature', 'rainfall', 'wind_speed', 'humidity',
        'incidents_lag_24h', 'incidents_lag_168h'
    ]
    # Add volume classes if available
    for col in ['volume_class1', 'volume_class2', 'volume_class3']:
        if col in df.columns:
            feature_cols.append(col)
    # Add speed if available
    if 'avg_speed_kmh' in df.columns:
        feature_cols.append('avg_speed_kmh')
    if 'avg_jam_level' in df.columns:
        feature_cols.append('avg_jam_level')
    
    # Only keep columns that exist
    feature_cols = [c for c in feature_cols if c in df.columns]
    return feature_cols

def walk_forward_split(df, n_folds=3):
    n = len(df)
    test_size = int(n * 0.08)
    min_train = int(n * 0.60)
    splits = []
    for i in range(n_folds):
        tr_end = min_train + i * test_size
        te_end = min(tr_end + test_size, n)
        if tr_end >= n: break
        splits.append((0, tr_end, tr_end, te_end))
    return splits

def compute_classification_metrics(y_true, y_pred, y_proba):
    """Compute all classification metrics."""
    cm = confusion_matrix(y_true, y_pred)
    tn, fp, fn, tp = cm.ravel() if cm.size == 4 else (0, 0, 0, 0)
    
    metrics = {
        'Accuracy': round(float(accuracy_score(y_true, y_pred)), 4),
        'Precision': round(float(precision_score(y_true, y_pred, zero_division=0)), 4),
        'Recall': round(float(recall_score(y_true, y_pred, zero_division=0)), 4),
        'F1_Score': round(float(f1_score(y_true, y_pred, zero_division=0)), 4),
        'AUC_ROC': round(float(roc_auc_score(y_true, y_proba)), 4) if len(np.unique(y_true)) > 1 else 0,
        'AUC_PR': round(float(average_precision_score(y_true, y_proba)), 4) if len(np.unique(y_true)) > 1 else 0,
        'Brier_Score': round(float(brier_score_loss(y_true, y_proba)), 4),
        'Log_Loss': round(float(log_loss(y_true, y_proba)), 4),
        'True_Positives': int(tp),
        'False_Positives': int(fp),
        'True_Negatives': int(tn),
        'False_Negatives': int(fn),
        'Specificity': round(float(tn / (tn + fp)) if (tn + fp) > 0 else 0, 4),
    }
    return metrics

def avg_metrics(metrics_list):
    """Average metrics across folds."""
    result = {}
    for k in metrics_list[0]:
        vals = [m[k] for m in metrics_list if isinstance(m.get(k), (int, float)) and not (isinstance(m[k], float) and np.isnan(m[k]))]
        if vals:
            result[k] = round(float(np.mean(vals)), 4)
        else:
            result[k] = "N/A"
    return result

def train_classification_models(df, feature_cols, splits):
    """Train all classification models."""
    results = {}
    
    # 1. XGBoost Classifier
    print("\n=== XGBoost Classifier (has_incident) ===")
    all_metrics = []
    for fold_i, (tr_s, tr_e, te_s, te_e) in enumerate(splits):
        X_train = df[feature_cols].iloc[tr_s:tr_e].fillna(0)
        y_train = df['has_incident'].iloc[tr_s:tr_e]
        X_test = df[feature_cols].iloc[te_s:te_e].fillna(0)
        y_test = df['has_incident'].iloc[te_s:te_e]
        
        # Handle class imbalance
        scale_pos = (y_train == 0).sum() / max((y_train == 1).sum(), 1)
        
        model = xgb.XGBClassifier(n_estimators=100, max_depth=6, learning_rate=0.1,
                                   scale_pos_weight=scale_pos, random_state=42,
                                   eval_metric='logloss')
        model.fit(X_train, y_train)
        y_pred = model.predict(X_test)
        y_proba = model.predict_proba(X_test)[:, 1]
        
        metrics = compute_classification_metrics(y_test.values, y_pred, y_proba)
        all_metrics.append(metrics)
        print(f"  Fold {fold_i+1}: F1={metrics['F1_Score']:.4f}, AUC-ROC={metrics['AUC_ROC']:.4f}, Precision={metrics['Precision']:.4f}, Recall={metrics['Recall']:.4f}")
    
    avg = avg_metrics(all_metrics)
    # Save feature importance from last fold
    feat_imp = dict(zip(feature_cols, model.feature_importances_))
    results['XGBoost_Classifier'] = {
        'model': 'XGBoost Classifier', 'target': 'has_incident', 'task': 'classification',
        'validation': '3-fold walk-forward', 'metrics': avg, 'feature_importance': feat_imp
    }
    
    # 2. Random Forest Classifier
    print("\n=== Random Forest Classifier (has_incident) ===")
    all_metrics = []
    for fold_i, (tr_s, tr_e, te_s, te_e) in enumerate(splits):
        X_train = df[feature_cols].iloc[tr_s:tr_e].fillna(0)
        y_train = df['has_incident'].iloc[tr_s:tr_e]
        X_test = df[feature_cols].iloc[te_s:te_e].fillna(0)
        y_test = df['has_incident'].iloc[te_s:te_e]
        
        model = RandomForestClassifier(n_estimators=100, max_depth=10, 
                                        class_weight='balanced', random_state=42, n_jobs=-1)
        model.fit(X_train, y_train)
        y_pred = model.predict(X_test)
        y_proba = model.predict_proba(X_test)[:, 1]
        
        metrics = compute_classification_metrics(y_test.values, y_pred, y_proba)
        all_metrics.append(metrics)
        print(f"  Fold {fold_i+1}: F1={metrics['F1_Score']:.4f}, AUC-ROC={metrics['AUC_ROC']:.4f}, Precision={metrics['Precision']:.4f}, Recall={metrics['Recall']:.4f}")
    
    avg = avg_metrics(all_metrics)
    results['RandomForest_Classifier'] = {
        'model': 'Random Forest Classifier', 'target': 'has_incident', 'task': 'classification',
        'validation': '3-fold walk-forward', 'metrics': avg
    }
    
    # 3. Logistic Regression
    print("\n=== Logistic Regression (has_incident) ===")
    all_metrics = []
    for fold_i, (tr_s, tr_e, te_s, te_e) in enumerate(splits):
        X_train = df[feature_cols].iloc[tr_s:tr_e].fillna(0)
        y_train = df['has_incident'].iloc[tr_s:tr_e]
        X_test = df[feature_cols].iloc[te_s:te_e].fillna(0)
        y_test = df['has_incident'].iloc[te_s:te_e]
        
        scaler = StandardScaler()
        X_train_scaled = scaler.fit_transform(X_train)
        X_test_scaled = scaler.transform(X_test)
        
        model = LogisticRegression(class_weight='balanced', max_iter=1000, random_state=42)
        model.fit(X_train_scaled, y_train)
        y_pred = model.predict(X_test_scaled)
        y_proba = model.predict_proba(X_test_scaled)[:, 1]
        
        metrics = compute_classification_metrics(y_test.values, y_pred, y_proba)
        all_metrics.append(metrics)
        print(f"  Fold {fold_i+1}: F1={metrics['F1_Score']:.4f}, AUC-ROC={metrics['AUC_ROC']:.4f}, Precision={metrics['Precision']:.4f}, Recall={metrics['Recall']:.4f}")
    
    avg = avg_metrics(all_metrics)
    results['Logistic_Regression'] = {
        'model': 'Logistic Regression', 'target': 'has_incident', 'task': 'classification',
        'validation': '3-fold walk-forward', 'metrics': avg
    }
    
    return results

def train_regression_models(df, feature_cols, splits):
    """Train all regression models for incident count."""
    results = {}
    
    # 1. XGBoost Regressor
    print("\n=== XGBoost Regressor (incident_count) ===")
    all_metrics = []
    for fold_i, (tr_s, tr_e, te_s, te_e) in enumerate(splits):
        X_train = df[feature_cols].iloc[tr_s:tr_e].fillna(0)
        y_train = df['incident_count'].iloc[tr_s:tr_e]
        X_test = df[feature_cols].iloc[te_s:te_e].fillna(0)
        y_test = df['incident_count'].iloc[te_s:te_e]
        
        model = xgb.XGBRegressor(n_estimators=100, max_depth=6, learning_rate=0.1, random_state=42)
        model.fit(X_train, y_train)
        y_pred = np.maximum(model.predict(X_test), 0)
        
        metrics = compute_all_metrics(y_test.values, y_pred, y_train=y_train.values, n_features=len(feature_cols))
        all_metrics.append(metrics)
        print(f"  Fold {fold_i+1}: WMAPE={metrics['WMAPE']:.2f}%, MASE={metrics['MASE']:.4f}, MAE={metrics['MAE']:.4f}")
    
    avg = avg_metrics(all_metrics)
    results['XGBoost_Regressor'] = {
        'model': 'XGBoost Regressor', 'target': 'incident_count', 'task': 'regression',
        'validation': '3-fold walk-forward', 'metrics': avg
    }
    
    # 2. Random Forest Regressor
    print("\n=== Random Forest Regressor (incident_count) ===")
    all_metrics = []
    for fold_i, (tr_s, tr_e, te_s, te_e) in enumerate(splits):
        X_train = df[feature_cols].iloc[tr_s:tr_e].fillna(0)
        y_train = df['incident_count'].iloc[tr_s:tr_e]
        X_test = df[feature_cols].iloc[te_s:te_e].fillna(0)
        y_test = df['incident_count'].iloc[te_s:te_e]
        
        model = RandomForestRegressor(n_estimators=100, max_depth=10, random_state=42, n_jobs=-1)
        model.fit(X_train, y_train)
        y_pred = np.maximum(model.predict(X_test), 0)
        
        metrics = compute_all_metrics(y_test.values, y_pred, y_train=y_train.values, n_features=len(feature_cols))
        all_metrics.append(metrics)
        print(f"  Fold {fold_i+1}: WMAPE={metrics['WMAPE']:.2f}%, MASE={metrics['MASE']:.4f}, MAE={metrics['MAE']:.4f}")
    
    avg = avg_metrics(all_metrics)
    results['RandomForest_Regressor'] = {
        'model': 'Random Forest Regressor', 'target': 'incident_count', 'task': 'regression',
        'validation': '3-fold walk-forward', 'metrics': avg
    }
    
    return results

def main():
    print("Loading global incident dataset...")
    df = load_data()
    print(f"Dataset: {len(df)} rows, {df['date_day'].min()} to {df['date_day'].max()}")
    print(f"Incident rate: {df['has_incident'].mean()*100:.1f}% of hours have incidents")
    print(f"Avg incidents per hour (when >0): {df[df['incident_count']>0]['incident_count'].mean():.2f}")
    
    feature_cols = get_features(df)
    print(f"Features: {len(feature_cols)} -> {feature_cols}")
    
    splits = walk_forward_split(df, n_folds=3)
    print(f"Walk-forward splits: {len(splits)} folds")
    
    # Train classification models
    print("\n" + "="*60)
    print("  CLASSIFICATION: Predicting has_incident (0/1)")
    print("="*60)
    clf_results = train_classification_models(df, feature_cols, splits)
    
    # Train regression models
    print("\n" + "="*60)
    print("  REGRESSION: Predicting incident_count")
    print("="*60)
    reg_results = train_regression_models(df, feature_cols, splits)
    
    # Combine and save all results
    all_results = {**clf_results, **reg_results}
    
    for name, result in all_results.items():
        filepath = f"{OUT_DIR}/incident_models/wf_{name.lower()}_results.json"
        with open(filepath, 'w') as f:
            json.dump(result, f, indent=4, default=str)
        print(f"Saved: {filepath}")
    
    # Print summary
    print("\n" + "="*60)
    print("  INCIDENT MODEL RESULTS SUMMARY")
    print("="*60)
    
    print("\n  CLASSIFICATION (has_incident):")
    for name, res in clf_results.items():
        m = res['metrics']
        print(f"    {name:30s} | F1={m['F1_Score']:.4f} | AUC-ROC={m['AUC_ROC']:.4f} | Precision={m['Precision']:.4f} | Recall={m['Recall']:.4f}")
    
    print("\n  REGRESSION (incident_count):")
    for name, res in reg_results.items():
        m = res['metrics']
        mase_val = m.get('MASE', 'N/A')
        wmape_val = m.get('WMAPE', 'N/A')
        mae_val = m.get('MAE', 'N/A')
        print(f"    {name:30s} | WMAPE={wmape_val} | MASE={mase_val} | MAE={mae_val}")
    
    print("\nIncident model training complete!")

if __name__ == "__main__":
    main()
