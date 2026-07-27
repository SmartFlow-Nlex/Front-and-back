"""
Evaluation metrics for incident-count models.

Exactly the KPI set requested:
    MAE, MSE, RMSE, MAPE, sMAPE, WMAPE, Poisson Deviance,
    MASE, RMSSE, R2, Adjusted_R2
  + Split-R2 adviser diagnostic: Train R2, Val R2, Gap
"""
import numpy as np
from sklearn.metrics import r2_score

EPS = 1e-9


def poisson_deviance(y_true, y_pred):
    """
    Mean Poisson deviance:
        D = (2/n) * sum[ y*log(y/mu) - (y - mu) ]
    The y*log(y/mu) term -> 0 as y -> 0, which is the standard convention and
    matters here because ~35% of hours have zero incidents.
    Predictions are floored at EPS since log(y/0) is undefined.
    """
    y = np.asarray(y_true, dtype=float)
    mu = np.clip(np.asarray(y_pred, dtype=float), EPS, None)
    term = np.zeros_like(y)
    nz = y > 0
    term[nz] = y[nz] * np.log(y[nz] / mu[nz])
    return float(2.0 * np.mean(term - (y - mu)))


def compute_metrics(y_true, y_pred, y_train=None, n_features=None, seasonality=1):
    """
    y_train    : training actuals, for the MASE/RMSSE naive benchmark
    n_features : predictor count, for Adjusted R2
    seasonality: naive lag (1 = random walk; 24 = seasonal-naive on hourly data)
    """
    y = np.asarray(y_true, dtype=float)
    p = np.asarray(y_pred, dtype=float)
    n = len(y)
    err = y - p
    abs_err = np.abs(err)

    mae = float(np.mean(abs_err))
    mse = float(np.mean(err ** 2))
    rmse = float(np.sqrt(mse))

    # MAPE / sMAPE: undefined at y=0, so restrict to the non-zero support and
    # report the coverage so the number is interpretable.
    nz = np.abs(y) > EPS
    mape = float(np.mean(np.abs(err[nz] / y[nz])) * 100) if nz.sum() else float("nan")

    denom = np.abs(y) + np.abs(p)
    ok = denom > EPS
    smape = float(np.mean(2.0 * abs_err[ok] / denom[ok]) * 100) if ok.sum() else float("nan")

    tot = np.sum(np.abs(y))
    wmape = float(np.sum(abs_err) / tot * 100) if tot > 0 else float("nan")

    pdev = poisson_deviance(y, p)

    # MASE / RMSSE against the in-sample naive forecast
    if y_train is not None and len(y_train) > seasonality:
        yt = np.asarray(y_train, dtype=float)
        naive = np.abs(yt[seasonality:] - yt[:-seasonality])
        mae_naive = float(np.mean(naive))
        mse_naive = float(np.mean((yt[seasonality:] - yt[:-seasonality]) ** 2))
        mase = float(mae / mae_naive) if mae_naive > EPS else float("nan")
        rmsse = float(np.sqrt(mse / mse_naive)) if mse_naive > EPS else float("nan")
    else:
        mase = rmsse = float("nan")

    r2 = float(r2_score(y, p))
    if n_features is not None and n > n_features + 1:
        adj = float(1 - (1 - r2) * (n - 1) / (n - n_features - 1))
    else:
        adj = float("nan")

    return {
        "MAE": _r(mae), "MSE": _r(mse), "RMSE": _r(rmse),
        "MAPE": _r(mape), "sMAPE": _r(smape), "WMAPE": _r(wmape),
        "Poisson_Deviance": _r(pdev),
        "MASE": _r(mase), "RMSSE": _r(rmsse),
        "R2": _r(r2), "Adjusted_R2": _r(adj),
        "_mape_coverage_pct": _r(float(nz.mean() * 100)),
    }


def split_r2(y_tr, p_tr, y_va, p_va):
    """Adviser diagnostic: train vs validation R2 and the overfit gap."""
    tr = float(r2_score(np.asarray(y_tr, float), np.asarray(p_tr, float)))
    va = float(r2_score(np.asarray(y_va, float), np.asarray(p_va, float)))
    return {"Train_R2": _r(tr), "Val_R2": _r(va), "Gap": _r(tr - va)}


def average_folds(fold_dicts):
    """Mean across walk-forward folds, skipping NaN/non-numeric entries."""
    out = {}
    for k in fold_dicts[0]:
        vals = [d[k] for d in fold_dicts
                if isinstance(d.get(k), (int, float)) and np.isfinite(d[k])]
        out[k] = _r(float(np.mean(vals))) if vals else "N/A"
    return out


def _r(x, nd=4):
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return "N/A"
    return round(float(x), nd)
