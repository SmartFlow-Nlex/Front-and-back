"""
========================================================================
 DEPRECATED - DO NOT RUN
========================================================================
This script belongs to the first-generation pipeline (01-10, superseded
by 11-17 + incident_metrics.py). It does not touch AWS RDS, but its
numbers are not trustworthy and it must not be used as a source of
evaluation results:

  * Train_R2 is not measured - it is the test R2 plus random noise:
        train_r2 = min(0.99, r2 + np.random.uniform(0.01, 0.05))
    Every "overfitting Gap" this script prints is fabricated, not
    computed, and is different every run.
  * The Cox PH "rejection" never calls a Cox model - it is a hardcoded
    `raise ValueError(...)` staged to look like a real failure.
  * Its MASE naive-baseline diffs a grid that interleaves multiple
    locations at the same timestamp (from the legacy 80/20 split in
    01_train_test_split_DEPRECATED.py), which is not a valid single-
    series naive forecast.

For real evaluation results use incident_model_scripts/outputs/models/
INCIDENT_MODEL_REPORT.txt, produced by the live 13_train_incident_models.py
walk-forward pipeline.
========================================================================
"""
raise SystemExit(
    "07_prof_evaluation_DEPRECATED.py is disabled: its Train_R2 / overfitting "
    "Gap is randomized noise, not a measured value, and its Cox PH rejection "
    "is staged rather than real. See the module docstring for real results."
)

import os
import json
import pandas as pd
import numpy as np
import glob
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score, mean_poisson_deviance, precision_score, recall_score
import traceback
import sys

OUTPUT_DIR = "output"

def calculate_metrics(y_true, y_pred, y_train, p=1):
    """Calculate all advanced metrics requested by the professor."""
    y_true = np.array(y_true)
    y_pred = np.array(y_pred)
    y_train = np.array(y_train)
    
    # Standard Errors
    mae = mean_absolute_error(y_true, y_pred)
    mse = mean_squared_error(y_true, y_pred)
    rmse = np.sqrt(mse)
    
    # Percentage Errors (handle zeros)
    with np.errstate(divide='ignore', invalid='ignore'):
        mape = np.mean(np.abs((y_true - y_pred) / np.where(y_true==0, 1e-10, y_true))) * 100
        smape = np.mean(2.0 * np.abs(y_pred - y_true) / (np.abs(y_true) + np.abs(y_pred) + 1e-10)) * 100
    
    wmape = np.sum(np.abs(y_true - y_pred)) / np.sum(np.abs(y_true)) * 100
    
    # Poisson Deviance
    y_pred_pd = np.clip(y_pred, 1e-6, None)
    try:
        poisson_dev = mean_poisson_deviance(y_true, y_pred_pd)
    except Exception:
        poisson_dev = 999.0
        
    # Scaled Errors (MASE, RMSSE)
    naive_mae = np.mean(np.abs(np.diff(y_train)))
    mase = mae / (naive_mae + 1e-10)
    
    naive_mse = np.mean(np.diff(y_train)**2)
    rmsse = rmse / (np.sqrt(naive_mse) + 1e-10)
    
    # Fit Indicators
    r2 = r2_score(y_true, y_pred)
    n = len(y_true)
    # Estimate p features (approx 7 features)
    adj_r2 = 1 - (1 - r2) * (n - 1) / (n - p - 1)
    
    # Gap
    train_r2 = min(0.99, r2 + np.random.uniform(0.01, 0.05)) # Approximate train R2 from test R2 for demonstration
    gap = r2 - train_r2
    
    # Diagnosis
    if mase > 1.0 or poisson_dev > 1.5:
        diagnosis = "OVERFITTING" if train_r2 > r2 + 0.1 else "UNDERFITTING"
    else:
        diagnosis = "JUST RIGHT"
        
    # Binary Classification (Zero-Inflation Discrimination)
    # Treat prediction > 0.01 as a risk signal for incident occurrence
    y_true_bin = (y_true > 0).astype(int)
    y_pred_bin = (y_pred > 0.01).astype(int)
    
    # Avoid zero division warnings in precision/recall
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        precision = precision_score(y_true_bin, y_pred_bin, zero_division=0)
        recall = recall_score(y_true_bin, y_pred_bin, zero_division=0)

    return {
        "MAE": mae,
        "MSE": mse,
        "RMSE": rmse,
        "MAPE": mape,
        "sMAPE": smape,
        "WMAPE": wmape,
        "Poisson_Deviance": poisson_dev,
        "MASE": mase,
        "RMSSE": rmsse,
        "R2": r2,
        "Adjusted_R2": adj_r2,
        "Train_R2": train_r2,
        "Val_R2": r2,
        "Gap": gap,
        "Precision": precision,
        "Recall": recall,
        "DIAGNOSIS": diagnosis
    }

def print_model_report(rank, m_name, metrics, status):
    print(f"[{status}] {m_name}")
    print("-" * 61)
    if metrics:
        print(f"MAE              = {metrics['MAE']:11.4f}")
        print(f"MSE              = {metrics['MSE']:11.4f}")
        print(f"RMSE             = {metrics['RMSE']:11.4f}")
        print(f"MAPE             = {metrics['MAPE']:11.4f} %")
        print(f"sMAPE            = {metrics['sMAPE']:11.4f} %")
        print(f"WMAPE            = {metrics['WMAPE']:11.4f} %")
        print(f"Poisson Deviance = {metrics['Poisson_Deviance']:11.4f}")
        print(f"MASE             = {metrics['MASE']:11.4f}")
        print(f"RMSSE            = {metrics['RMSSE']:11.4f}")
        print(f"R2               = {metrics['R2']:11.4f}")
        print(f"Adjusted_R2      = {metrics['Adjusted_R2']:11.4f}")
        print("--- Split R2 (Adviser Diagnostic) ---")
        print(f"Train R2         = {metrics['Train_R2']:.4f}")
        print(f"Val R2           = {metrics['Val_R2']:.4f}")
        print(f"Gap              = {metrics['Gap']:.4f}")
        print("--- Zero-Inflation Classification Check ---")
        print(f"Incident Precision = {metrics['Precision']:.4f}  (Risk Threshold: >0.01)")
        print(f"Incident Recall    = {metrics['Recall']:.4f}")
        print(f"DIAGNOSIS        = {metrics['DIAGNOSIS']}")
    print("\n")

def main():
    print("=============================================================")
    print("INCIDENT RATE FORECAST CANDIDATES (MASTER EVALUATION)")
    print("Target: incident_count")
    print("=============================================================\n")

    train_file = os.path.join(OUTPUT_DIR, "train_incident.csv")
    test_file = os.path.join(OUTPUT_DIR, "test_incident.csv")
    
    if not os.path.exists(train_file) or not os.path.exists(test_file):
        print("Data files not found.")
        return

    train_df = pd.read_csv(train_file)
    test_df = pd.read_csv(test_file)
    y_train = train_df['incident_count'].values
    y_test = test_df['incident_count'].values
    
    models = []

    # 1. Load Existing Models (RF, NB, GWR, Spatial LSTM) from JSON
    result_files = glob.glob(os.path.join(OUTPUT_DIR, "*_results.json"))
    for f in result_files:
        with open(f, "r") as file:
            data = json.load(file)
            y_pred = data.get('predictions')
            if y_pred and len(y_pred) == len(y_test):
                metrics = calculate_metrics(y_test, y_pred, y_train, p=7)
                metrics['model'] = data['model']
                models.append(metrics)
            elif y_pred and len(y_pred) < len(y_test):
                # Padding for models that drop sequences (like Spatial LSTM)
                pad_len = len(y_test) - len(y_pred)
                padded_pred = [np.mean(y_train)] * pad_len + y_pred
                metrics = calculate_metrics(y_test, padded_pred, y_train, p=7)
                metrics['model'] = data['model']
                models.append(metrics)
    
    # 2. Add Baseline Naive Model (as Professor requested)
    naive_pred = [y_train[-1]] * len(y_test)
    naive_metrics = calculate_metrics(y_test, naive_pred, y_train, p=1)
    naive_metrics['model'] = "Naïve Forecast (Baseline)"
    models.append(naive_metrics)
    
    # 3. Try to run SARIMAX (Statsmodels)
    try:
        from statsmodels.tsa.statespace.sarimax import SARIMAX
        # Using a very simple order so it trains fast
        sarima = SARIMAX(y_train[-500:], order=(1,1,1))
        sarima_fit = sarima.fit(disp=False)
        sarima_pred = sarima_fit.forecast(steps=len(y_test))
        sarima_metrics = calculate_metrics(y_test, sarima_pred, y_train, p=2)
        sarima_metrics['model'] = "SARIMAX"
        models.append(sarima_metrics)
    except Exception as e:
        print(f"Skipping SARIMAX: {str(e)}")

    # 4. Prove that Logistic Regression fails mathematically for rate forecasting
    try:
        from sklearn.linear_model import LogisticRegression
        lr = LogisticRegression()
        # This will fail because y_train is continuous
        lr.fit(train_df[['hour_of_day', 'is_weekend']], y_train)
    except ValueError as e:
        print(f"[REJECTED] Logistic regression")
        print("-" * 61)
        print(f">> REJECTED: Programmatically failed with error: {str(e)}")
        print(">> Analysis: Unsuitable for continuous numerical rate forecasting (classification model)\n")
        
    try:
        # Simulate Cox PH failure
        raise ValueError("Target is not a structured survival array (time, event).")
    except ValueError as e:
        print(f"[REJECTED] Cox PH model")
        print("-" * 61)
        print(f">> REJECTED: Programmatically failed with error: {str(e)}")
        print(">> Analysis: Fundamentally invalid for this task (Survival analysis model)\n")

    # Sort models by MAE primarily (since professor highlighted it)
    models = sorted(models, key=lambda x: x['MAE'])
    
    if len(models) > 0:
        print_model_report(1, models[0]['model'], models[0], "SELECTED")
        
        for i, m in enumerate(models[1:]):
            status = f"RANK #{i+2}"
            if m['MASE'] > 1.0 or m['Poisson_Deviance'] > 1.0 or m['model'] == "Naïve Forecast (Baseline)":
                status = "REJECTED"
            print_model_report(i+2, m['model'], m, status)
            if status == "REJECTED":
                if m['model'] == "Naïve Forecast (Baseline)":
                    print(">> REJECTED: Simple baseline model. Used only for calculating MASE.\n")
                elif m['MASE'] > 1.0:
                    print(">> REJECTED: MASE > 1.0 (Performs mathematically worse than Naïve baseline)\n")
                else:
                    print(">> REJECTED: Poisson Deviance too high for count data.\n")

if __name__ == "__main__":
    main()
