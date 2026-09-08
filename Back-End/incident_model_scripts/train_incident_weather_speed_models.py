#!/usr/bin/env python3
"""
SmartFlow NLEX — Weather-Adjusted Speed Models (Block 3: Weather-Adjusted Speed)
====================================================================================
A fourth grain, alongside the day/exit/incident pipelines already in this
directory: DAILY corridor-wide (speed + volume forecasting, both risk
scores) and per-(EXIT, HOUR) (the contour map).

  1. SARIMAX / LSTM / GRU / XGBoost compete on forecasting daily average
     speed under rain ("Speed forecast under rain"). The champion
     architecture is then refit on daily volume too ("Weather-adjusted
     volume forecast") — a second target on the same features, not a second
     4-way comparison; the traffic module already owns a full volume-model
     comparison and this does not attempt to duplicate it.

  2. Two small logistic regressions, both against the same daily
     rain/volume/calendar features: "road closure probability" (did traffic
     grind to a halt that day) and "weather incident risk" (did an incident
     happen that day) — the two KPIs the block asks for.

  3. XGBoost again, refit at (exit, hour) grain, predicted on a synthetic
     dry-vs-wet grid to produce the weather-adjusted speed contour map.

A real, load-bearing data-quality caveat, stated up front: bronze/silver's
`avg_speed_kmh` ranges from -5 to 55 with a mean of ~5 (verified against the
live table) — far too low and occasionally negative for a literal km/h
reading on a highway, and it correlates POSITIVELY with avg_jam_level
(r=0.68) and max_delay_seconds (r=0.38) across a 40k-row sample, the
opposite of what real traffic physics would produce (more jam should mean
LESS speed). This warehouse's speed/jam columns are synthetic capstone data,
not live sensor readings, and this script does not try to correct or
reinterpret their sign convention — only to clip the physically-impossible
negative values to 0 and model whatever internal structure the column
actually has. Every caption downstream says "this warehouse's speed metric"
rather than implying a validated real-world figure.

Two more data-source notes:
  - `rainfall` inside bronze/silver.nlex_traffic_volume is 100% zero (checked
    directly) — unusable. Rain comes from `hourly_weather` instead, the same
    table every other pipeline in this directory already reads from.
  - `hourly_weather.location_name` matches exit names closely enough (one
    casing quirk: "Cdv/Ph Arena" vs the exit table's "CDV/PH Arena") to join
    per-exit, per-hour rainfall directly — a real spatial weather signal for
    the contour map, not one corridor-wide reading applied to every exit.

Usage:
    python train_incident_weather_speed_models.py                 # train + report only
    python train_incident_weather_speed_models.py --write-db       # + write to gold.*
    python train_incident_weather_speed_models.py --dry-write       # rehearse the write, then roll back
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
warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import psycopg2
import psycopg2.extras
import statsmodels.api as sm
import torch
import torch.nn as nn
from dotenv import load_dotenv
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score, roc_auc_score
from statsmodels.tsa.statespace.sarimax import SARIMAX
from xgboost import XGBRegressor

SEED = 42
HOLDOUT_FRACTION = 0.15  # daily panel
SEQ_LEN = 14
EPOCHS = 60
PATIENCE = 8
# Synthetic rain scenarios for both the closure/risk KPI curves and the
# contour map's "wet" grid. 0mm is the dry baseline; the rest span from a
# drizzle to the P90 daily corridor-wide total observed in this warehouse
# (~358mm, itself a sum across every weather station on a shared day — a
# genuinely extreme, not typical, wet day).
RAIN_SCENARIOS_MM = [0, 10, 30, 60, 100]
WET_SCENARIO_MM = 60.0  # the contour map's single "wet" grid, mid-scenario


def set_all_seeds(seed: int = SEED) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


set_all_seeds()
load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def get_conn():
    """Mirrors train_incident_models.py's get_conn() — kept in sync by hand."""
    dsn = os.environ.get("PGURL") or os.environ.get("POSTGRES_URL")
    if not dsn:
        host = os.environ.get("PG_HOST")
        if not host:
            sys.exit("PGURL/POSTGRES_URL or PG_HOST must be set (checked Back-End/.env)")
        dsn = (
            f"host={host} port={os.environ.get('PG_PORT', 5432)} "
            f"dbname={os.environ.get('PG_DATABASE')} user={os.environ.get('PG_USER')} "
            f"password={os.environ.get('PG_PASSWORD')}"
        )
    return psycopg2.connect(dsn, sslmode="require")


# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------
# GREATEST(...,0): the negative-speed/negative-jam floor described in the
# module docstring — physically impossible values clamped, not dropped, so a
# noisy row still contributes its other columns.
DAILY_PANEL_SQL = """
    SELECT date_day AS d,
           AVG(GREATEST(avg_speed_kmh, 0))::float AS speed_kmh,
           MIN(GREATEST(avg_speed_kmh, 0))::float AS speed_kmh_min,
           MAX(GREATEST(avg_jam_level, 0))::float AS jam_level_max,
           SUM(total_volume)::float AS volume
    FROM bronze.nlex_traffic_volume
    GROUP BY date_day
    ORDER BY date_day
"""

# Mirrors train_incident_models.py's DAILY_RAIN_SQL — kept in sync by hand.
DAILY_RAIN_SQL = """
    SELECT (timestamp_utc + interval '8 hours')::date AS d, SUM(rainfall)::float AS rain_mm
    FROM hourly_weather
    GROUP BY 1
    ORDER BY 1
"""

# Mirrors train_incident_models.py's DAILY_COUNTS_SQL — kept in sync by hand.
_D = "CASE WHEN date LIKE '%/%' THEN to_date(date, 'MM/DD/YYYY') ELSE date::date END"
DAILY_INCIDENT_COUNTS_SQL = f"""
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

# Mirrors src/services/map-comparison.service.ts's searchExitsInDb — kept in
# sync by hand. See that function's doc comment for why km is derived.
EXIT_REFERENCE_SQL = """
WITH seg AS (
  SELECT segment_order, start_node, end_node, length_meters,
         COALESCE(SUM(length_meters) OVER (
           ORDER BY segment_order
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS m_before
  FROM dim_location
  WHERE segment_order IS NOT NULL
), nodes AS (
  SELECT start_node AS node, m_before AS m FROM seg
  UNION ALL
  SELECT end_node, m_before + length_meters
  FROM seg WHERE segment_order = (SELECT MAX(segment_order) FROM seg)
)
SELECT x.exit_id, x.exit_name, x.latitude, x.longitude,
       ROUND((n.m / 1000.0)::numeric, 2)::float AS km
FROM nlex_exits x
LEFT JOIN nodes n ON n.node = x.exit_name
ORDER BY x.exit_id
"""

EXIT_HOUR_PANEL_SQL = """
    SELECT date_day AS d, hour_of_day, exit_id,
           AVG(GREATEST(avg_speed_kmh, 0))::float AS speed_kmh,
           SUM(total_volume)::float AS volume
    FROM bronze.nlex_traffic_volume
    WHERE exit_id IS NOT NULL
    GROUP BY date_day, hour_of_day, exit_id
"""

HOURLY_RAIN_BY_LOCATION_SQL = """
    SELECT (timestamp_utc + interval '8 hours')::date AS d,
           EXTRACT(hour FROM timestamp_utc + interval '8 hours')::int AS hour_of_day,
           UPPER(location_name) AS location_upper,
           SUM(rainfall)::float AS rain_mm
    FROM hourly_weather
    GROUP BY 1, 2, 3
"""


def load_holidays(conn) -> set:
    df = pd.read_sql("SELECT date_day FROM dim_holiday WHERE is_holiday", conn)
    return set(pd.to_datetime(df["date_day"]).dt.date)


def calendar_features(dates: pd.Series, holidays: set) -> pd.DataFrame:
    """Mirrors train_incident_models.py's calendar_features — kept in sync by hand."""
    dow = dates.dt.dayofweek
    doy = dates.dt.dayofyear
    return pd.DataFrame(
        {
            "dow": dow,
            "is_weekend": dow.isin([5, 6]).astype(int),
            "is_holiday": dates.dt.date.map(lambda x: int(x in holidays)),
            "doy_sin": np.sin(2 * np.pi * doy / 365.25),
            "doy_cos": np.cos(2 * np.pi * doy / 365.25),
        },
        index=dates.index,
    )


def load_daily_panel(conn, holidays: set) -> pd.DataFrame:
    panel = pd.read_sql(DAILY_PANEL_SQL, conn)
    panel["d"] = pd.to_datetime(panel["d"])

    rain = pd.read_sql(DAILY_RAIN_SQL, conn)
    rain["d"] = pd.to_datetime(rain["d"])
    incidents = pd.read_sql(DAILY_INCIDENT_COUNTS_SQL, conn)
    incidents["d"] = pd.to_datetime(incidents["d"])

    # bronze.nlex_traffic_volume's speed/volume readings run through
    # 2026-12-31, well past where hourly_weather (2026-08-30) and the
    # incident logs (2026-07-25) actually have anything to join against —
    # months of synthetic-only padding with no real weather or incident
    # signal behind it. Capped here to the earlier of the two, so every
    # training row has genuine rain and incident-count data, not a
    # fillna(0) standing in for "not recorded yet".
    coverage_end = min(rain["d"].max(), incidents["d"].max())
    panel = panel[panel["d"] <= coverage_end]

    panel = panel.merge(rain, on="d", how="left")
    panel["rain_mm"] = panel["rain_mm"].fillna(0.0)

    panel = panel.merge(incidents.rename(columns={"total": "incident_count"}), on="d", how="left")
    panel["incident_count"] = panel["incident_count"].fillna(0.0)
    panel = panel.sort_values("d").reset_index(drop=True)

    # A second, sharper data-quality problem, found by inspecting the tail
    # directly: avg_speed_kmh falls off a cliff on 2026-04-19 (8.6 -> 1.2 in
    # a single day) and stays essentially flat (std=0.06 across the
    # following 90+ days) all the way to the end of the coverage window
    # above — a real corridor's speed would never sit that constant
    # regardless of weather, so this reads as the data generator switching
    # into some placeholder/degenerate mode rather than a genuine traffic
    # event. Detected generally (not hardcoded to that date) so a future
    # rerun against updated data doesn't silently keep trusting a stale
    # cutoff: walk back from the most recent day to the last one whose
    # trailing 5-day rolling std still clears a "days actually vary"
    # floor — every healthy multi-month stretch elsewhere in this series
    # comfortably exceeds it; the dead tail collapses toward zero.
    roll_std = panel["speed_kmh"].rolling(5).std()
    healthy = np.where((roll_std >= 1.0).to_numpy())[0]
    if len(healthy) > 0 and healthy.max() < len(panel) - 1:
        cutoff_date = panel["d"].iloc[healthy.max()]
        dropped = len(panel) - (healthy.max() + 1)
        print(f"  dropping {dropped} day(s) after {cutoff_date.date()} — avg_speed_kmh goes flat "
              f"(a data-quality cutoff, not a real event; see load_daily_panel's comment)")
        panel = panel.iloc[: healthy.max() + 1]

    panel = panel.merge(calendar_features(panel["d"], holidays), left_index=True, right_index=True)
    panel["log_volume"] = np.log(panel["volume"].clip(lower=1.0))
    return panel.sort_values("d").reset_index(drop=True)


def load_exit_hour_panel(conn, exits_df: pd.DataFrame) -> pd.DataFrame:
    panel = pd.read_sql(EXIT_HOUR_PANEL_SQL, conn)
    panel["d"] = pd.to_datetime(panel["d"])

    rain = pd.read_sql(HOURLY_RAIN_BY_LOCATION_SQL, conn)
    rain["d"] = pd.to_datetime(rain["d"])
    exit_upper = exits_df[["exit_id", "exit_name"]].copy()
    exit_upper["location_upper"] = exit_upper["exit_name"].str.upper()
    rain_by_exit = rain.merge(exit_upper[["exit_id", "location_upper"]], on="location_upper", how="inner")
    panel = panel.merge(rain_by_exit[["d", "hour_of_day", "exit_id", "rain_mm"]],
                         on=["d", "hour_of_day", "exit_id"], how="left")
    panel["rain_mm"] = panel["rain_mm"].fillna(0.0)

    panel = panel.merge(exits_df[["exit_id", "exit_name", "km"]], on="exit_id", how="left")
    panel["dow"] = panel["d"].dt.dayofweek
    panel["log_volume"] = np.log(panel["volume"].clip(lower=1.0))
    return panel.sort_values(["exit_id", "d", "hour_of_day"]).reset_index(drop=True)


# ---------------------------------------------------------------------------
# Daily speed/volume forecast — SARIMAX / LSTM / GRU / XGBoost compare
# ---------------------------------------------------------------------------
FEATURE_COLS = ["dow", "is_weekend", "is_holiday", "doy_sin", "doy_cos", "rain_mm", "log_volume"]
EXOG_COLS = ["is_weekend", "is_holiday", "doy_sin", "doy_cos", "rain_mm", "log_volume"]
# Added after diagnosing XGBoost's negative holdout R2 despite a MAE well
# below the naive baseline: its holdout predictions had pred_std=0.66 against
# the holdout's own actual std=1.61 (speed_kmh) — with only calendar/rain/
# volume to go on, the model regressed every day toward a narrow band instead
# of tracking real day-to-day movement. lag_1/lag_7/roll_mean_7 is exactly the
# signal that was missing; mirrors train_incident_models.py's own lag
# features and rationale.
LAG_FEATURE_COLS = ["lag_1", "lag_7", "roll_mean_7"]
TABULAR_FEATURE_COLS = FEATURE_COLS + LAG_FEATURE_COLS


def add_lag_features(panel: pd.DataFrame, target_col: str) -> pd.DataFrame:
    out = panel.copy()
    out["lag_1"] = out[target_col].shift(1)
    out["lag_7"] = out[target_col].shift(7)
    out["roll_mean_7"] = out[target_col].shift(1).rolling(7, min_periods=1).mean()
    return out


def _make_sequences(y: np.ndarray, lo: int, hi: int, seq_len: int) -> tuple[np.ndarray, np.ndarray]:
    xs, ys = [], []
    for i in range(max(lo, seq_len), hi):
        xs.append(y[i - seq_len : i])
        ys.append(y[i])
    return np.array(xs).reshape(-1, seq_len, 1), np.array(ys)


class SimpleRNN(nn.Module):
    def __init__(self, kind: str, hidden: int = 16):
        super().__init__()
        layer_cls = nn.LSTM if kind == "LSTM" else nn.GRU
        self.rnn = layer_cls(input_size=1, hidden_size=hidden, batch_first=True)
        self.head = nn.Linear(hidden, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out, _ = self.rnn(x)
        return self.head(out[:, -1, :]).squeeze(-1)


def _fit_rnn(kind: str, y_scaled: np.ndarray, train_end: int) -> SimpleRNN:
    set_all_seeds()
    X_train, y_train = _make_sequences(y_scaled, 0, train_end, SEQ_LEN)
    X_train_t = torch.tensor(X_train, dtype=torch.float32)
    y_train_t = torch.tensor(y_train, dtype=torch.float32)

    model = SimpleRNN(kind)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    loss_fn = nn.MSELoss()
    best_loss, best_state, patience_left = float("inf"), None, PATIENCE
    n_val = max(int(len(X_train_t) * 0.1), 1)
    for _ in range(EPOCHS):
        model.train()
        optimizer.zero_grad()
        pred = model(X_train_t[:-n_val])
        loss = loss_fn(pred, y_train_t[:-n_val])
        loss.backward()
        optimizer.step()
        model.eval()
        with torch.no_grad():
            val_loss = loss_fn(model(X_train_t[-n_val:]), y_train_t[-n_val:]).item()
        if val_loss < best_loss - 1e-5:
            best_loss, best_state, patience_left = val_loss, {k: v.clone() for k, v in model.state_dict().items()}, PATIENCE
        else:
            patience_left -= 1
            if patience_left <= 0:
                break
    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()
    return model


def _rnn_forecast(model: SimpleRNN, y_scaled: np.ndarray, start: int, steps: int) -> np.ndarray:
    working = list(y_scaled[:start])
    preds = []
    with torch.no_grad():
        for _ in range(steps):
            window = torch.tensor(np.array(working[-SEQ_LEN:]).reshape(1, SEQ_LEN, 1), dtype=torch.float32)
            p = float(model(window).item())
            preds.append(p)
            working.append(p)
    return np.array(preds)


def fit_daily_models(panel: pd.DataFrame, target_col: str, holdout_days: int) -> dict:
    # First 7 rows drop out here (lag_7 undefined that early) rather than
    # being imputed — a ~2300-day series can afford to lose a week off the
    # front, and it keeps every training row's lag features genuine.
    lagged = add_lag_features(panel, target_col).iloc[7:].reset_index(drop=True)
    n = len(lagged)
    train_end = n - holdout_days
    train, holdout = lagged.iloc[:train_end], lagged.iloc[train_end:]
    y_train, y_holdout = train[target_col].values, holdout[target_col].values

    results: dict[str, dict] = {}

    xgb = XGBRegressor(n_estimators=200, max_depth=4, learning_rate=0.05, subsample=0.9, colsample_bytree=0.9, random_state=SEED)
    xgb.fit(train[TABULAR_FEATURE_COLS], y_train)
    # Recursive one-step holdout forecast, not a single vectorized .predict()
    # over the whole holdout block: lag_1/lag_7/roll_mean_7 for holdout day i
    # must come from what a real forecast would actually know at that point
    # — real history for the first few days, this model's own prior
    # predictions once the recursion runs past the last training day. Reading
    # every holdout day's lag features off the ACTUAL future value (what a
    # single vectorized call over holdout[TABULAR_FEATURE_COLS] would do) is
    # exactly the leak this loop avoids — same pattern as
    # train_incident_models.py's final_tabular_forecast.
    history = list(lagged[target_col].values[:train_end])
    xgb_pred = []
    for i in range(len(holdout)):
        row = holdout[FEATURE_COLS].iloc[[i]].copy()
        row["lag_1"] = history[-1]
        row["lag_7"] = history[-7]
        row["roll_mean_7"] = float(np.mean(history[-7:]))
        p = float(xgb.predict(row[TABULAR_FEATURE_COLS])[0])
        xgb_pred.append(p)
        history.append(p)
    results["XGBoost"] = {"pred": np.array(xgb_pred), "model": xgb}

    try:
        sarimax_res = SARIMAX(
            y_train, exog=train[EXOG_COLS], order=(1, 0, 1), seasonal_order=(1, 0, 1, 7),
            enforce_stationarity=False, enforce_invertibility=False,
        ).fit(disp=False)
        sarimax_pred = np.asarray(sarimax_res.get_forecast(steps=len(holdout), exog=holdout[EXOG_COLS]).predicted_mean)
        results["SARIMAX"] = {"pred": sarimax_pred, "model": sarimax_res}
    except Exception as e:
        print(f"  SARIMAX failed ({e}) — dropped from comparison")

    scaler_mean, scaler_std = y_train.mean(), y_train.std() or 1.0
    y_scaled = ((lagged[target_col].values - scaler_mean) / scaler_std).astype("float32")
    for kind in ("LSTM", "GRU"):
        try:
            model = _fit_rnn(kind, y_scaled, train_end)
            pred_scaled = _rnn_forecast(model, y_scaled, train_end, len(holdout))
            results[kind] = {"pred": pred_scaled * scaler_std + scaler_mean, "model": model}
        except Exception as e:
            print(f"  {kind} failed ({e}) — dropped from comparison")

    metrics = {}
    for name, r in results.items():
        pred = np.clip(r["pred"], 0, None)
        metrics[name] = {
            "MAE": float(mean_absolute_error(y_holdout, pred)),
            "RMSE": float(np.sqrt(mean_squared_error(y_holdout, pred))),
            "R2": float(r2_score(y_holdout, pred)),
            "n": int(len(y_holdout)),
        }
    champion = min(metrics, key=lambda k: metrics[k]["MAE"])
    # Honest degradation flag, same idea as train_incident_models.py's
    # MASE<=1.0 bar: a naive "predict the training mean" baseline, scored on
    # the identical holdout. None of the four candidates beating it would
    # mean rain/volume/calendar carry no learnable signal for this
    # warehouse's speed column beyond its own average — worth stating
    # plainly rather than presenting a technically-lowest-MAE champion as if
    # it had cleared a real bar.
    naive_pred = np.full_like(y_holdout, y_train.mean())
    naive_mae = float(mean_absolute_error(y_holdout, naive_pred))
    degraded = metrics[champion]["MAE"] >= naive_mae

    return {
        "champion": champion,
        "metrics": metrics,
        "naive_mae": naive_mae,
        "degraded": degraded,
        "holdout_dates": holdout["d"].tolist(),
        "holdout_pred": {name: np.clip(r["pred"], 0, None) for name, r in results.items()},
        "holdout_actual": y_holdout,
        "fitted_models": results,
        "train_end": train_end,
    }


# ---------------------------------------------------------------------------
# Logistic regressions: road closure probability, weather incident risk
# ---------------------------------------------------------------------------
def fit_logistic_kpi(panel: pd.DataFrame, target_col: str, holdout_days: int) -> dict:
    n = len(panel)
    train_end = n - holdout_days
    train, holdout = panel.iloc[:train_end], panel.iloc[train_end:]

    X_train = sm.add_constant(train[FEATURE_COLS], has_constant="add")
    X_holdout = sm.add_constant(holdout[FEATURE_COLS], has_constant="add")
    y_train, y_holdout = train[target_col].values, holdout[target_col].values

    model = sm.Logit(y_train, X_train).fit(disp=False, maxiter=200)
    proba = np.asarray(model.predict(X_holdout))
    auc = float(roc_auc_score(y_holdout, proba)) if len(np.unique(y_holdout)) > 1 else None

    # Scenario curve: predicted probability at a handful of rain totals,
    # every other feature held at its training-set mean — the KPI's
    # interpretable "how much does rain alone move this" summary.
    mean_row = train[FEATURE_COLS].mean()
    scenario_rows = []
    for rain_mm in RAIN_SCENARIOS_MM:
        row = mean_row.copy()
        row["rain_mm"] = rain_mm
        row = sm.add_constant(row.to_frame().T, has_constant="add")[X_train.columns]
        p = float(np.asarray(model.predict(row))[0])
        scenario_rows.append({"rain_mm": rain_mm, "probability": p})

    # A second scenario curve, swept over traffic volume instead of rain, held
    # at the training-set quantiles of the *raw* volume column (translated to
    # log_volume for the design matrix, reported back in raw terms) — added
    # after diagnosing why the rain curve above is nearly flat: on this
    # corridor's data, log_volume's coefficient standardizes to an effect size
    # roughly 20-40x rain_mm's (verified directly: |coef*std| ~1.3 and ~2.1 for
    # log_volume on road_closure/high_incident_day respectively, vs ~0.03-0.06
    # for rain_mm, whose p-value never clears 0.05 either). The rain curve
    # isn't broken — it's honestly reporting a weak driver. This one shows the
    # driver that actually moves the number.
    volume_quantiles = train["volume"].quantile([0.1, 0.3, 0.5, 0.7, 0.9])
    volume_scenario_rows = []
    for volume in volume_quantiles:
        row = mean_row.copy()
        row["log_volume"] = float(np.log(max(volume, 1.0)))
        row = sm.add_constant(row.to_frame().T, has_constant="add")[X_train.columns]
        p = float(np.asarray(model.predict(row))[0])
        volume_scenario_rows.append({"volume": float(volume), "probability": p})

    # Standardized effect size (|coefficient| * feature std) for every
    # non-intercept term, so the strongest driver can be named directly
    # instead of a reader having to eyeball raw log-odds coefficients that
    # live on wildly different scales (rain_mm ranges into the thousands,
    # log_volume sits between 12 and 15).
    feature_std = train[FEATURE_COLS].std()
    effect_size = (model.params.drop("const") * feature_std).abs().sort_values(ascending=False)
    top_feature = effect_size.index[0]
    rain_p_value = float(model.pvalues.get("rain_mm", float("nan")))

    return {
        "auc": auc,
        "base_rate": float(y_holdout.mean()),
        "n": int(len(y_holdout)),
        "scenarios": scenario_rows,
        "volumeScenarios": volume_scenario_rows,
        "rainSignificant": bool(np.isfinite(rain_p_value) and rain_p_value < 0.05),
        "rainPValue": rain_p_value if np.isfinite(rain_p_value) else None,
        "topDriver": {"feature": str(top_feature), "effectSize": float(effect_size.iloc[0])},
    }


# ---------------------------------------------------------------------------
# Contour: XGBoost at (exit, hour) grain, predicted on a dry/wet grid
# ---------------------------------------------------------------------------
CONTOUR_FEATURES = ["hour_of_day", "km", "dow", "log_volume", "rain_mm"]


def fit_contour(panel: pd.DataFrame, exits_df: pd.DataFrame, holdout_days: int) -> dict:
    cutoff = panel["d"].max() - pd.Timedelta(days=holdout_days)
    train, holdout = panel[panel["d"] < cutoff], panel[panel["d"] >= cutoff]

    model = XGBRegressor(n_estimators=200, max_depth=5, learning_rate=0.05, subsample=0.9, colsample_bytree=0.9, random_state=SEED)
    model.fit(train[CONTOUR_FEATURES], train["speed_kmh"])
    holdout_pred = model.predict(holdout[CONTOUR_FEATURES])
    metrics = {
        "MAE": float(mean_absolute_error(holdout["speed_kmh"], holdout_pred)),
        "R2": float(r2_score(holdout["speed_kmh"], holdout_pred)),
        "n": int(len(holdout)),
    }

    # Synthetic grid: every (exit, hour) combination, volume/dow held at
    # their training-set means — a "typical day" backdrop so the dry vs wet
    # comparison isolates rain's effect rather than mixing in which hours
    # happen to be busiest.
    mean_log_volume = train["log_volume"].mean()
    mean_dow = train["dow"].mean()
    grid_rows = []
    for _, exit_row in exits_df.iterrows():
        for hour in range(24):
            for scenario, rain_mm in (("dry", 0.0), ("wet", WET_SCENARIO_MM)):
                grid_rows.append({
                    "exit_id": exit_row["exit_id"], "exit_name": exit_row["exit_name"], "km": exit_row["km"],
                    "hour_of_day": hour, "scenario": scenario, "rain_mm": rain_mm,
                    "dow": mean_dow, "log_volume": mean_log_volume,
                })
    grid = pd.DataFrame(grid_rows)
    grid["predicted_speed_kmh"] = np.clip(model.predict(grid[CONTOUR_FEATURES]), 0, None)

    return {"metrics": metrics, "grid": grid}


# ---------------------------------------------------------------------------
# DB write
# ---------------------------------------------------------------------------
def ensure_schema(conn, commit: bool = True) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE SCHEMA IF NOT EXISTS gold;

            CREATE TABLE IF NOT EXISTS gold.ml_weather_speed_forecast (
                id SERIAL PRIMARY KEY,
                forecast_date DATE NOT NULL,
                actual_speed_kmh DOUBLE PRECISION,
                predicted_speed_kmh DOUBLE PRECISION NOT NULL,
                speed_model TEXT NOT NULL,
                actual_volume DOUBLE PRECISION,
                predicted_volume DOUBLE PRECISION,
                rain_mm DOUBLE PRECISION,
                trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (forecast_date)
            );

            CREATE TABLE IF NOT EXISTS gold.ml_weather_speed_contour (
                id SERIAL PRIMARY KEY,
                exit_id INT NOT NULL,
                exit_name TEXT NOT NULL,
                km DOUBLE PRECISION NOT NULL,
                hour_of_day INT NOT NULL,
                scenario TEXT NOT NULL,
                predicted_speed_kmh DOUBLE PRECISION NOT NULL,
                trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (exit_id, hour_of_day, scenario)
            );

            CREATE TABLE IF NOT EXISTS gold.ml_weather_speed_metadata (
                id SERIAL PRIMARY KEY,
                metadata_json JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            """
        )
    if commit:
        conn.commit()


def write_to_db(conn, panel: pd.DataFrame, speed_out: dict, volume_pred: np.ndarray,
                 contour_out: dict, metadata: dict, dry: bool = False) -> None:
    ensure_schema(conn, commit=not dry)

    dates = speed_out["holdout_dates"]
    champ_pred_speed = speed_out["holdout_pred"][speed_out["champion"]]
    actual_speed = speed_out["holdout_actual"]
    rain_by_date = dict(zip(panel["d"], panel["rain_mm"]))
    actual_volume = panel.set_index("d").loc[dates, "volume"].values

    def num(v):
        return None if v is None or (isinstance(v, float) and not np.isfinite(v)) else float(v)

    rows = [
        (d.date(), num(actual_speed[i]), num(champ_pred_speed[i]), speed_out["champion"],
         num(actual_volume[i]), num(volume_pred[i]), num(rain_by_date.get(d)))
        for i, d in enumerate(dates)
    ]

    with conn.cursor() as cur:
        cur.execute("DELETE FROM gold.ml_weather_speed_forecast")
        psycopg2.extras.execute_values(
            cur,
            """INSERT INTO gold.ml_weather_speed_forecast
               (forecast_date, actual_speed_kmh, predicted_speed_kmh, speed_model,
                actual_volume, predicted_volume, rain_mm) VALUES %s""",
            rows,
        )

        cur.execute("DELETE FROM gold.ml_weather_speed_contour")
        grid = contour_out["grid"]
        psycopg2.extras.execute_values(
            cur,
            """INSERT INTO gold.ml_weather_speed_contour
               (exit_id, exit_name, km, hour_of_day, scenario, predicted_speed_kmh) VALUES %s""",
            [(int(r.exit_id), r.exit_name, float(r.km), int(r.hour_of_day), r.scenario, float(r.predicted_speed_kmh))
             for r in grid.itertuples()],
        )

        cur.execute("DELETE FROM gold.ml_weather_speed_metadata")
        cur.execute("INSERT INTO gold.ml_weather_speed_metadata (metadata_json) VALUES (%s)",
                    [json.dumps(metadata, default=str)])

    if dry:
        conn.rollback()
        print("DRY WRITE: every query ran, transaction rolled back — gold.* is unchanged")
    else:
        conn.commit()


def print_report(speed_out: dict, closure_out: dict, risk_out: dict, contour_out: dict) -> str:
    L = []
    L.append("=" * 80)
    L.append("  WEATHER-ADJUSTED SPEED MODELS")
    L.append("=" * 80)
    L.append("")
    L.append("  Daily speed forecast — holdout comparison")
    for name, m in speed_out["metrics"].items():
        tag = "[SELECTED]" if name == speed_out["champion"] else ""
        L.append(f"    {name:<10} MAE={m['MAE']:.3f}  RMSE={m['RMSE']:.3f}  R2={m['R2']:.3f}  n={m['n']}  {tag}")
    L.append(f"    naive (predict training mean) MAE = {speed_out['naive_mae']:.3f}")
    if speed_out["degraded"]:
        L.append("    WARNING: no candidate beat the naive mean baseline — rain/volume/calendar carry")
        L.append("             little learnable signal for this warehouse's speed column beyond its own average.")
    L.append("")
    L.append("  Road closure probability — logistic regression")
    L.append(f"    AUC = {closure_out['auc']:.3f}" if closure_out["auc"] is not None else "    AUC = n/a")
    L.append(f"    base rate = {closure_out['base_rate'] * 100:.1f}%  n={closure_out['n']}")
    L.append(f"    top driver = {closure_out['topDriver']['feature']} (effect size {closure_out['topDriver']['effectSize']:.3f})"
              f"  |  rain_mm significant at p<0.05: {closure_out['rainSignificant']} (p={closure_out['rainPValue']:.3f})"
              if closure_out["rainPValue"] is not None else "    rain_mm p-value = n/a")
    for s in closure_out["scenarios"]:
        L.append(f"      rain={s['rain_mm']:>4}mm -> P(closure) = {s['probability']:.3f}")
    for s in closure_out["volumeScenarios"]:
        L.append(f"      volume={s['volume']:>8,.0f} -> P(closure) = {s['probability']:.3f}")
    L.append("")
    L.append("  Weather incident risk — logistic regression")
    L.append(f"    AUC = {risk_out['auc']:.3f}" if risk_out["auc"] is not None else "    AUC = n/a")
    L.append(f"    base rate = {risk_out['base_rate'] * 100:.1f}%  n={risk_out['n']}")
    L.append(f"    top driver = {risk_out['topDriver']['feature']} (effect size {risk_out['topDriver']['effectSize']:.3f})"
              f"  |  rain_mm significant at p<0.05: {risk_out['rainSignificant']} (p={risk_out['rainPValue']:.3f})"
              if risk_out["rainPValue"] is not None else "    rain_mm p-value = n/a")
    for s in risk_out["scenarios"]:
        L.append(f"      rain={s['rain_mm']:>4}mm -> P(high-incident day) = {s['probability']:.3f}")
    for s in risk_out["volumeScenarios"]:
        L.append(f"      volume={s['volume']:>8,.0f} -> P(high-incident day) = {s['probability']:.3f}")
    L.append("")
    L.append("  Contour (exit x hour) — XGBoost holdout")
    L.append(f"    MAE={contour_out['metrics']['MAE']:.3f}  R2={contour_out['metrics']['R2']:.3f}  n={contour_out['metrics']['n']}")
    L.append("=" * 80)
    return "\n".join(L)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-db", action="store_true")
    parser.add_argument("--dry-write", action="store_true")
    parser.add_argument("--holdout-days", type=int, default=90)
    args = parser.parse_args()

    conn = get_conn()
    try:
        print("Loading daily corridor-wide panel (speed/volume/rain/incidents)...")
        holidays = load_holidays(conn)
        daily = load_daily_panel(conn, holidays)
        print(f"  {len(daily)} days ({daily['d'].min().date()}..{daily['d'].max().date()})")

        print("\nFitting daily speed models (SARIMAX / LSTM / GRU / XGBoost)...")
        speed_out = fit_daily_models(daily, "speed_kmh", args.holdout_days)

        print(f"Refitting champion architecture ({speed_out['champion']}) on daily volume...")
        volume_out = fit_daily_models(daily, "volume", args.holdout_days)
        volume_pred = volume_out["holdout_pred"].get(speed_out["champion"], volume_out["holdout_pred"][volume_out["champion"]])

        print("\nFitting road-closure and weather-incident-risk logistic regressions...")
        # Training-set-derived threshold, not a fixed guess — but jam level
        # alone, not the OR-with-speed-floor rule an earlier version of this
        # script used. Checked directly: speed_kmh_min sits at its
        # physically-impossible floor of 0 on fully half of all days (median
        # daily-minimum speed IS 0), a side effect of clipping this
        # warehouse's negative "speed" noise — so any threshold near 0 on
        # that column flags an unusably large, non-rare share of days. Jam
        # level has none of that degeneracy (its own 95th percentile is a
        # clean ~5% tail), so it alone defines "closure" here.
        train_slice = daily.iloc[: len(daily) - args.holdout_days]
        jam_ceiling = train_slice["jam_level_max"].quantile(0.95)
        daily["road_closure"] = (daily["jam_level_max"] >= jam_ceiling).astype(int)
        print(f"  closure rule: daily max jam >= {jam_ceiling:.2f} "
              f"({daily['road_closure'].mean() * 100:.1f}% of all days)")

        # "Any incident" is not a usable target here — the corridor logs at
        # least 2 incidents on every single day in this data (median 26),
        # so a >0 threshold is a constant column and the logistic fit is
        # singular. "High incident day" (top quartile, by the TRAINING
        # distribution) is what "weather incident risk" can actually mean on
        # a corridor this busy: not "will anything happen" but "will today
        # run unusually heavy".
        incident_ceiling = train_slice["incident_count"].quantile(0.75)
        daily["high_incident_day"] = (daily["incident_count"] >= incident_ceiling).astype(int)
        print(f"  high-incident-day rule: incident_count >= {incident_ceiling:.0f} "
              f"({daily['high_incident_day'].mean() * 100:.1f}% of all days)")

        closure_out = fit_logistic_kpi(daily, "road_closure", args.holdout_days)
        risk_out = fit_logistic_kpi(daily, "high_incident_day", args.holdout_days)

        print("\nLoading exit reference and per-(exit, hour) panel...")
        exits_df = pd.read_sql(EXIT_REFERENCE_SQL, conn)
        exit_hour_panel = load_exit_hour_panel(conn, exits_df)
        print(f"  {len(exit_hour_panel)} exit-hour-day rows across {exits_df['exit_id'].nunique()} exits")

        print("Fitting weather-adjusted speed contour (XGBoost)...")
        contour_out = fit_contour(exit_hour_panel, exits_df, args.holdout_days)

        report = print_report(speed_out, closure_out, risk_out, contour_out)
        print("\n" + report)
        report_path = Path(__file__).resolve().parent / "model_results_weather_speed.txt"
        report_path.write_text(report, encoding="utf-8")
        print(f"\nFull report written to {report_path}")

        if not args.write_db and not args.dry_write:
            print("\nTraining complete. Re-run with --write-db once you've reviewed the report above.")
            return

        metadata = {
            "speed": {"champion": speed_out["champion"], "metrics": speed_out["metrics"],
                      "naive_mae": speed_out["naive_mae"], "degraded": speed_out["degraded"]},
            "volume_refit_of": speed_out["champion"],
            "volume_metrics": volume_out["metrics"].get(speed_out["champion"], volume_out["metrics"][volume_out["champion"]]),
            "road_closure": {"auc": closure_out["auc"], "base_rate": closure_out["base_rate"], "n": closure_out["n"],
                              "scenarios": closure_out["scenarios"], "volumeScenarios": closure_out["volumeScenarios"],
                              "rainSignificant": closure_out["rainSignificant"], "rainPValue": closure_out["rainPValue"],
                              "topDriver": closure_out["topDriver"], "jam_ceiling": float(jam_ceiling)},
            "weather_incident_risk": {"auc": risk_out["auc"], "base_rate": risk_out["base_rate"], "n": risk_out["n"],
                                       "scenarios": risk_out["scenarios"], "volumeScenarios": risk_out["volumeScenarios"],
                                       "rainSignificant": risk_out["rainSignificant"], "rainPValue": risk_out["rainPValue"],
                                       "topDriver": risk_out["topDriver"]},
            "contour": {"metrics": contour_out["metrics"], "wet_scenario_mm": WET_SCENARIO_MM},
            "holdout_days": args.holdout_days,
            "trained_at": pd.Timestamp.utcnow().isoformat(),
        }
        print("\nWriting gold.ml_weather_speed_forecast / ml_weather_speed_contour / ml_weather_speed_metadata...")
        write_to_db(conn, daily, speed_out, volume_pred, contour_out, metadata,
                    dry=args.dry_write and not args.write_db)
        print("Rolled back (dry write)." if (args.dry_write and not args.write_db) else "Committed.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
