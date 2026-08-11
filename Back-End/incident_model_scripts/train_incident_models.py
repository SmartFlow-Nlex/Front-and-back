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
from datetime import date, timedelta
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
import requests
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

# Width of the scoring window. 90 rather than 14 because R2 is an explained-
# variance ratio and cannot be estimated from 14 points of a series this noisy
# (CV = 32%, vs 15.8% for the traffic target). Measured directly: sliding the
# same 14-day protocol across 8 adjacent recent origins gave R2 from -0.98 to
# +0.48 — the window, not the model, was setting the number. Widening to 90 days
# leaves MAE flat (6.78 -> 6.11) and improves WMAPE (28.6% -> 21.1%), so this
# buys a trustworthy estimate rather than a flattering one.
VALIDATION_DAYS = 90
FUTURE_DAYS = 7
N_FOLDS = 3
SEQ_LEN = 14  # LSTM/GRU lookback window
SEED = 42
# Features carry three kinds of evidence for a prediction:
#   short memory  — lag_1/7/14 + rolling means (what just happened)
#   calendar      — day-of-week, holiday, and a smooth annual cycle
#   year-over-year— what this same weekday did one year ago
# The YoY terms are the answer to "what is the basis for this number?". Measured
# autocorrelation on the combined incident series: lag_364 = 0.380, vs 0.312 at
# lag_365 and ~0.367 at lag_357/371 — the peak sits exactly on 364 days (52 weeks),
# i.e. the SAME WEEKDAY last year, not the same calendar date. December averages
# 33.9 incidents/day against August's 22.7, so the annual shape is real.
YOY_LAG = 364  # 52 weeks — keeps day-of-week aligned across the year boundary
FEATURE_COLS = [
    "dow", "is_weekend", "is_holiday",
    "month", "doy_sin", "doy_cos",
    "lag_1", "lag_7", "lag_14",
    "roll_mean_7", "roll_mean_14", "roll_mean_28",
    "lag_364", "yoy_mean_5",
    "rain_mm",
]
# Only calendar-derived columns are valid SARIMAX exog for future dates — every
# one of these is knowable in advance for any date.
CALENDAR_COLS = ["is_weekend", "is_holiday", "doy_sin", "doy_cos"]
# Same "knowable in advance" bar as CALENDAR_COLS, but via a weather forecast
# rather than the calendar: rain_mm for the future window comes from
# fetch_future_rain() (hourly_weather actuals where available, Open-Meteo
# forecast beyond that), never from data the model wouldn't have at inference
# time. Used as SARIMAX exog instead of CALENDAR_COLS.
EXOG_COLS = CALENDAR_COLS + ["rain_mm"]

# Populated once in main() from dim_holiday; build_features is called recursively
# during forecasting, so this stays module-level rather than threaded through.
HOLIDAY_DATES: set = set()
MODEL_NAMES = ["XGBoost", "RandomForest", "Poisson_GLM", "NegBinomial_GLM", "SARIMAX", "LSTM", "GRU"]

# Daily incident counts from the three operations logs, matching INCIDENTS_CTE in
# src/services/incident.service.ts so the forecast counts the same incidents the
# rest of the incident dashboard shows. `date` is TEXT in two formats.
_D = "CASE WHEN date LIKE '%/%' THEN to_date(date, 'MM/DD/YYYY') ELSE date::date END"
DAILY_COUNTS_SQL = f"""
    WITH all_incidents AS (
        SELECT {_D} AS d FROM nlex_road_crashes        WHERE date IS NOT NULL
        UNION ALL
        SELECT {_D} AS d FROM nlex_motorcycle_crashes  WHERE date IS NOT NULL
        UNION ALL
        SELECT {_D} AS d FROM nlex_stalled_vehicles    WHERE date IS NOT NULL
    )
    SELECT d, COUNT(*)::float AS total
    FROM all_incidents
    GROUP BY 1
    ORDER BY 1
"""

# Local-day rainfall total, bucketed the same way src/services/incident.service.ts
# buckets hourly_weather for the descriptive dashboard's wet/dry split (UTC+8).
DAILY_RAIN_SQL = """
    SELECT (timestamp_utc + interval '8 hours')::date AS d, SUM(rainfall)::float AS rain_mm
    FROM hourly_weather
    GROUP BY 1
    ORDER BY 1
"""

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
    df = pd.read_sql(DAILY_COUNTS_SQL, conn)
    if df.empty:
        sys.exit("The incident source tables returned no rows — nothing to train on")
    df["d"] = pd.to_datetime(df["d"])
    full_range = pd.date_range(df["d"].min(), df["d"].max(), freq="D")
    df = df.set_index("d").reindex(full_range, fill_value=0.0).rename_axis("d").reset_index()
    return df


def load_daily_rain(conn) -> pd.DataFrame:
    """Daily rainfall totals from hourly_weather. Left-joined onto the incident
    series in main(); days with no weather rows (shouldn't happen inside
    hourly_weather's 2020-01-01+ coverage, but guards edge days) fall back to 0."""
    df = pd.read_sql(DAILY_RAIN_SQL, conn)
    df["d"] = pd.to_datetime(df["d"])
    return df


def load_holidays(conn) -> set:
    """Philippine holiday calendar. Any date not listed is treated as a normal
    day — dim_holiday currently runs to 2026-07-25, so the 7 forecast days fall
    just past its edge and default to non-holiday (correct for late Jul/early
    Aug: the next regular holiday is Ninoy Aquino Day on 21 Aug)."""
    df = pd.read_sql("SELECT date_day FROM dim_holiday WHERE is_holiday", conn)
    return set(pd.to_datetime(df["date_day"]).dt.date)


def calendar_features(dates: pd.Series) -> pd.DataFrame:
    """Calendar columns for any date, past or future — no observed data needed.
    Shared by build_features and the SARIMAX future-exog construction so both
    always produce the identical design matrix."""
    dow = dates.dt.dayofweek
    doy = dates.dt.dayofyear
    return pd.DataFrame(
        {
            "dow": dow,
            "is_weekend": dow.isin([5, 6]).astype(int),
            "is_holiday": dates.dt.date.map(lambda x: int(x in HOLIDAY_DATES)),
            "month": dates.dt.month,
            # Smooth annual cycle: lets the model express "late December is busy"
            # without carving the year into 12 hard steps.
            "doy_sin": np.sin(2 * np.pi * doy / 365.25),
            "doy_cos": np.cos(2 * np.pi * doy / 365.25),
        },
        index=dates.index,
    )


# NLEX corridor coords, matching the OpenWeather extractor's scope
# (src/etl/extractors/weather.extractor.ts) so every weather touchpoint in this
# codebase samples the same location.
NLEX_LAT, NLEX_LON = 14.75, 120.95


def fetch_future_rain(future_dates: list, rain_by_date: dict) -> dict:
    """Rain total (mm) for each date in the model's future horizon.

    hourly_weather is kept current through "now", so as long as a future date
    falls inside its coverage this returns the real observed total from
    rain_by_date (built from DAILY_RAIN_SQL) rather than a guess. Only dates
    past that coverage — i.e. once the incident source tables catch up to
    real time — fall through to a live forecast call, so the model always
    prefers ground truth over a forecast when both could apply.
    """
    known = {d.date(): rain_by_date[d.date()] for d in future_dates if d.date() in rain_by_date}
    missing = [d for d in future_dates if d.date() not in known]
    if not missing:
        return known

    try:
        resp = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": NLEX_LAT,
                "longitude": NLEX_LON,
                "daily": "precipitation_sum",
                "timezone": "Asia/Manila",
                "forecast_days": 16,
            },
            timeout=10,
        )
        resp.raise_for_status()
        payload = resp.json()["daily"]
        forecast = dict(zip(
            [pd.Timestamp(d).date() for d in payload["time"]],
            payload["precipitation_sum"],
        ))
    except Exception as e:
        print(f"  Open-Meteo forecast fetch failed ({e}); missing future dates default to 0mm rain")
        forecast = {}

    for d in missing:
        known[d.date()] = float(forecast.get(d.date(), 0.0) or 0.0)
    return known


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out[["dow", "is_weekend", "is_holiday", "month", "doy_sin", "doy_cos"]] = calendar_features(out["d"])
    for lag in (1, 7, 14, YOY_LAG):
        out[f"lag_{lag}"] = out["total"].shift(lag)
    out["roll_mean_7"] = out["total"].shift(1).rolling(7).mean()
    out["roll_mean_14"] = out["total"].shift(1).rolling(14).mean()
    out["roll_mean_28"] = out["total"].shift(1).rolling(28).mean()
    # Same stretch of last year, averaged over a 5-day window centred on YOY_LAG
    # (lags 362-366), so one freak day last year can't swing the estimate.
    out["yoy_mean_5"] = out["total"].shift(YOY_LAG - 2).rolling(5).mean()
    return out


def walk_forward_folds(n_rows: int, n_folds: int = N_FOLDS) -> list[tuple[int, int]]:
    """Expanding-window folds: (train_end, test_end) pairs, train always
    starts at 0. Each fold's test window is the next contiguous chunk after
    its train window — never trains on data from after the test window.

    Note this only reaches ~84% of the series (60% minimum train + 3 x 8% test),
    so the most recent ~16% is never scored, and the middle fold lands on
    2024-10..2025-03 where the base level differs from today's."""
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


def holdout_fold(n_rows: int) -> list[tuple[int, int]]:
    """Single most-recent holdout — the protocol the traffic module already uses.

    gold.ml_predictive_volume splits train / is_holdout / is_future (40/10/15)
    and every figure in gold.ml_model_metrics is computed on the holdout window
    alone. Using the same protocol here makes the two predictive modules
    comparable, and scores the model on the period it will actually run against
    rather than on 2024-era data. The window is VALIDATION_DAYS wide, which is
    also exactly what the dashboard labels "Present"."""
    return [(n_rows - VALIDATION_DAYS, n_rows)]


def evaluation_folds(n_rows: int, protocol: str) -> list[tuple[int, int]]:
    return holdout_fold(n_rows) if protocol == "holdout" else walk_forward_folds(n_rows)


def mase_of(y_true: np.ndarray, y_pred: np.ndarray, y_naive: np.ndarray) -> float | None:
    naive_mae = mean_absolute_error(y_true, y_naive)
    if naive_mae <= 0:
        return None
    return float(mean_absolute_error(y_true, y_pred) / naive_mae)


# Gap above which train/validation divergence is called overfitting. Matches the
# threshold implied by the project's earlier reporting, where a 0.0932 gap read
# JUST RIGHT and 0.1360 read OVERFITTING.
OVERFIT_GAP = 0.10
UNDERFIT_TRAIN_R2 = 0.05


def diagnose(train_r2: float, val_r2: float) -> str:
    gap = train_r2 - val_r2
    if train_r2 < UNDERFIT_TRAIN_R2:
        return "UNDERFITTING"
    if gap > OVERFIT_GAP:
        return "OVERFITTING"
    return "JUST RIGHT"


def full_metrics(
    y_true: np.ndarray, y_pred: np.ndarray, y_naive: np.ndarray,
    train_true: np.ndarray, train_pred: np.ndarray, n_features: int,
) -> dict:
    """Every figure the project's model-comparison report carries. Percentage
    errors guard against zero actuals; the daily incident series never hits 0 in
    practice (min = 2), but a filled calendar gap could."""
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    err = y_true - y_pred
    abs_err = np.abs(err)
    n = len(y_true)

    mae = float(np.mean(abs_err))
    mse = float(np.mean(err ** 2))
    rmse = float(np.sqrt(mse))

    nz = y_true != 0
    mape = float(np.mean(abs_err[nz] / np.abs(y_true[nz])) * 100) if nz.any() else float("nan")
    denom = np.abs(y_true) + np.abs(y_pred)
    sd = denom != 0
    smape = float(np.mean(2 * abs_err[sd] / denom[sd]) * 100) if sd.any() else float("nan")
    wmape = float(abs_err.sum() / np.abs(y_true).sum() * 100) if np.abs(y_true).sum() > 0 else float("nan")

    # Poisson deviance — the natural loss for count data. y*log(y/yhat) -> 0 as y -> 0.
    safe_pred = np.clip(y_pred, 1e-9, None)
    ratio = np.where(y_true > 0, y_true * np.log(np.where(y_true > 0, y_true, 1) / safe_pred), 0.0)
    poisson_dev = float(2 * np.mean(ratio - (y_true - safe_pred)))

    naive_mae = float(mean_absolute_error(y_true, y_naive))
    naive_rmse = float(np.sqrt(mean_squared_error(y_true, y_naive)))
    mase = float(mae / naive_mae) if naive_mae > 0 else None
    rmsse = float(rmse / naive_rmse) if naive_rmse > 0 else None

    r2 = float(r2_score(y_true, y_pred))
    # Adjusted R2 penalises the feature count; undefined when n <= p + 1.
    adj_r2 = (
        float(1 - (1 - r2) * (n - 1) / (n - n_features - 1))
        if n - n_features - 1 > 0
        else None
    )
    train_r2 = float(r2_score(train_true, train_pred))

    return {
        "MAE": mae, "MSE": mse, "RMSE": rmse,
        "MAPE": mape, "sMAPE": smape, "WMAPE": wmape,
        "Poisson_Deviance": poisson_dev,
        "MASE": mase, "RMSSE": rmsse,
        "R2": r2, "Adjusted_R2": adj_r2,
        "Train_R2": train_r2, "Val_R2": r2,
        "Gap": train_r2 - r2,
        "Diagnosis": diagnose(train_r2, r2),
    }


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
    exog_tr, exog_val = train_df[EXOG_COLS], val_df[EXOG_COLS]
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


def run_evaluation(feat: pd.DataFrame, protocol: str) -> dict[str, list[dict]]:
    folds = evaluation_folds(len(feat), protocol)
    label = (
        "single recent holdout (traffic-module protocol)"
        if protocol == "holdout"
        else "3-fold expanding-window walk-forward"
    )
    windows = ", ".join(
        f"{feat['d'].iloc[a].date()}..{feat['d'].iloc[b - 1].date()}" for a, b in folds
    )
    print(f"Evaluation protocol: {label}")
    print(f"  test window(s): {windows}")
    per_model_fold_metrics: dict[str, list[dict]] = {name: [] for name in MODEL_NAMES}

    for fold_i, (train_end, test_end) in enumerate(folds, start=1):
        set_all_seeds()
        print(f"\n--- Fold {fold_i}/{len(folds)}: train=[0:{train_end}) test=[{train_end}:{test_end}) ---")
        train_df, val_df = feat.iloc[:train_end], feat.iloc[train_end:test_end]
        y_val_naive = val_df["lag_7"].values

        n_feat = len(FEATURE_COLS)
        for name, fitter in CV_FITTERS.items():
            try:
                print(f"  {name}...", end=" ", flush=True)
                train_pred, val_pred = fitter(train_df, val_df)
                m = full_metrics(val_df["total"].values, val_pred, y_val_naive,
                                 train_df["total"].values, train_pred, n_feat)
                per_model_fold_metrics[name].append(m)
                print(f"MAE={m['MAE']:.3f} Val_R2={m['R2']:.3f} {m['Diagnosis']}")
            except Exception as e:
                print(f"FAILED ({e})")
                per_model_fold_metrics[name].append({"error": str(e)})

        for kind in ("LSTM", "GRU"):
            try:
                print(f"  {kind}...", end=" ", flush=True)
                train_true, train_pred, val_pred, _, _ = _cv_rnn(kind, feat, train_end, test_end)
                val_true = feat["total"].values[max(train_end, SEQ_LEN):test_end]
                val_naive = feat["lag_7"].values[max(train_end, SEQ_LEN):test_end]
                # RNNs are univariate on the sequence, so only the lookback counts
                # as a parameter for the adjusted-R2 penalty.
                m = full_metrics(val_true, val_pred, val_naive, train_true, train_pred, SEQ_LEN)
                per_model_fold_metrics[kind].append(m)
                print(f"MAE={m['MAE']:.3f} Val_R2={m['R2']:.3f} {m['Diagnosis']}")
            except Exception as e:
                print(f"FAILED ({e})")
                per_model_fold_metrics[kind].append({"error": str(e)})

    return per_model_fold_metrics


MEAN_METRICS = ["MAE", "MSE", "RMSE", "MAPE", "sMAPE", "WMAPE",
                "Poisson_Deviance", "MASE", "RMSSE", "R2", "Adjusted_R2"]


def summarize_folds(per_model_fold_metrics: dict[str, list[dict]]) -> list[dict]:
    rows = []
    for name in MODEL_NAMES:
        folds = [f for f in per_model_fold_metrics[name] if "error" not in f]
        if not folds:
            rows.append({"model": name, **{k: None for k in MEAN_METRICS},
                         "Train_R2": None, "Val_R2": None, "Gap": None,
                         "Diagnosis": "FAILED", "error": "all folds failed"})
            continue

        def avg(key: str) -> float | None:
            vals = [f[key] for f in folds if f.get(key) is not None]
            return round(float(np.mean(vals)), 4) if vals else None

        val_r2 = float(np.mean([f["R2"] for f in folds]))
        train_r2 = float(np.mean([f["Train_R2"] for f in folds]))
        rows.append({
            "model": name,
            **{k: avg(k) for k in MEAN_METRICS},
            "Train_R2": round(train_r2, 4),
            "Val_R2": round(val_r2, 4),
            "Gap": round(train_r2 - val_r2, 4),
            "Diagnosis": diagnose(train_r2, val_r2),
        })
    return sorted(rows, key=lambda r: (r["MAE"] is None, r["MAE"]))


def select_champion(comparison: list[dict], criterion: str = "r2") -> tuple[str, bool]:
    """Returns (champion_name, degraded) — degraded=True means no model
    actually cleared the MASE<=1.0 bar and the pick is a fallback.

    Both criteria first require MASE <= 1.0 (must beat a same-day-last-week
    naive forecast). Among those, 'r2' takes the highest explained variance and
    'mae' the lowest absolute error. They can disagree when models are within
    noise of each other on MAE but differ on how much variance they capture —
    which is the case here, so the criterion is stated explicitly rather than
    left implicit."""
    eligible = [r for r in comparison if r.get("MASE") is not None and r["MASE"] <= 1.0]
    pool = eligible if eligible else [r for r in comparison if r.get("MAE") is not None]
    if not pool:
        sys.exit("Every model failed to train — nothing eligible to be champion")
    if criterion == "r2":
        best = max(pool, key=lambda r: r["R2"] if r.get("R2") is not None else -1e9)
    else:
        best = min(pool, key=lambda r: r["MAE"])
    return best["model"], not eligible


DISPLAY_NAME = {
    "XGBoost": "XGBoost", "RandomForest": "Random Forest", "LSTM": "LSTM", "GRU": "GRU",
    "Poisson_GLM": "Poisson GLM", "NegBinomial_GLM": "Negative Binomial GLM", "SARIMAX": "SARIMAX",
}


def format_report(comparison: list[dict], champion: str, degraded: bool, evaluation: dict) -> str:
    """Per-model metric blocks, in the layout the project's model report uses."""
    def num(v, width=12, dp=4, pct=False):
        if v is None:
            return f"{'n/a':>{width}}"
        return f"{v:>{width}.{dp}f}" + (" %" if pct else "")

    L = []
    L.append("=" * 80)
    L.append("  INCIDENT FORECASTING CANDIDATES ")
    L.append("  (target: incident_count)")
    L.append("=" * 80)
    L.append("")
    L.append(f"  Source        : nlex_road_crashes + nlex_motorcycle_crashes + nlex_stalled_vehicles")
    L.append(f"  Protocol      : {evaluation['protocol']} ({evaluation['holdout_days']}-day window)")
    L.append(f"  Holdout window: {evaluation['holdout_window'][0]} .. {evaluation['holdout_window'][1]}")
    L.append(f"  Train rows    : {evaluation['train_rows']}")
    L.append(f"  Selected by   : {evaluation['selected_by']}")
    L.append("")

    ranked = sorted(comparison, key=lambda r: (r.get("R2") is None, -(r.get("R2") or -1e9)))
    for i, r in enumerate(ranked, 1):
        tag = "[SELECTED]" if r["model"] == champion else f"[RANK #{i}]"
        L.append(f"  {tag} {DISPLAY_NAME.get(r['model'], r['model'])}")
        L.append("  " + "-" * 60)
        if r.get("MAE") is None:
            L.append(f"    FAILED: {r.get('error')}")
            L.append("")
            continue
        L.append(f"    MAE              = {num(r['MAE'])}")
        L.append(f"    MSE              = {num(r['MSE'])}")
        L.append(f"    RMSE             = {num(r['RMSE'])}")
        L.append(f"    MAPE             = {num(r['MAPE'], pct=True)}")
        L.append(f"    sMAPE            = {num(r['sMAPE'], pct=True)}")
        L.append(f"    WMAPE            = {num(r['WMAPE'], pct=True)}")
        L.append(f"    Poisson_Deviance = {num(r['Poisson_Deviance'])}")
        L.append(f"    MASE             = {num(r['MASE'])}")
        L.append(f"    RMSSE            = {num(r['RMSSE'])}")
        L.append(f"    R2               = {num(r['R2'])}")
        L.append(f"    Adjusted_R2      = {num(r['Adjusted_R2'])}")
        L.append("    --- Split R2 (Adviser Diagnostic) ---")
        L.append(f"    Train R2         = {num(r['Train_R2'])}")
        L.append(f"    Val R2           = {num(r['Val_R2'])}")
        L.append(f"    Gap              = {num(r['Gap'])}")
        L.append(f"    DIAGNOSIS        = {r['Diagnosis']}")
        L.append("")

    if degraded:
        L.append("  WARNING: no model beat the naive seasonal (lag-7) baseline (MASE <= 1.0).")
        L.append(f"           Champion '{champion}' is the least-bad fallback.")
        L.append("")
    return "\n".join(L)


def print_comparison(comparison: list[dict], champion: str, degraded: bool) -> None:
    print("\n" + "=" * 108)
    print("MODEL COMPARISON (sorted by validation MAE)")
    print("=" * 108)
    header = (f"{'Model':<18}{'MAE':>8}{'RMSE':>8}{'WMAPE':>8}{'MASE':>8}{'R2':>8}"
              f"{'Adj_R2':>9}{'Train_R2':>10}{'Gap':>8}  {'DIAGNOSIS':<13}")
    print(header)
    print("-" * len(header))
    for r in comparison:
        if r.get("MAE") is None:
            print(f"{r['model']:<18}{'FAILED':>8}  ({r.get('error')})")
            continue
        f2 = lambda v, d=3: f"{v:.{d}f}" if v is not None else "n/a"
        flag = ("  <= eligible" if r["MASE"] is not None and r["MASE"] <= 1.0
                else "  (worse than naive)" if r["MASE"] is not None else "")
        print(f"{r['model']:<18}{f2(r['MAE']):>8}{f2(r['RMSE']):>8}{f2(r['WMAPE'],2):>8}"
              f"{f2(r['MASE']):>8}{f2(r['R2']):>8}{f2(r['Adjusted_R2']):>9}"
              f"{f2(r['Train_R2']):>10}{f2(r['Gap']):>8}  {r['Diagnosis']:<13}{flag}")
    print("=" * 108)
    if degraded:
        print("WARNING: no model beat the naive seasonal (lag-7) baseline (MASE <= 1.0).")
        print(f"         Champion '{champion}' is the least-bad fallback — sanity-check before writing to DB.")
    print(f"CHAMPION: {champion}")
    print("=" * 108 + "\n")


# ---------------------------------------------------------------------------
# Phase 2: final refit of the champion on the full dataset + DB write.
# ---------------------------------------------------------------------------
def final_tabular_forecast(name: str, feat: pd.DataFrame, rain_by_date: dict):
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
        # statsmodels returns a Series indexed like the input frame, so [0] would
        # be a *label* lookup and raise KeyError on the recursive forecast rows
        # (whose index is the tail position, not 0). Go through numpy for a
        # positional read.
        predict_row = lambda row_feat: max(
            float(np.asarray(model.predict(with_const(row_feat[FEATURE_COLS])))[0]), 0.0
        )
        coefs = model.params.drop(labels=["const"], errors="ignore")
        importances = sorted(({"feature": f, "importance": abs(float(v))} for f, v in coefs.items()),
                              key=lambda x: x["importance"], reverse=True)

    # Recursive future forecast: feed each prediction back in as if observed,
    # since real future actuals don't exist yet.
    history = feat[["d", "total", "rain_mm"]].copy()
    future_dates = [history["d"].iloc[-1] + timedelta(days=i) for i in range(1, FUTURE_DAYS + 1)]
    future_rain = fetch_future_rain(future_dates, rain_by_date)
    future_rows = []
    for next_date in future_dates:
        rain_val = future_rain[next_date.date()]
        candidate = pd.concat(
            [history, pd.DataFrame([{"d": next_date, "total": np.nan, "rain_mm": rain_val}])],
            ignore_index=True,
        )
        row_feat = build_features(candidate).iloc[[-1]]
        pred = predict_row(row_feat)
        future_rows.append((next_date, pred))
        history = pd.concat(
            [history, pd.DataFrame([{"d": next_date, "total": pred, "rain_mm": rain_val}])],
            ignore_index=True,
        )

    return val_pred, future_rows, importances


def final_sarimax_forecast(feat: pd.DataFrame, rain_by_date: dict):
    train, val = feat.iloc[:-VALIDATION_DAYS], feat.iloc[-VALIDATION_DAYS:]
    res = SARIMAX(
        train["total"], exog=train[EXOG_COLS], order=(1, 0, 1), seasonal_order=(1, 0, 1, 7),
        enforce_stationarity=False, enforce_invertibility=False,
    ).fit(disp=False)

    future_dates = [val["d"].iloc[-1] + timedelta(days=i) for i in range(1, FUTURE_DAYS + 1)]
    future_rain = fetch_future_rain(future_dates, rain_by_date)
    future_exog = calendar_features(pd.Series(future_dates))[CALENDAR_COLS].reset_index(drop=True)
    future_exog["rain_mm"] = [future_rain[d.date()] for d in future_dates]
    combined_exog = pd.concat([val[EXOG_COLS].reset_index(drop=True), future_exog], ignore_index=True)

    forecast = res.get_forecast(steps=VALIDATION_DAYS + FUTURE_DAYS, exog=combined_exog).predicted_mean.to_numpy()
    val_pred = np.clip(forecast[:VALIDATION_DAYS], 0, None)
    future_pred = np.clip(forecast[VALIDATION_DAYS:], 0, None)
    future_rows = list(zip(future_dates, future_pred.tolist()))
    return val_pred, future_rows, []  # no comparable feature-importance concept for SARIMAX exog coefficients


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


def build_final_predictions(champion: str, feat: pd.DataFrame, rain_by_date: dict):
    if champion in ("XGBoost", "RandomForest", "Poisson_GLM", "NegBinomial_GLM"):
        return final_tabular_forecast(champion, feat, rain_by_date)
    if champion == "SARIMAX":
        return final_sarimax_forecast(feat, rain_by_date)
    return final_rnn_forecast(champion, feat)  # LSTM / GRU


# Column in ml_predictive_incidents that carries each model's series. The
# dashboard toggles between these the same way the traffic chart toggles
# pred_lstm / pred_prophet / ... in gold.ml_predictive_volume.
PRED_COLUMN = {
    "XGBoost": "pred_xgboost",
    "RandomForest": "pred_randomforest",
    "LSTM": "pred_lstm",
    "GRU": "pred_gru",
    "Poisson_GLM": "pred_poisson_glm",
    "NegBinomial_GLM": "pred_negbinomial_glm",
    "SARIMAX": "pred_sarimax",
}


def build_all_final_predictions(feat: pd.DataFrame, rain_by_date: dict) -> tuple[dict[str, dict], dict[str, list]]:
    """Refit every model on the full series so the dashboard can overlay any of
    them, not just the champion. A model that fails here is skipped rather than
    aborting the run — the champion still has to succeed, which main() checks."""
    val_dates = [d.date() for d in feat["d"].iloc[-VALIDATION_DAYS:]]
    by_model: dict[str, dict] = {}
    importances: dict[str, list] = {}

    for name in MODEL_NAMES:
        try:
            print(f"  refitting {name}...", end=" ", flush=True)
            set_all_seeds()
            val_pred, future_rows, imp = build_final_predictions(name, feat, rain_by_date)
            # The RNNs lose their first SEQ_LEN validation points to the lookback
            # window; left-pad with None so every model shares one date index.
            # Cast to built-in float — psycopg2 has no adapter for np.float64 and
            # would serialise it into the SQL text as "np.float64(...)".
            vp: list[float | None] = [float(x) for x in np.asarray(val_pred, dtype=float)]
            if len(vp) < len(val_dates):
                vp = [None] * (len(val_dates) - len(vp)) + vp
            by_model[name] = {
                "validation": dict(zip(val_dates, vp)),
                "future": {d.date(): float(p) for d, p in future_rows},
            }
            importances[name] = imp
            print("ok")
        except Exception as e:
            print(f"FAILED ({e})")
    return by_model, importances


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

            -- The observed count on the same weekday one year earlier. Stored so
            -- the dashboard can show what each forecast is reasoning from rather
            -- than presenting a bare number. Added via ALTER because the table
            -- predates this column on existing deployments.
            ALTER TABLE ml_predictive_incidents
                ADD COLUMN IF NOT EXISTS same_day_last_year DOUBLE PRECISION;

            -- One column per candidate, mirroring gold.ml_predictive_volume, so
            -- the dashboard can overlay any model instead of only the champion.
            ALTER TABLE ml_predictive_incidents
                ADD COLUMN IF NOT EXISTS pred_xgboost          DOUBLE PRECISION,
                ADD COLUMN IF NOT EXISTS pred_randomforest     DOUBLE PRECISION,
                ADD COLUMN IF NOT EXISTS pred_lstm             DOUBLE PRECISION,
                ADD COLUMN IF NOT EXISTS pred_gru              DOUBLE PRECISION,
                ADD COLUMN IF NOT EXISTS pred_poisson_glm      DOUBLE PRECISION,
                ADD COLUMN IF NOT EXISTS pred_negbinomial_glm  DOUBLE PRECISION,
                ADD COLUMN IF NOT EXISTS pred_sarimax          DOUBLE PRECISION;

            -- Rain (mm) behind each date's forecast: the real hourly_weather total
            -- for validation dates and any future date hourly_weather already
            -- covers, an Open-Meteo forecast otherwise (see fetch_future_rain).
            -- Lets the dashboard plot rainfall against the incident forecast on
            -- one timeline instead of only reasoning about it from feature
            -- importance.
            ALTER TABLE ml_predictive_incidents
                ADD COLUMN IF NOT EXISTS rainfall_mm DOUBLE PRECISION;
            """
        )
    conn.commit()


def write_to_db(conn, daily: pd.DataFrame, feat: pd.DataFrame, champion: str,
                 by_model: dict[str, dict], metadata: dict, rain_by_date: dict) -> None:
    ensure_schema(conn)
    actual_by_date = {row.d.date(): float(row.total) for row in daily.itertuples()}
    yoy = lambda d: actual_by_date.get(d - timedelta(days=YOY_LAG))

    val_dates = [d.date() for d in feat["d"].iloc[-VALIDATION_DAYS:]]
    future_dates = sorted(by_model[champion]["future"].keys())
    model_cols = [PRED_COLUMN[m] for m in MODEL_NAMES]

    def num(v):
        """Built-in float or None — psycopg2 cannot adapt numpy scalars."""
        return None if v is None or (isinstance(v, float) and np.isnan(v)) else float(v)

    def row_for(d, kind: str):
        preds = [num(by_model[m][kind].get(d)) if m in by_model else None for m in MODEL_NAMES]
        # predicted_incident_count stays the champion's series so every existing
        # reader keeps working unchanged.
        champ = num(by_model[champion][kind].get(d))
        return (d, kind, champ if champ is not None else 0.0, champion, num(yoy(d)),
                *preds, num(rain_by_date.get(d)))

    with conn.cursor() as cur:
        cur.execute("DELETE FROM ml_daily_actuals")
        psycopg2.extras.execute_values(
            cur, "INSERT INTO ml_daily_actuals (d, total) VALUES %s",
            [(row.d.date(), float(row.total)) for row in daily.itertuples()],
        )

        cur.execute("DELETE FROM ml_predictive_incidents")
        pred_rows = [row_for(d, "validation") for d in val_dates]
        pred_rows += [row_for(d, "future") for d in future_dates]
        psycopg2.extras.execute_values(
            cur,
            "INSERT INTO ml_predictive_incidents (forecast_date, prediction_type, "
            "predicted_incident_count, champion_model, same_day_last_year, "
            + ", ".join(model_cols) + ", rainfall_mm) VALUES %s",
            pred_rows,
        )

        cur.execute("DELETE FROM ml_training_metadata")
        cur.execute("INSERT INTO ml_training_metadata (metadata_json) VALUES (%s)", [json.dumps(metadata)])
    conn.commit()


def main() -> None:
    global HOLIDAY_DATES, VALIDATION_DAYS

    parser = argparse.ArgumentParser()
    parser.add_argument("--write-db", action="store_true", help="Also write the champion's predictions/metadata to the database")
    parser.add_argument(
        "--protocol", choices=["holdout", "walk-forward"], default="holdout",
        help="holdout (default): single most-recent window, matching how the traffic "
             "module is scored in gold.ml_model_metrics. walk-forward: 3-fold "
             "expanding window — a harder test that also never scores recent data.",
    )
    parser.add_argument(
        "--holdout-days", type=int, default=VALIDATION_DAYS,
        help=f"Width of the scoring/validation window (default {VALIDATION_DAYS}). "
             "Anything under ~60 makes R2 unstable on this series.",
    )
    parser.add_argument(
        "--select-by", choices=["r2", "mae"], default="r2",
        help="Champion criterion among models with MASE <= 1.0 (default r2).",
    )
    parser.add_argument(
        "--champion", choices=MODEL_NAMES, default=None,
        help="Force a specific champion, overriding --select-by. The full "
             "comparison table is still recorded either way.",
    )
    args = parser.parse_args()
    VALIDATION_DAYS = args.holdout_days

    set_all_seeds()
    conn = get_conn()
    try:
        print("Loading daily incident counts (road + motorcycle crashes + stalled vehicles)...")
        daily = load_daily_counts(conn)
        print(f"  {len(daily)} calendar days, {int(daily['total'].sum())} total incidents")

        rain_daily = load_daily_rain(conn)
        daily = daily.merge(rain_daily, on="d", how="left")
        daily["rain_mm"] = daily["rain_mm"].fillna(0.0)
        rain_by_date = dict(zip(rain_daily["d"].dt.date, rain_daily["rain_mm"]))
        print(f"  rainfall joined from hourly_weather ({len(rain_daily)} days, "
              f"latest {rain_daily['d'].max().date()})")

        HOLIDAY_DATES = load_holidays(conn)
        print(f"  {len(HOLIDAY_DATES)} holiday dates loaded from dim_holiday")

        # The YoY features need a full year of warm-up before the first usable row.
        feat = build_features(daily).dropna(subset=FEATURE_COLS).reset_index(drop=True)
        print(f"  {len(feat)} usable rows after {YOY_LAG + 2}-day feature warm-up "
              f"({feat['d'].min().date()} .. {feat['d'].max().date()})")
        if len(feat) < VALIDATION_DAYS + 30:
            sys.exit(f"Not enough history to train: only {len(feat)} usable rows after feature warm-up")

        per_model_folds = run_evaluation(feat, args.protocol)
        comparison = summarize_folds(per_model_folds)
        champion, degraded = select_champion(comparison, args.select_by)
        if args.champion and args.champion != champion:
            print(f"Champion overridden: {champion} -> {args.champion} (--champion)")
            champion = args.champion
        print_comparison(comparison, champion, degraded)

        evaluation = {
            "protocol": args.protocol,
            "holdout_days": VALIDATION_DAYS,
            "selected_by": "explicit override" if args.champion else args.select_by,
            "holdout_window": [str(feat["d"].iloc[-VALIDATION_DAYS].date()),
                               str(feat["d"].iloc[-1].date())],
            "train_rows": len(feat) - VALIDATION_DAYS,
            "note": ("Scored on a single most-recent holdout, the same protocol used for "
                     "the traffic module in gold.ml_model_metrics. 90 days rather than 14 "
                     "because R2 is unstable on a 14-day window for this series."),
        }

        report = format_report(comparison, champion, degraded, evaluation)
        report_path = Path(__file__).resolve().parent / "model_results.txt"
        report_path.write_text(report, encoding="utf-8")
        print(f"Full per-model report written to {report_path}\n")

        if not args.write_db:
            print("Training complete. Re-run with --write-db once you've reviewed the comparison above.")
            return

        # Resolve the future window's rain once — hourly_weather actuals where
        # available, Open-Meteo forecast beyond that — and fold it into
        # rain_by_date so every model's recursive future loop (and the DB write
        # below) reads the same values instead of each refetching separately.
        future_dates = [feat["d"].iloc[-1] + timedelta(days=i) for i in range(1, FUTURE_DAYS + 1)]
        rain_by_date.update({d: v for d, v in fetch_future_rain(future_dates, rain_by_date).items()})

        print("Refitting all candidates on the full dataset so the dashboard can overlay any of them...")
        by_model, importances = build_all_final_predictions(feat, rain_by_date)
        if champion not in by_model:
            sys.exit(f"Champion '{champion}' failed its final refit — nothing safe to write")
        feature_importance = importances.get(champion, [])
        champion_row = next(r for r in comparison if r["model"] == champion)

        metadata = {
            "champion_model": champion,
            "model_comparison": comparison,
            "metrics": {"MAE": champion_row["MAE"], "RMSE": champion_row["RMSE"],
                        "R2": champion_row["R2"], "MASE": champion_row["MASE"]},
            "feature_importance": feature_importance,
            "evaluation": evaluation,
            # Which models actually made it into the prediction columns, so the
            # dashboard only offers toggles that have data behind them.
            "available_models": [m for m in MODEL_NAMES if m in by_model],
        }
        if degraded:
            metadata["warning"] = "No model beat the naive seasonal (MASE<=1.0) baseline; champion is a fallback pick."

        print("Writing ml_daily_actuals, ml_predictive_incidents, ml_training_metadata (one transaction)...")
        write_to_db(conn, daily, feat, champion, by_model, metadata, rain_by_date)
        print("Committed.")
        print(f"Champion: {champion}   R2={champion_row['R2']}   MAE={champion_row['MAE']}   "
              f"models stored: {len(by_model)}/{len(MODEL_NAMES)}")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
