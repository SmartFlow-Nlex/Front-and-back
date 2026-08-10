#!/usr/bin/env python3
"""
SmartFlow NLEX — Incident Predictive Pipeline (Phase B: 7-model comparison)
============================================================================
Walk-forward validated comparison of 7 forecasting approaches for daily
incident counts:
  1. XGBoost regressor          5. Poisson GLM
  2. Random Forest regressor    6. Negative Binomial GLM
  3. LSTM (small RNN)           7. SARIMAX (weekly seasonal, calendar exog)
  4. GRU  (small RNN)

3-fold expanding-window walk-forward validation (never trains on data from
after its own test window). Champion = lowest mean validation MAE among
models with MASE <= 1.0 (i.e. must beat a naive same-day-last-week baseline);
if every model fails that bar, the least-bad one is still picked so the
pipeline can produce output, but this is flagged loudly in the printout.

Two-phase by design:
  Phase 1 (always runs): walk-forward CV for all 7 models, prints the full
    comparison table, and STOPS. No DB writes here.
  Phase 2 (only with --write-db): refits the champion on the full dataset,
    generates the validation-window + future-window predictions, and writes
    ml_daily_actuals / ml_predictive_incidents / ml_training_metadata in one
    transaction — same 3-table contract as run_predictive_pipeline.py.

run_predictive_pipeline.py (single XGBoost baseline) is left untouched as a
fallback/reference until this is verified end to end.

Usage:
    .venv/Scripts/python.exe train_incident_models.py             # train + compare + print only
    .venv/Scripts/python.exe train_incident_models.py --write-db  # + write champion to DB
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import warnings
from datetime import timedelta
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
# oneDNN's own startup warning says its custom ops can vary numerically
# between runs depending on computation order — disable it for the
# bit-for-bit reproducibility the fixed seeds below are meant to guarantee.
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import psycopg2
import psycopg2.extras
import statsmodels.api as sm
import tensorflow as tf
from dotenv import load_dotenv
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.preprocessing import MinMaxScaler
from statsmodels.discrete.discrete_model import NegativeBinomial
from statsmodels.tsa.statespace.sarimax import SARIMAX
from tensorflow.keras.callbacks import EarlyStopping
from tensorflow.keras.layers import GRU, LSTM, Dense
from tensorflow.keras.models import Sequential
from xgboost import XGBRegressor

VALIDATION_DAYS = 14
FUTURE_DAYS = 7
N_FOLDS = 3
SEQ_LEN = 14  # LSTM/GRU lookback window
SEED = 42
FEATURE_COLS = ["dow", "is_weekend", "lag_1", "lag_7", "lag_14", "roll_mean_7", "roll_mean_14"]
CALENDAR_COLS = ["is_weekend"]  # only calendar-derived columns are valid SARIMAX exog for future dates
MODEL_NAMES = ["XGBoost", "RandomForest", "Poisson_GLM", "NegBinomial_GLM", "SARIMAX", "LSTM", "GRU"]

# Single-threaded + deterministic ops must be set once, before any TF op runs —
# this can't be changed later without restarting the interpreter, so it
# happens at import time rather than inside main().
tf.config.threading.set_inter_op_parallelism_threads(1)
tf.config.threading.set_intra_op_parallelism_threads(1)
tf.config.experimental.enable_op_determinism()


def set_all_seeds(seed: int = SEED) -> None:
    """Reseeds every RNG this pipeline touches (Python, numpy, TensorFlow) so
    a full re-run — including LSTM/GRU weight init and batch shuffling —
    reproduces identical metrics bit-for-bit. XGBoost/RandomForest already
    take an explicit random_state and don't depend on global RNG state; the
    GLM/SARIMAX fits have no randomness to begin with (deterministic MLE from
    fixed starting values), so neither needs reseeding here. Called once at
    import time plus again before every RNN build, so build order or any
    incidental RNG use elsewhere can't shift what LSTM/GRU see."""
    random.seed(seed)
    np.random.seed(seed)
    tf.random.set_seed(seed)


set_all_seeds()

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


# ---------------------------------------------------------------------------
# Data loading / features — same warm-up-safe construction as the baseline.
# ---------------------------------------------------------------------------
def get_conn():
    dsn = os.environ.get("PGURL") or os.environ.get("POSTGRES_URL")
    if not dsn:
        sys.exit("PGURL or POSTGRES_URL must be set (checked Back-End/.env)")
    return psycopg2.connect(dsn, sslmode="require")


def load_daily_counts(conn) -> pd.DataFrame:
    df = pd.read_sql(
        """
        SELECT incident_date::date AS d, COUNT(*)::float AS total
        FROM bronze.nlex_incidents
        WHERE incident_date IS NOT NULL
        GROUP BY 1
        ORDER BY 1
        """,
        conn,
    )
    if df.empty:
        sys.exit("bronze.nlex_incidents returned no rows — nothing to train on")
    df["d"] = pd.to_datetime(df["d"])
    full_range = pd.date_range(df["d"].min(), df["d"].max(), freq="D")
    df = df.set_index("d").reindex(full_range, fill_value=0.0).rename_axis("d").reset_index()
    return df


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["dow"] = out["d"].dt.dayofweek
    out["is_weekend"] = out["dow"].isin([5, 6]).astype(int)
    for lag in (1, 7, 14):
        out[f"lag_{lag}"] = out["total"].shift(lag)
    out["roll_mean_7"] = out["total"].shift(1).rolling(7).mean()
    out["roll_mean_14"] = out["total"].shift(1).rolling(14).mean()
    return out


def walk_forward_folds(n_rows: int, n_folds: int = N_FOLDS) -> list[tuple[int, int]]:
    """Expanding-window folds: (train_end, test_end) pairs, train always
    starts at 0. Each fold's test window is the next contiguous chunk after
    its train window — never trains on data from after the test window."""
    test_size = max(int(n_rows * 0.08), VALIDATION_DAYS)
    min_train = int(n_rows * 0.60)
    folds = []
    for i in range(n_folds):
        train_end = min_train + i * test_size
        test_end = min(train_end + test_size, n_rows)
        if train_end >= n_rows or test_end <= train_end:
            break
        folds.append((train_end, test_end))
    return folds


def mase_of(y_true: np.ndarray, y_pred: np.ndarray, y_naive: np.ndarray) -> float | None:
    naive_mae = mean_absolute_error(y_true, y_naive)
    if naive_mae <= 0:
        return None
    return float(mean_absolute_error(y_true, y_pred) / naive_mae)


def with_const(X: pd.DataFrame) -> pd.DataFrame:
    """Explicit constant column (rather than sm.add_constant) so fit and
    predict always build the identical design matrix regardless of statsmodels
    version quirks around column placement."""
    out = X.copy()
    out.insert(0, "const", 1.0)
    return out


# ---------------------------------------------------------------------------
# Per-model: CV fit/predict, used only for the walk-forward comparison table.
# Each returns (train_pred, val_pred) as plain arrays aligned to train/val y.
# ---------------------------------------------------------------------------
def cv_xgboost(train_df, val_df):
    m = XGBRegressor(n_estimators=200, max_depth=4, learning_rate=0.05, subsample=0.9, colsample_bytree=0.9, random_state=42)
    m.fit(train_df[FEATURE_COLS], train_df["total"])
    return m.predict(train_df[FEATURE_COLS]), m.predict(val_df[FEATURE_COLS])


def cv_random_forest(train_df, val_df):
    m = RandomForestRegressor(n_estimators=300, max_depth=8, random_state=42, n_jobs=-1)
    m.fit(train_df[FEATURE_COLS], train_df["total"])
    return m.predict(train_df[FEATURE_COLS]), m.predict(val_df[FEATURE_COLS])


def cv_poisson_glm(train_df, val_df):
    Xtr, Xval = with_const(train_df[FEATURE_COLS]), with_const(val_df[FEATURE_COLS])
    res = sm.GLM(train_df["total"], Xtr, family=sm.families.Poisson()).fit()
    return np.asarray(res.predict(Xtr)), np.asarray(res.predict(Xval))


def cv_negbinomial_glm(train_df, val_df):
    Xtr, Xval = with_const(train_df[FEATURE_COLS]), with_const(val_df[FEATURE_COLS])
    res = NegativeBinomial(train_df["total"], Xtr).fit(disp=0, maxiter=200)
    return np.asarray(res.predict(Xtr)), np.asarray(res.predict(Xval))


def cv_sarimax(train_df, val_df):
    exog_tr, exog_val = train_df[CALENDAR_COLS], val_df[CALENDAR_COLS]
    res = SARIMAX(
        train_df["total"], exog=exog_tr, order=(1, 0, 1), seasonal_order=(1, 0, 1, 7),
        enforce_stationarity=False, enforce_invertibility=False,
    ).fit(disp=False)
    train_pred = np.asarray(res.fittedvalues)
    val_pred = np.asarray(res.get_forecast(steps=len(val_df), exog=exog_val).predicted_mean)
    return train_pred, val_pred


def _make_sequences(y: np.ndarray, lo: int, hi: int, seq_len: int) -> tuple[np.ndarray, np.ndarray]:
    xs, ys = [], []
    for i in range(max(lo, seq_len), hi):
        xs.append(y[i - seq_len : i])
        ys.append(y[i])
    return np.array(xs).reshape(-1, seq_len, 1), np.array(ys)


def _cv_rnn(kind: str, full_df, train_end: int, test_end: int):
    set_all_seeds()
    y_all = full_df["total"].values.astype("float32")
    scaler = MinMaxScaler()
    y_train_scaled = scaler.fit_transform(y_all[:train_end].reshape(-1, 1)).flatten()
    y_scaled_full = scaler.transform(y_all.reshape(-1, 1)).flatten()

    X_train, y_train = _make_sequences(y_scaled_full, 0, train_end, SEQ_LEN)
    X_val, y_val = _make_sequences(y_scaled_full, train_end, test_end, SEQ_LEN)

    model = Sequential()
    layer_cls = LSTM if kind == "LSTM" else GRU
    model.add(layer_cls(16, input_shape=(SEQ_LEN, 1)))
    model.add(Dense(1))
    model.compile(optimizer="adam", loss="mse")
    model.fit(
        X_train, y_train, epochs=30, batch_size=32, verbose=0,
        validation_split=0.1, callbacks=[EarlyStopping(patience=5, restore_best_weights=True)],
    )

    train_pred = scaler.inverse_transform(model.predict(X_train, verbose=0)).flatten()
    val_pred = scaler.inverse_transform(model.predict(X_val, verbose=0)).flatten()
    train_true = scaler.inverse_transform(y_train.reshape(-1, 1)).flatten()
    return train_true, train_pred, val_pred, model, scaler


CV_FITTERS = {
    "XGBoost": cv_xgboost,
    "RandomForest": cv_random_forest,
    "Poisson_GLM": cv_poisson_glm,
    "NegBinomial_GLM": cv_negbinomial_glm,
    "SARIMAX": cv_sarimax,
}


def run_walk_forward(feat: pd.DataFrame) -> dict[str, list[dict]]:
    folds = walk_forward_folds(len(feat))
    print(f"Walk-forward folds (expanding window): {folds}")
    per_model_fold_metrics: dict[str, list[dict]] = {name: [] for name in MODEL_NAMES}

    for fold_i, (train_end, test_end) in enumerate(folds, start=1):
        set_all_seeds()
        print(f"\n--- Fold {fold_i}/{len(folds)}: train=[0:{train_end}) test=[{train_end}:{test_end}) ---")
        train_df, val_df = feat.iloc[:train_end], feat.iloc[train_end:test_end]
        y_val_naive = val_df["lag_7"].values

        for name, fitter in CV_FITTERS.items():
            try:
                print(f"  {name}...", end=" ", flush=True)
                train_pred, val_pred = fitter(train_df, val_df)
                m = {
                    "MAE": float(mean_absolute_error(val_df["total"], val_pred)),
                    "RMSE": float(np.sqrt(mean_squared_error(val_df["total"], val_pred))),
                    "R2": float(r2_score(val_df["total"], val_pred)),
                    "MASE": mase_of(val_df["total"].values, val_pred, y_val_naive),
                    "Train_R2": float(r2_score(train_df["total"], train_pred)),
                }
                per_model_fold_metrics[name].append(m)
                print(f"MAE={m['MAE']:.3f} Val_R2={m['R2']:.3f}")
            except Exception as e:
                print(f"FAILED ({e})")
                per_model_fold_metrics[name].append({"error": str(e)})

        for kind in ("LSTM", "GRU"):
            try:
                print(f"  {kind}...", end=" ", flush=True)
                train_true, train_pred, val_pred, _, _ = _cv_rnn(kind, feat, train_end, test_end)
                val_true = feat["total"].values[max(train_end, SEQ_LEN):test_end]
                val_naive = feat["lag_7"].values[max(train_end, SEQ_LEN):test_end]
                m = {
                    "MAE": float(mean_absolute_error(val_true, val_pred)),
                    "RMSE": float(np.sqrt(mean_squared_error(val_true, val_pred))),
                    "R2": float(r2_score(val_true, val_pred)),
                    "MASE": mase_of(val_true, val_pred, val_naive),
                    "Train_R2": float(r2_score(train_true, train_pred)),
                }
                per_model_fold_metrics[kind].append(m)
                print(f"MAE={m['MAE']:.3f} Val_R2={m['R2']:.3f}")
            except Exception as e:
                print(f"FAILED ({e})")
                per_model_fold_metrics[kind].append({"error": str(e)})

    return per_model_fold_metrics


def summarize_folds(per_model_fold_metrics: dict[str, list[dict]]) -> list[dict]:
    rows = []
    for name in MODEL_NAMES:
        folds = [f for f in per_model_fold_metrics[name] if "error" not in f]
        if not folds:
            rows.append({"model": name, "MAE": None, "RMSE": None, "R2": None, "MASE": None,
                         "Train_R2": None, "Val_R2": None, "Gap": None, "error": "all folds failed"})
            continue
        mase_vals = [f["MASE"] for f in folds if f["MASE"] is not None]
        val_r2 = float(np.mean([f["R2"] for f in folds]))
        train_r2 = float(np.mean([f["Train_R2"] for f in folds]))
        rows.append({
            "model": name,
            "MAE": round(float(np.mean([f["MAE"] for f in folds])), 4),
            "RMSE": round(float(np.mean([f["RMSE"] for f in folds])), 4),
            "R2": round(val_r2, 4),
            "MASE": round(float(np.mean(mase_vals)), 4) if mase_vals else None,
            "Train_R2": round(train_r2, 4),
            "Val_R2": round(val_r2, 4),
            "Gap": round(train_r2 - val_r2, 4),
        })
    return sorted(rows, key=lambda r: (r["MAE"] is None, r["MAE"]))


def select_champion(comparison: list[dict]) -> tuple[str, bool]:
    """Returns (champion_name, degraded) — degraded=True means no model
    actually cleared the MASE<=1.0 bar and the pick is a fallback."""
    eligible = [r for r in comparison if r.get("MASE") is not None and r["MASE"] <= 1.0]
    pool = eligible if eligible else [r for r in comparison if r.get("MAE") is not None]
    if not pool:
        sys.exit("Every model failed to train — nothing eligible to be champion")
    best = min(pool, key=lambda r: r["MAE"])
    return best["model"], not eligible


def print_comparison(comparison: list[dict], champion: str, degraded: bool) -> None:
    print("\n" + "=" * 100)
    print("MODEL COMPARISON (sorted by mean validation MAE across folds)")
    print("=" * 100)
    header = f"{'Model':<18}{'MAE':>8}{'RMSE':>8}{'R2':>8}{'MASE':>8}{'Train_R2':>10}{'Val_R2':>8}{'Gap':>8}"
    print(header)
    print("-" * len(header))
    for r in comparison:
        if "error" in r and r.get("MAE") is None:
            print(f"{r['model']:<18}{'FAILED':>8}  ({r['error']})")
            continue
        mase_str = f"{r['MASE']:.3f}" if r["MASE"] is not None else "n/a"
        flag = "  <= eligible" if r["MASE"] is not None and r["MASE"] <= 1.0 else "  (worse than naive)" if r["MASE"] is not None else ""
        print(f"{r['model']:<18}{r['MAE']:>8.3f}{r['RMSE']:>8.3f}{r['R2']:>8.3f}{mase_str:>8}{r['Train_R2']:>10.3f}{r['Val_R2']:>8.3f}{r['Gap']:>8.3f}{flag}")
    print("=" * 100)
    if degraded:
        print(f"WARNING: no model beat the naive seasonal (lag-7) baseline (MASE <= 1.0).")
        print(f"         Champion '{champion}' is the least-bad fallback — sanity-check before writing to DB.")
    print(f"CHAMPION: {champion}")
    print("=" * 100 + "\n")


# ---------------------------------------------------------------------------
# Phase 2: final refit of the champion on the full dataset + DB write.
# ---------------------------------------------------------------------------
def final_tabular_forecast(name: str, feat: pd.DataFrame):
    train, val = feat.iloc[:-VALIDATION_DAYS], feat.iloc[-VALIDATION_DAYS:]
    fit_fn = {"XGBoost": cv_xgboost, "RandomForest": cv_random_forest,
              "Poisson_GLM": cv_poisson_glm, "NegBinomial_GLM": cv_negbinomial_glm}[name]

    if name == "XGBoost":
        model = XGBRegressor(n_estimators=200, max_depth=4, learning_rate=0.05, subsample=0.9, colsample_bytree=0.9, random_state=42)
        model.fit(train[FEATURE_COLS], train["total"])
        val_pred = model.predict(val[FEATURE_COLS])
        predict_row = lambda row_feat: max(float(model.predict(row_feat[FEATURE_COLS])[0]), 0.0)
        importances = sorted(({"feature": f, "importance": float(v)} for f, v in zip(FEATURE_COLS, model.feature_importances_)),
                              key=lambda x: x["importance"], reverse=True)
    elif name == "RandomForest":
        model = RandomForestRegressor(n_estimators=300, max_depth=8, random_state=42, n_jobs=-1)
        model.fit(train[FEATURE_COLS], train["total"])
        val_pred = model.predict(val[FEATURE_COLS])
        predict_row = lambda row_feat: max(float(model.predict(row_feat[FEATURE_COLS])[0]), 0.0)
        importances = sorted(({"feature": f, "importance": float(v)} for f, v in zip(FEATURE_COLS, model.feature_importances_)),
                              key=lambda x: x["importance"], reverse=True)
    else:  # Poisson_GLM / NegBinomial_GLM
        Xtr, Xval = with_const(train[FEATURE_COLS]), with_const(val[FEATURE_COLS])
        if name == "Poisson_GLM":
            model = sm.GLM(train["total"], Xtr, family=sm.families.Poisson()).fit()
        else:
            model = NegativeBinomial(train["total"], Xtr).fit(disp=0, maxiter=200)
        val_pred = np.asarray(model.predict(Xval))
        predict_row = lambda row_feat: max(float(model.predict(with_const(row_feat[FEATURE_COLS]))[0]), 0.0)
        coefs = model.params.drop(labels=["const"], errors="ignore")
        importances = sorted(({"feature": f, "importance": abs(float(v))} for f, v in coefs.items()),
                              key=lambda x: x["importance"], reverse=True)

    # Recursive future forecast: feed each prediction back in as if observed,
    # since real future actuals don't exist yet.
    history = feat[["d", "total"]].copy()
    future_rows = []
    for _ in range(FUTURE_DAYS):
        next_date = history["d"].iloc[-1] + timedelta(days=1)
        candidate = pd.concat([history, pd.DataFrame([{"d": next_date, "total": np.nan}])], ignore_index=True)
        row_feat = build_features(candidate).iloc[[-1]]
        pred = predict_row(row_feat)
        future_rows.append((next_date, pred))
        history = pd.concat([history, pd.DataFrame([{"d": next_date, "total": pred}])], ignore_index=True)

    return val_pred, future_rows, importances


def final_sarimax_forecast(feat: pd.DataFrame):
    train, val = feat.iloc[:-VALIDATION_DAYS], feat.iloc[-VALIDATION_DAYS:]
    res = SARIMAX(
        train["total"], exog=train[CALENDAR_COLS], order=(1, 0, 1), seasonal_order=(1, 0, 1, 7),
        enforce_stationarity=False, enforce_invertibility=False,
    ).fit(disp=False)

    future_dates = [val["d"].iloc[-1] + timedelta(days=i) for i in range(1, FUTURE_DAYS + 1)]
    future_exog = pd.DataFrame({"is_weekend": [1 if d.dayofweek >= 5 else 0 for d in future_dates]})
    combined_exog = pd.concat([val[CALENDAR_COLS], future_exog], ignore_index=True)

    forecast = res.get_forecast(steps=VALIDATION_DAYS + FUTURE_DAYS, exog=combined_exog).predicted_mean.to_numpy()
    val_pred = np.clip(forecast[:VALIDATION_DAYS], 0, None)
    future_pred = np.clip(forecast[VALIDATION_DAYS:], 0, None)
    future_rows = list(zip(future_dates, future_pred.tolist()))
    return val_pred, future_rows, []  # no comparable feature-importance for SARIMAX exog (calendar-only)


def final_rnn_forecast(kind: str, feat: pd.DataFrame):
    set_all_seeds()
    n = len(feat)
    train_end = n - VALIDATION_DAYS
    y_all = feat["total"].values.astype("float32")
    scaler = MinMaxScaler()
    scaler.fit(y_all[:train_end].reshape(-1, 1))
    y_scaled = scaler.transform(y_all.reshape(-1, 1)).flatten()

    X_train, y_train = _make_sequences(y_scaled, 0, train_end, SEQ_LEN)
    X_val, _ = _make_sequences(y_scaled, train_end, n, SEQ_LEN)

    model = Sequential()
    layer_cls = LSTM if kind == "LSTM" else GRU
    model.add(layer_cls(16, input_shape=(SEQ_LEN, 1)))
    model.add(Dense(1))
    model.compile(optimizer="adam", loss="mse")
    model.fit(X_train, y_train, epochs=30, batch_size=32, verbose=0, validation_split=0.1,
              callbacks=[EarlyStopping(patience=5, restore_best_weights=True)])

    val_pred = scaler.inverse_transform(model.predict(X_val, verbose=0)).flatten()
    val_pred = np.clip(val_pred, 0, None)

    # Recursive future forecast on the scaled series.
    working = list(y_scaled)
    future_rows = []
    last_date = feat["d"].iloc[-1]
    for i in range(FUTURE_DAYS):
        window = np.array(working[-SEQ_LEN:]).reshape(1, SEQ_LEN, 1)
        pred_scaled = float(model.predict(window, verbose=0)[0, 0])
        working.append(pred_scaled)
        pred = max(float(scaler.inverse_transform([[pred_scaled]])[0, 0]), 0.0)
        future_rows.append((last_date + timedelta(days=i + 1), pred))

    return val_pred, future_rows, []  # no feature-importance concept for a univariate RNN


def build_final_predictions(champion: str, feat: pd.DataFrame):
    if champion in ("XGBoost", "RandomForest", "Poisson_GLM", "NegBinomial_GLM"):
        return final_tabular_forecast(champion, feat)
    if champion == "SARIMAX":
        return final_sarimax_forecast(feat)
    return final_rnn_forecast(champion, feat)  # LSTM / GRU


def ensure_schema(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS ml_daily_actuals (
                d DATE PRIMARY KEY,
                total DOUBLE PRECISION NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ml_predictive_incidents (
                id SERIAL PRIMARY KEY,
                forecast_date DATE NOT NULL,
                prediction_type TEXT NOT NULL CHECK (prediction_type IN ('validation', 'future')),
                predicted_incident_count DOUBLE PRECISION NOT NULL,
                champion_model TEXT,
                UNIQUE (forecast_date, prediction_type)
            );
            CREATE TABLE IF NOT EXISTS ml_training_metadata (
                id SERIAL PRIMARY KEY,
                metadata_json JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            """
        )
    conn.commit()


def write_to_db(conn, daily: pd.DataFrame, feat: pd.DataFrame, champion: str,
                 val_pred: np.ndarray, future_rows: list, metadata: dict) -> None:
    ensure_schema(conn)
    val = feat.iloc[-VALIDATION_DAYS:]
    with conn.cursor() as cur:
        cur.execute("DELETE FROM ml_daily_actuals")
        psycopg2.extras.execute_values(
            cur, "INSERT INTO ml_daily_actuals (d, total) VALUES %s",
            [(row.d.date(), float(row.total)) for row in daily.itertuples()],
        )

        cur.execute("DELETE FROM ml_predictive_incidents")
        pred_rows = [(row.d.date(), "validation", float(p), champion) for row, p in zip(val.itertuples(), val_pred)]
        pred_rows += [(d.date(), "future", float(p), champion) for d, p in future_rows]
        psycopg2.extras.execute_values(
            cur,
            "INSERT INTO ml_predictive_incidents (forecast_date, prediction_type, predicted_incident_count, champion_model) VALUES %s",
            pred_rows,
        )

        cur.execute("DELETE FROM ml_training_metadata")
        cur.execute("INSERT INTO ml_training_metadata (metadata_json) VALUES (%s)", [json.dumps(metadata)])
    conn.commit()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-db", action="store_true", help="Also write the champion's predictions/metadata to the database")
    args = parser.parse_args()

    set_all_seeds()
    conn = get_conn()
    try:
        print("Loading daily incident counts from bronze.nlex_incidents...")
        daily = load_daily_counts(conn)
        print(f"  {len(daily)} calendar days, {int(daily['total'].sum())} total incidents")

        feat = build_features(daily).dropna(subset=FEATURE_COLS).reset_index(drop=True)
        if len(feat) < VALIDATION_DAYS + 30:
            sys.exit(f"Not enough history to train: only {len(feat)} usable rows after feature warm-up")

        per_model_folds = run_walk_forward(feat)
        comparison = summarize_folds(per_model_folds)
        champion, degraded = select_champion(comparison)
        print_comparison(comparison, champion, degraded)

        if not args.write_db:
            print("Training complete. Re-run with --write-db once you've reviewed the comparison above.")
            return

        print(f"Refitting champion '{champion}' on the full dataset for final predictions...")
        val_pred, future_rows, feature_importance = build_final_predictions(champion, feat)
        champion_row = next(r for r in comparison if r["model"] == champion)

        metadata = {
            "champion_model": champion,
            "model_comparison": comparison,
            "metrics": {"MAE": champion_row["MAE"], "RMSE": champion_row["RMSE"],
                        "R2": champion_row["R2"], "MASE": champion_row["MASE"]},
            "feature_importance": feature_importance,
        }
        if degraded:
            metadata["warning"] = "No model beat the naive seasonal (MASE<=1.0) baseline; champion is a fallback pick."

        print("Writing ml_daily_actuals, ml_predictive_incidents, ml_training_metadata (one transaction)...")
        write_to_db(conn, daily, feat, champion, val_pred, future_rows, metadata)
        print("Committed.")
        print(json.dumps(metadata, indent=2))
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
