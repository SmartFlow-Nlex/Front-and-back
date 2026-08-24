#!/usr/bin/env python3
"""
SmartFlow NLEX — Incident Predictive Pipeline (baseline)
=========================================================
Minimal single-model baseline: one XGBoost regressor on daily incident
counts, with lag/rolling/calendar/year-over-year features. Reads the three
incident operations logs (nlex_road_crashes, nlex_motorcycle_crashes,
nlex_stalled_vehicles) and writes ml_daily_actuals / ml_predictive_incidents /
ml_training_metadata (default/public schema, unqualified) in one transaction.

This is intentionally NOT the full 7-model comparison (XGBoost, LSTM, RF,
GRU, Poisson GLM, Negative Binomial GLM, SARIMAX) — that's a follow-up once
this baseline is confirmed working end to end. Getting one real model's
output into the dashboard first is the point of this script.

Usage:
    .venv/Scripts/python.exe run_predictive_pipeline.py
"""
from __future__ import annotations

import json
import os
import sys
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from xgboost import XGBRegressor

VALIDATION_DAYS = 14
FUTURE_DAYS = 7
CHAMPION_MODEL = "XGBoost"

# Kept identical to train_incident_models.py so both scripts write compatible
# rows to the same three tables. See that file for why lag_364 (same weekday one
# year back) is the year-over-year term rather than lag_365.
YOY_LAG = 364
FEATURE_COLS = [
    "dow", "is_weekend", "is_holiday",
    "month", "doy_sin", "doy_cos",
    "lag_1", "lag_7", "lag_14",
    "roll_mean_7", "roll_mean_14", "roll_mean_28",
    "lag_364", "yoy_mean_5",
]
HOLIDAY_DATES: set = set()

# Daily incident counts from the three operations logs, matching INCIDENTS_CTE in
# src/services/incident.service.ts. `date` is TEXT in two formats.
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

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def get_conn():
    dsn = os.environ.get("PGURL") or os.environ.get("POSTGRES_URL")
    if not dsn:
        sys.exit("PGURL or POSTGRES_URL must be set (checked Back-End/.env)")
    # RDS enforces SSL at pg_hba.conf; sslmode=require matches the fix applied
    # to the Node side (src/config/db.ts) so both clients negotiate the same way.
    return psycopg2.connect(dsn, sslmode="require")


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

            -- Same contract as train_incident_models.py: the dashboard reads
            -- this column to show what a forecast is reasoning from.
            ALTER TABLE ml_predictive_incidents
                ADD COLUMN IF NOT EXISTS same_day_last_year DOUBLE PRECISION;
            """
        )
    conn.commit()


def load_daily_counts(conn) -> pd.DataFrame:
    df = pd.read_sql(DAILY_COUNTS_SQL, conn)
    if df.empty:
        sys.exit("The incident source tables returned no rows — nothing to train on")

    df["d"] = pd.to_datetime(df["d"])
    # Fill gaps in the calendar with 0 incidents so lag/rolling features don't
    # silently skip over days the source had nothing to report.
    full_range = pd.date_range(df["d"].min(), df["d"].max(), freq="D")
    df = df.set_index("d").reindex(full_range, fill_value=0.0).rename_axis("d").reset_index()
    return df


def load_holidays(conn) -> set:
    df = pd.read_sql("SELECT date_day FROM dim_holiday WHERE is_holiday", conn)
    return set(pd.to_datetime(df["date_day"]).dt.date)


def calendar_features(dates: pd.Series) -> pd.DataFrame:
    """Calendar columns for any date, past or future — no observed data needed."""
    dow = dates.dt.dayofweek
    doy = dates.dt.dayofyear
    return pd.DataFrame(
        {
            "dow": dow,
            "is_weekend": dow.isin([5, 6]).astype(int),
            "is_holiday": dates.dt.date.map(lambda x: int(x in HOLIDAY_DATES)),
            "month": dates.dt.month,
            "doy_sin": np.sin(2 * np.pi * doy / 365.25),
            "doy_cos": np.cos(2 * np.pi * doy / 365.25),
        },
        index=dates.index,
    )


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out[["dow", "is_weekend", "is_holiday", "month", "doy_sin", "doy_cos"]] = calendar_features(out["d"])
    for lag in (1, 7, 14, YOY_LAG):
        out[f"lag_{lag}"] = out["total"].shift(lag)
    out["roll_mean_7"] = out["total"].shift(1).rolling(7).mean()
    out["roll_mean_14"] = out["total"].shift(1).rolling(14).mean()
    out["roll_mean_28"] = out["total"].shift(1).rolling(28).mean()
    out["yoy_mean_5"] = out["total"].shift(YOY_LAG - 2).rolling(5).mean()
    return out


def forecast_future(model: XGBRegressor, history: pd.DataFrame, days: int) -> list[tuple[pd.Timestamp, float]]:
    """Rolls the model forward day by day, feeding each prediction back in as
    if it were observed history — there's no real future data to lag against."""
    rows: list[tuple[pd.Timestamp, float]] = []
    working = history[["d", "total"]].copy()
    for _ in range(days):
        next_date = working["d"].iloc[-1] + timedelta(days=1)
        candidate = pd.concat([working, pd.DataFrame([{"d": next_date, "total": np.nan}])], ignore_index=True)
        feat_row = build_features(candidate).iloc[[-1]]
        pred = max(float(model.predict(feat_row[FEATURE_COLS])[0]), 0.0)
        rows.append((next_date, pred))
        working = pd.concat([working, pd.DataFrame([{"d": next_date, "total": pred}])], ignore_index=True)
    return rows


def main() -> None:
    global HOLIDAY_DATES

    conn = get_conn()
    try:
        ensure_schema(conn)

        print("Loading daily incident counts (road + motorcycle crashes + stalled vehicles)...")
        daily = load_daily_counts(conn)
        print(f"  {len(daily)} calendar days, {int(daily['total'].sum())} total incidents")

        # Must happen before build_features — an unpopulated HOLIDAY_DATES would
        # silently mark every day a non-holiday rather than failing.
        HOLIDAY_DATES = load_holidays(conn)
        print(f"  {len(HOLIDAY_DATES)} holiday dates loaded from dim_holiday")

        feat = build_features(daily).dropna(subset=FEATURE_COLS).reset_index(drop=True)
        if len(feat) < VALIDATION_DAYS + 30:
            sys.exit(f"Not enough history to train: only {len(feat)} usable rows after feature warm-up")

        train, val = feat.iloc[:-VALIDATION_DAYS], feat.iloc[-VALIDATION_DAYS:]

        print(f"Training {CHAMPION_MODEL} on {len(train)} days, validating on last {len(val)}...")
        model = XGBRegressor(
            n_estimators=200,
            max_depth=4,
            learning_rate=0.05,
            subsample=0.9,
            colsample_bytree=0.9,
            random_state=42,
        )
        model.fit(train[FEATURE_COLS], train["total"])

        val_pred = model.predict(val[FEATURE_COLS])
        mae = float(mean_absolute_error(val["total"], val_pred))
        rmse = float(np.sqrt(mean_squared_error(val["total"], val_pred)))
        r2 = float(r2_score(val["total"], val_pred))
        # Seasonal-naive (same day last week) as the MASE denominator baseline.
        naive_mae = float(mean_absolute_error(val["total"], val["lag_7"]))
        mase = float(mae / naive_mae) if naive_mae > 0 else None

        print(f"  MAE={mae:.3f}  RMSE={rmse:.3f}  R2={r2:.4f}  MASE={mase}")

        print(f"Forecasting next {FUTURE_DAYS} days...")
        future_rows = forecast_future(model, feat, FUTURE_DAYS)

        importances = model.feature_importances_
        feature_importance = sorted(
            ({"feature": f, "importance": float(v)} for f, v in zip(FEATURE_COLS, importances)),
            key=lambda x: x["importance"],
            reverse=True,
        )

        metadata = {
            "champion_model": CHAMPION_MODEL,
            "metrics": {
                "MAE": round(mae, 3),
                "RMSE": round(rmse, 3),
                "R2": round(r2, 4),
                "MASE": round(mase, 3) if mase is not None else None,
            },
            "feature_importance": feature_importance,
        }

        print("Writing ml_daily_actuals, ml_predictive_incidents, ml_training_metadata (one transaction)...")
        with conn.cursor() as cur:
            cur.execute("DELETE FROM ml_daily_actuals")
            psycopg2.extras.execute_values(
                cur,
                "INSERT INTO ml_daily_actuals (d, total) VALUES %s",
                [(row.d.date(), float(row.total)) for row in daily.itertuples()],
            )

            cur.execute("DELETE FROM ml_predictive_incidents")
            actual_by_date = {row.d.date(): float(row.total) for row in daily.itertuples()}
            yoy = lambda d: actual_by_date.get(d - timedelta(days=YOY_LAG))
            pred_rows = [
                (row.d.date(), "validation", float(p), CHAMPION_MODEL, yoy(row.d.date()))
                for row, p in zip(val.itertuples(), val_pred)
            ] + [(d.date(), "future", p, CHAMPION_MODEL, yoy(d.date())) for d, p in future_rows]
            psycopg2.extras.execute_values(
                cur,
                "INSERT INTO ml_predictive_incidents "
                "(forecast_date, prediction_type, predicted_incident_count, champion_model, "
                "same_day_last_year) VALUES %s",
                pred_rows,
            )

            cur.execute("DELETE FROM ml_training_metadata")
            cur.execute("INSERT INTO ml_training_metadata (metadata_json) VALUES (%s)", [json.dumps(metadata)])

        conn.commit()
        print("Committed.")
        print(json.dumps(metadata, indent=2))
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
