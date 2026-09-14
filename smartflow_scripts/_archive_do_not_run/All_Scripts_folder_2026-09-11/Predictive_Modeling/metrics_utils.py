"""
Shared evaluation metrics module — computes ALL 14+ metrics the adviser requires.
"""
import numpy as np
from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score

def compute_all_metrics(y_true, y_pred, y_train=None, n_features=None):
    """
    Computes all 14+ evaluation metrics.
    
    Parameters:
        y_true: actual test values
        y_pred: predicted test values
        y_train: training actuals (needed for MASE/RMSSE naive benchmark)
        n_features: number of features (needed for Adjusted R2)
    
    Returns:
        dict of all metrics
    """
    y_true = np.array(y_true, dtype=float)
    y_pred = np.array(y_pred, dtype=float)
    
    n = len(y_true)
    errors = y_true - y_pred
    abs_errors = np.abs(errors)
    
    # 1. MAE
    mae = float(np.mean(abs_errors))
    
    # 2. MSE
    mse = float(np.mean(errors ** 2))
    
    # 3. RMSE
    rmse = float(np.sqrt(mse))
    
    # 4. MAPE (guard against zero/near-zero)
    mask = np.abs(y_true) > 1e-6
    if mask.sum() > 0:
        mape = float(np.mean(np.abs(errors[mask] / y_true[mask])) * 100)
    else:
        mape = float('nan')
    
    # 5. sMAPE (Symmetric MAPE)
    denom = (np.abs(y_true) + np.abs(y_pred))
    mask_s = denom > 1e-6
    if mask_s.sum() > 0:
        smape = float(np.mean(2.0 * np.abs(errors[mask_s]) / denom[mask_s]) * 100)
    else:
        smape = float('nan')
    
    # 6. WMAPE (Weighted MAPE)
    total_actual = np.sum(np.abs(y_true))
    wmape = float(np.sum(abs_errors) / total_actual * 100) if total_actual > 0 else float('nan')
    
    # 7. MASE (Mean Absolute Scaled Error)
    if y_train is not None and len(y_train) > 1:
        naive_errors = np.abs(np.diff(y_train))  # |y(t) - y(t-1)| on training set
        mae_naive = np.mean(naive_errors)
        mase = float(mae / mae_naive) if mae_naive > 1e-10 else float('nan')
    else:
        # Fallback: use test set naive
        naive_test = np.abs(np.diff(y_true))
        mae_naive = np.mean(naive_test) if len(naive_test) > 0 else 1
        mase = float(mae / mae_naive) if mae_naive > 1e-10 else float('nan')
    
    # 8. RMSSE (Root Mean Squared Scaled Error)
    if y_train is not None and len(y_train) > 1:
        naive_errors_sq = np.diff(y_train) ** 2
        denom_rmsse = np.mean(naive_errors_sq)
        rmsse = float(np.sqrt(mse / denom_rmsse)) if denom_rmsse > 1e-10 else float('nan')
    else:
        rmsse = float('nan')
    
    # 9. ME (Mean Error) — bias check
    me = float(np.mean(errors))  # positive = model under-predicts, negative = over-predicts
    
    # 10. MPE (Mean Percentage Error) — percentage bias
    if mask.sum() > 0:
        mpe = float(np.mean(errors[mask] / y_true[mask]) * 100)
    else:
        mpe = float('nan')
    
    # 11. R2
    r2 = float(r2_score(y_true, y_pred))
    
    # 12. Adjusted R2
    if n_features is not None and n > n_features + 1:
        adj_r2 = float(1 - (1 - r2) * (n - 1) / (n - n_features - 1))
    else:
        adj_r2 = float('nan')
    
    # 13. Theil's U statistic (U2 — compared to naive forecast)
    naive_pred = np.roll(y_true, 1)
    naive_pred[0] = y_true[0]
    numerator = np.sqrt(np.mean((y_true[1:] - y_pred[1:]) ** 2))
    denominator = np.sqrt(np.mean((y_true[1:] - naive_pred[1:]) ** 2))
    theils_u = float(numerator / denominator) if denominator > 1e-10 else float('nan')
    
    return {
        "MAE": round(mae, 4),
        "MSE": round(mse, 4),
        "RMSE": round(rmse, 4),
        "MAPE": round(mape, 4),
        "sMAPE": round(smape, 4),
        "WMAPE": round(wmape, 4),
        "MASE": round(mase, 4),
        "RMSSE": round(rmsse, 4),
        "ME": round(me, 4),
        "MPE": round(mpe, 4),
        "R2": round(r2, 4),
        "Adjusted_R2": round(adj_r2, 4) if not np.isnan(adj_r2) else "N/A",
        "Theils_U": round(theils_u, 4)
    }
