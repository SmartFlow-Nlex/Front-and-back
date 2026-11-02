#!/usr/bin/env python3
"""
Weekly batch retrain and test — every Sunday at 22:00.

SmartFlow retrains its models once a week, in one batch, on the schedule agreed
with the adviser. Uploading a file never retrains anything: an upload only loads
data, and the next Sunday batch picks it up.

For each model group, the batch:
  1. checks whether the group's input data changed since the group was last
     trained. It compares row count, latest date and a column total for each
     input table, so new rows, later dates and corrected values (a re-upload of
     the same days) all count as a change. A group whose data did not change is
     left alone, and the run records that.
  2. backs up the group's current outputs to the ml_backup schema: its forecast
     tables, and its own rows in the shared metric tables. Where later runs load
     a saved model (the hourly congestion refresh, the 48-hour forecast), the
     model files are copied aside as well.
  2b. checks the forecasts already published against the real data that has
     arrived since they were made (the "feedback" of the MLOps feedback loop in
     the architecture diagram). A forecast for July is a guess until July's
     records are uploaded; once they are, how far off it was is the only
     measure of the model on days it had never seen. The result is recorded
     in gold.ml_forecast_feedback and on the run, and a model that did worse
     than "the same weekday last week" is marked as drifted. It is measured
     BEFORE retraining, because retraining replaces those forecasts.
  3. clears the trainers' prediction caches. Those caches are keyed on row count
     and latest date only, so a corrected upload would otherwise reuse the old
     results.
  4. runs the group's trainers one at a time, because two at once ran this
     machine out of memory. A trainer that fails is retried once.
  5. tests the result (Gate 5 in the architecture diagram):
       - every trainer finished cleanly and wrote new results
       - the forecasts exist, and none is negative or implausible
       - for every target, the champion still exists; it still beats its best
         baseline if it did before; it still has MASE < 1 if it did before;
         and its main metric is not materially worse than before
  6. keeps the new models if they pass. Otherwise it restores the backup, so the
     dashboard keeps last week's models, and records why.

Every run is recorded in gold.ml_batch_runs, which the Data Management page
shows. The last backup of each group stays in ml_backup, so
`--restore <group>` puts back the version from before the latest retrain.

Usage, from this folder:
  python weekly_retrain.py                         the batch (the scheduled task adds --scheduled)
  python weekly_retrain.py --plan                  read-only: what changed, what would run, current test results
  python weekly_retrain.py --force                 retrain even where no data changed
  python weekly_retrain.py --only volume,emissions
  python weekly_retrain.py --restore volume        put back the version before the latest retrain
  python weekly_retrain.py --test-restore volume   back up, restore and compare (proves rollback on the live tables)

The task is registered by register_weekly_task.ps1.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import shutil
import subprocess
import sys
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import psycopg2

HERE = Path(__file__).resolve().parent
TT = HERE.parent                                        # 3_training_testing
ROOT = TT.parent                                        # smartflow_scripts
INCIDENTS = ROOT.parent / "Back-End" / "incident_model_scripts"
sys.path.insert(0, str(ROOT / "config"))
from db import PG, WORK  # noqa: E402

LOG_DIR = WORK / "logs" / "weekly_retrain"
BACKUP = "ml_backup"
MODEL_BACKUP = WORK / "cache" / "model_backup"      # inside the cache, so the cloud jobs keep it between runs
LOCK_KEY = 7421090                  # pg advisory lock: one batch at a time
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# Gate 5 tolerances. The holdout moves forward as data is added, so last week's
# score and this week's are not on identical days: the gate catches a model that
# got clearly worse, not ordinary week-to-week movement.
ERROR_TOLERANCE = 0.25              # an error metric (WMAPE, MAE) may rise by at most 25%
SCORE_TOLERANCE = 0.05              # a score (accuracy, AUC, R2) may fall by at most 0.05
STEP_TIMEOUT_S = 4 * 3600
RETRY_WAIT_S = 180

# Input tables, as (table, date column, column to total). A group is retrained
# when any of its inputs differs from what it was last trained on.
INPUTS = {
    "traffic_hourly": ("gold.fact_traffic_hourly", "date", "total"),
    "traffic_daily": ("gold.daily_traffic_volume_corrected", "date", "total_volume"),
    "emissions_hourly": ("gold.fact_emissions_hourly", "date", "co2_tonnes"),
    "weather": ("public.hourly_weather", "timestamp_utc", "rainfall"),
    "accidents": ("silver.nlex_accident_events_clean", "event_start_date", "clearance_min"),
    "breakdowns": ("silver.nlex_breakdown_events_clean", "event_encoded_date", "deployment_count"),
    "road_crashes": ("public.nlex_road_crashes", "date", None),
    "motorcycle_crashes": ("public.nlex_motorcycle_crashes", "date", None),
    "stalled": ("public.nlex_stalled_vehicles", "date", None),
    "waze_jams": ("silver.fact_waze_jams", "date_day", "speed_kmh"),
    "arena_events": ("silver.philippine_arena_events_clean", "event_date", None),
}
CONGESTION = ROOT.parent / "All_Scripts" / "Predictive_Modeling"
HOURLY_48H = WORK / "cache" / "traffic_hourly_48h"

VOLUME_PREDS = ("pred_lstm, pred_prophet, pred_xgboost, pred_holtwinters, pred_sarimax, "
                "pred_holts_linear, pred_prophet_nw, pred_sarimax_nw, pred_lstm_nw")
CO2_PREDS = "pred_gbr, pred_polynomial, pred_lstm, pred_derived"


@dataclass
class Step:
    cwd: Path
    args: list[str]
    env: dict = field(default_factory=dict)

    @property
    def label(self) -> str:
        extra = " ".join(f"{k}={v}" for k, v in self.env.items())
        return (extra + " " if extra else "") + " ".join(self.args)


@dataclass
class Group:
    key: str
    title: str
    inputs: list[str]
    steps: list[Step]
    tables: list[tuple[str, str | None]]        # (table, the rows this group owns; None = all of it)
    evaluation: str                             # WHERE clause on gold.model_evaluation
    needs: list[str]                            # Python packages the trainers import
    caches: list[Path] = field(default_factory=list)
    checks: list[tuple[str, str]] = field(default_factory=list)   # (what, SQL returning one boolean)
    files: list[Path] = field(default_factory=list)   # saved models that later runs load; restored with the tables


# In run order: the incident models read the traffic volume series, so they come after it.
GROUPS = [
    Group(
        "volume", "Traffic volume forecast",
        inputs=["traffic_daily", "weather"],
        steps=[Step(TT / "traffic_volume", ["retrain_honest.py"]),
               Step(TT / "traffic_volume", ["retrain_honest.py"], {"SPLIT": "90_10"}),
               Step(TT / "traffic_volume", ["extend_future_volume.py"])],
        tables=[("gold.ml_predictive_volume", None),
                ("gold.ml_model_metrics", "target = 'Total Traffic'"),
                ("gold.ml_horizon_accuracy", "target = 'Total Traffic'")],
        evaluation="source = 'gold.ml_model_metrics' AND target LIKE 'Daily corridor volume,%'",
        needs=["prophet", "sklearn", "statsmodels", "tensorflow"],
        caches=[WORK / "cache" / "retrain_checkpoint.pkl"],
        checks=[
            ("a 90-day future forecast for the 80/20 split the dashboard serves",
             "SELECT count(*) >= 90 FROM gold.ml_predictive_volume WHERE is_future AND split_label = '80_20'"),
            ("the future starts the day after the record ends",
             "SELECT min(forecast_date) = (SELECT max(date) + 1 FROM gold.daily_traffic_volume_corrected) "
             "FROM gold.ml_predictive_volume WHERE is_future AND split_label = '80_20'"),
            ("no negative forecast",
             f"SELECT NOT EXISTS (SELECT 1 FROM gold.ml_predictive_volume WHERE LEAST({VOLUME_PREDS}) < 0)"),
            ("future forecasts between a third and three times the average day",
             "SELECT NOT EXISTS (SELECT 1 FROM gold.ml_predictive_volume v, "
             "(SELECT avg(actual_volume) a FROM gold.ml_predictive_volume WHERE actual_volume IS NOT NULL) m "
             f"WHERE v.is_future AND (GREATEST({VOLUME_PREDS}) > 3 * m.a OR LEAST({VOLUME_PREDS}) < m.a / 3))"),
        ],
    ),
    Group(
        # The adviser's 48-hour hourly forecast (traffic_hourly_48h/, since 2026-10-24). It writes nothing to
        # gold.model_evaluation (a shared view other pages rank models from), so Gate 5 reads its own run table:
        # the run records the 2025 backtest of the model it serves, beside the previous method's on the same hours.
        "volume_48h", "48-hour hourly traffic forecast",
        inputs=["traffic_hourly", "weather"],
        steps=[Step(TT / "traffic_hourly_48h", ["build_dataset.py"]),
               Step(TT / "traffic_hourly_48h", ["train_backtest.py", "--models", "selected"]),
               Step(TT / "traffic_hourly_48h", ["evaluate.py"]),
               Step(TT / "traffic_hourly_48h", ["train_production.py"]),
               Step(TT / "traffic_hourly_48h", ["forecast_48h.py", "--write-db"])],
        tables=[("gold.ml_forecast_48h_runs", None), ("gold.ml_forecast_hourly_48h", None)],
        evaluation="FALSE",
        needs=["tensorflow", "xgboost"],
        files=[HOURLY_48H / "models", HOURLY_48H / "scaler_prod.npz"],
        checks=[
            ("48 forecast hours for every series and the corridor",
             "SELECT bool_and(n = 48) FROM (SELECT series_key, count(*) n FROM gold.ml_forecast_hourly_48h "
             "WHERE run_id = (SELECT max(run_id) FROM gold.ml_forecast_48h_runs) GROUP BY series_key) x"),
            ("no negative forecast",
             "SELECT NOT EXISTS (SELECT 1 FROM gold.ml_forecast_hourly_48h WHERE LEAST(class_1, class_2, class_3) < 0)"),
            ("the forecast starts the hour after the latest upload",
             "SELECT origin_ts = (SELECT max(date) + 1 FROM gold.fact_traffic_hourly WHERE status = 'nlex')::timestamp "
             "FROM gold.ml_forecast_48h_runs ORDER BY run_id DESC LIMIT 1"),
            ("the corridor row is the sum of the plaza series",
             "SELECT bool_and(abs(c.total - s.total) <= 1 + 1e-4 * c.total) FROM "
             "(SELECT forecast_ts, total FROM gold.ml_forecast_hourly_48h WHERE series_key = 'corridor' "
             " AND run_id = (SELECT max(run_id) FROM gold.ml_forecast_48h_runs)) c JOIN "
             "(SELECT forecast_ts, sum(total) total FROM gold.ml_forecast_hourly_48h WHERE series_key <> 'corridor' "
             " AND run_id = (SELECT max(run_id) FROM gold.ml_forecast_48h_runs) GROUP BY 1) s USING (forecast_ts)"),
            ("the served model beats the previous method on the 2025 backtest",
             "SELECT model = 'profile' OR (info->'backtest'->'series'->'all'->>'WAPE')::float "
             "< (info->'current_method_backtest'->'series'->>'WAPE')::float "
             "FROM gold.ml_forecast_48h_runs ORDER BY run_id DESC LIMIT 1"),
            ("backtest WAPE not more than 25% above the previous run's",
             "SELECT coalesce(bool_and(a.w <= 1.25 * b.w), true) FROM "
             "(SELECT (info->'backtest'->'series'->'all'->>'WAPE')::float w FROM gold.ml_forecast_48h_runs "
             " ORDER BY run_id DESC LIMIT 1) a, "
             "(SELECT (info->'backtest'->'series'->'all'->>'WAPE')::float w FROM gold.ml_forecast_48h_runs "
             " ORDER BY run_id DESC OFFSET 1 LIMIT 1) b"),
        ],
    ),
    Group(
        "emissions", "CO2 forecast",
        # traffic_daily too: the Derived candidate forecasts CO2 through the volume series.
        inputs=["traffic_hourly", "traffic_daily", "emissions_hourly", "weather"],
        steps=[Step(TT / "emissions", ["train_emissions.py"])],
        tables=[("gold.ml_predictive_emissions", None),
                ("gold.ml_model_metrics", "target = 'Corridor CO2'"),
                ("gold.ml_horizon_accuracy", "target = 'Corridor CO2'")],
        evaluation="target = 'Daily corridor CO2'",
        needs=["sklearn", "tensorflow"],
        caches=[WORK / "cache" / "emissions_preds.pkl"],
        checks=[
            ("a future forecast exists",
             "SELECT count(*) > 0 FROM gold.ml_predictive_emissions WHERE is_future"),
            ("the future starts the day after the record ends",
             "SELECT min(forecast_date) = (SELECT max(date) + 1 FROM gold.fact_emissions_hourly) "
             "FROM gold.ml_predictive_emissions WHERE is_future"),
            ("no negative forecast",
             f"SELECT NOT EXISTS (SELECT 1 FROM gold.ml_predictive_emissions WHERE LEAST({CO2_PREDS}) < 0)"),
            ("future forecasts between a third and three times the average day",
             "SELECT NOT EXISTS (SELECT 1 FROM gold.ml_predictive_emissions e, "
             "(SELECT avg(actual_co2) a FROM gold.ml_predictive_emissions WHERE actual_co2 IS NOT NULL) m "
             f"WHERE e.is_future AND (GREATEST({CO2_PREDS}) > 3 * m.a OR LEAST({CO2_PREDS}) < m.a / 3))"),
        ],
    ),
    Group(
        "fleet_mix", "Fleet mix forecast",
        inputs=["traffic_hourly"],
        steps=[Step(TT / "fleet_mix", ["train_fleet_mix.py"])],
        tables=[("gold.ml_predictive_fleet_mix", None),
                ("gold.ml_model_metrics", "target = 'Fleet Mix'")],
        evaluation="target = 'Daily fleet mix (class shares)'",
        needs=["prophet", "scipy", "tensorflow", "xgboost"],
        caches=[TT / "fleet_mix" / "fleet_mix_preds.pkl"],
        checks=[
            ("a future forecast exists",
             "SELECT count(*) > 0 FROM gold.ml_predictive_fleet_mix WHERE is_future"),
            ("no negative forecast",
             "SELECT NOT EXISTS (SELECT 1 FROM gold.ml_predictive_fleet_mix WHERE LEAST(pred_c1, pred_c2, pred_c3) < 0)"),
        ],
    ),
    Group(
        "event_surge", "Event surge",
        # The calendar-based build in All_Scripts (Kia, 17 Sep 2026), which also scores itself into ml_model_metrics.
        # This ran smartflow_scripts/.../event_surge/ until 2 Nov 2026: the old build and eval pick "event days" as days
        # the CDV exit ran 1.45x its norm, which selects busy days and inflated the uplift (1.15x became 1.59x); the
        # 1 Nov cloud batch overwrote the table with it.
        inputs=["traffic_hourly", "arena_events"],
        steps=[Step(CONGESTION, ["build_event_surge.py"])],
        tables=[("gold.ml_event_surge_forecast", None),
                ("gold.ml_model_metrics", "target = 'Event Surge'")],
        evaluation="domain = 'Event surge'",
        needs=["prophet", "sklearn", "statsmodels", "xgboost"],
        checks=[
            ("no negative volume",
             "SELECT NOT EXISTS (SELECT 1 FROM gold.ml_event_surge_forecast WHERE surge_volume < 0 OR baseline_volume < 0)"),
        ],
    ),
    Group(
        "incident_counts", "Incident count forecast",
        inputs=["accidents", "breakdowns", "weather", "traffic_daily"],
        # The accuracy-by-range study describes the champion the first step just chose, so it is re-measured in
        # the same batch: left to a separate manual run it described last month's model (it had, since 2026-10-05).
        # 294 test days, the window volume and CO2 are scored on (10 Sep 2025 - 30 Jun 2026), since 2026-10-23;
        # it was 90 (a 93/7 split covering April-June only). See VALIDATION_DAYS in train_incident_models.py.
        steps=[Step(INCIDENTS, ["train_incident_models.py", "--write-db", "--holdout-days", "294"]),
               Step(INCIDENTS, ["measure_incident_horizon_accuracy.py", "--write-db"]),
               Step(INCIDENTS, ["train_incident_models.py", "--write-db", "--holdout-days", "294", "--series", "accident"])],
        tables=[("public.ml_daily_actuals", None), ("public.ml_predictive_incidents", None),
                ("public.ml_incident_horizon_accuracy", None),
                ("public.ml_training_metadata", None), ("public.ml_daily_actuals_accident", None),
                ("public.ml_predictive_incidents_accident", None), ("public.ml_training_metadata_accident", None)],
        evaluation="source IN ('public.ml_training_metadata', 'public.ml_training_metadata_accident')",
        needs=["sklearn", "statsmodels", "tensorflow", "xgboost"],
    ),
    Group(
        "incident_severity", "Incident severity and clearance",
        inputs=["accidents", "traffic_daily"],
        steps=[Step(INCIDENTS, ["train_incident_severity_models.py", "--write-db"])],
        tables=[("gold.ml_incident_severity_metadata", None), ("gold.ml_incident_severity_predictions", None),
                ("gold.ml_incident_survival_curve", None)],
        evaluation="source LIKE 'gold.ml_incident_severity%'",
        needs=["lifelines", "sklearn", "statsmodels", "xgboost"],
    ),
    Group(
        # Trained by hand until 31 Oct 2026, so its response-time card never saw a new upload or a test. After the
        # volume group, because it reads the volume series.
        "breakdown_response", "Breakdown dispatch response time",
        inputs=["breakdowns", "traffic_daily"],
        steps=[Step(INCIDENTS, ["train_breakdown_response_models.py", "--write-db"])],
        tables=[("gold.ml_breakdown_response_predictions", None), ("gold.ml_breakdown_response_curve", None),
                ("gold.ml_breakdown_response_group_stats", None), ("gold.ml_breakdown_response_metadata", None)],
        evaluation="source = 'gold.ml_breakdown_response_metadata'",
        needs=["lifelines", "sklearn", "xgboost"],
    ),
    Group(
        "incident_spatial", "Incident hotspots per exit",
        # What the trainer reads (28 Oct 2026): its exposure is gold traffic now, not the old wide table, and it
        # takes daily rain from hourly_weather.
        inputs=["accidents", "breakdowns", "traffic_hourly", "weather"],
        steps=[Step(INCIDENTS, ["train_incident_spatial_models.py", "--write-db"])],
        tables=[("gold.ml_incident_segment_risk", None), ("gold.ml_incident_spatial_coefficients", None),
                ("gold.ml_incident_spatial_metadata", None)],
        evaluation="source = 'gold.ml_incident_spatial_metadata'",
        needs=["mgwr", "scipy", "torch"],
    ),
    Group(
        "weather_speed", "Weather impact on speed and incidents",
        # The trainer has read the accident and breakdown logs, gold traffic and Waze jams since 21 Oct 2026; the
        # wide table and the legacy crash tables it used to read never change, so a new upload never retrained it.
        inputs=["accidents", "breakdowns", "traffic_daily", "traffic_hourly", "weather"],
        steps=[Step(INCIDENTS, ["train_incident_weather_speed_models.py", "--write-db"])],
        tables=[("gold.ml_weather_speed_contour", None), ("gold.ml_weather_speed_forecast", None),
                ("gold.ml_weather_speed_metadata", None)],
        evaluation="source = 'gold.ml_weather_speed_metadata'",
        needs=["sklearn", "statsmodels", "torch", "xgboost"],
    ),
    Group(
        # The congestion map's recurrent models (adviser's dual-path family, since 2026-10-25). The hourly refresh
        # only LOADS them from dualpath_models/; this refits them on the newest live weeks and publishes once.
        # Last in the batch: it reads only the live Waze feed, and the hourly refresh steps aside while it runs.
        "congestion", "Congestion forecast (dual-path LSTM family)",
        inputs=["waze_jams"],
        steps=[Step(CONGESTION, ["train_congestion_horizon.py", "--fast", "--dualpath-train", "--severe-weight", "1.5"])],
        tables=[("gold.ml_congestion_forecast", None), ("gold.ml_predictive_congestion", None),
                ("gold.ml_model_metrics", "target = 'Congestion'"), ("gold.ml_congestion_horizon_accuracy", None),
                ("gold.ml_congestion_eval", None)],
        evaluation="FALSE",
        needs=["tensorflow", "xgboost", "sklearn"],
        # The hourly refresh loads these. Restoring only the tables left a rejected model on disk, and the next
        # refresh republished it over the restored forecast (found 31 Oct 2026).
        files=[CONGESTION / "dualpath_models"],
        checks=[
            ("all 168 hours ahead for every exit",
             "SELECT bool_and(n = 168) FROM (SELECT segment_name, count(DISTINCT hours_ahead) n "
             "FROM gold.ml_congestion_forecast GROUP BY 1) x"),
            ("states are Low, Med or High only",
             "SELECT NOT EXISTS (SELECT 1 FROM gold.ml_congestion_forecast WHERE congestion_state NOT IN ('Low','Med','High'))"),
            ("the served model is accepted (beats the exit-hour profile)",
             "SELECT accepted FROM gold.ml_model_metrics WHERE target = 'Congestion' AND rank = 1"),
            ("the dual-path family was refitted in this run",
             "SELECT (payload->'dualpath'->>'trained_at')::timestamp > now() - interval '12 hours' "
             "FROM gold.ml_congestion_eval WHERE id = 1"),
        ],
    ),
]
BY_KEY = {g.key: g for g in GROUPS}

# ── the live forecast check ──────────────────────────────────────────────────
# Per group: what was forecast for days that had no record yet, and where the
# record of those days is read from once it arrives. `preds` and `actuals` each
# return (date, value).
VOLUME_CHAMPION_COLUMN = (
    "SELECT 'pred_' || lower(model_name) FROM gold.model_evaluation "
    "WHERE is_champion AND target = 'Daily corridor volume, 80/20 split' LIMIT 1")
FEEDBACK = {
    "volume": [{
        "target": "Daily corridor volume", "unit": "vehicles/day",
        "column": VOLUME_CHAMPION_COLUMN, "allowed": [c.strip() for c in VOLUME_PREDS.split(",")],
        "preds": "SELECT forecast_date, {column}::float FROM gold.ml_predictive_volume "
                 "WHERE is_future AND split_label = '80_20'",
        "actuals": "SELECT date, total_volume::float FROM gold.daily_traffic_volume_corrected",
    }],
    "emissions": [{
        "target": "Daily corridor CO2", "unit": "tonnes CO2/day",
        "preds": "SELECT forecast_date, (CASE champion_model WHEN 'GBR' THEN pred_gbr WHEN 'Polynomial' THEN pred_polynomial "
                 "WHEN 'LSTM' THEN pred_lstm WHEN 'Derived' THEN pred_derived END)::float "
                 "FROM gold.ml_predictive_emissions WHERE is_future",
        "actuals": "SELECT date, SUM(co2_tonnes)::float FROM gold.fact_emissions_hourly GROUP BY date",
    }],
    "incident_counts": [{
        "target": "Daily incidents (accidents and breakdowns)", "unit": "incidents/day",
        "preds": "SELECT forecast_date, predicted_incident_count::float FROM public.ml_predictive_incidents "
                 "WHERE prediction_type = 'future'",
        # The trainer's own daily count (DAILY_COUNTS_SQL in train_incident_models.py).
        "actuals": "SELECT d, COUNT(*)::float FROM ("
                   "SELECT event_start_date::date AS d FROM silver.nlex_accident_events_clean WHERE event_start_date IS NOT NULL "
                   "UNION ALL SELECT event_encoded_date::date FROM silver.nlex_breakdown_events_clean "
                   "WHERE event_encoded_date IS NOT NULL) x GROUP BY d",
    }],
}
FEEDBACK_MIN_DAYS = 7               # fewer days than a week of new record says little; reported, never called drift

# ── output ───────────────────────────────────────────────────────────────────

_log = None


def say(msg: str = "") -> None:
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S}  {msg}" if msg else ""
    print(line, flush=True)
    if _log:
        _log.write(line + "\n")
        _log.flush()


def num(v) -> str:
    return "—" if v is None else f"{v:,}" if isinstance(v, int) else f"{v:.4g}"


# ── database ─────────────────────────────────────────────────────────────────

def connect(attempts: int = 4, wait: int = 30):
    """A fresh connection, retried: the laptop's network drops now and then, and a
    batch that runs for hours must not die on one missed handshake."""
    for i in range(1, attempts + 1):
        try:
            return psycopg2.connect(PG, connect_timeout=20, keepalives=1, keepalives_idle=30,
                                    keepalives_interval=10, keepalives_count=5)
        except psycopg2.OperationalError as exc:
            if i == attempts:
                raise
            say(f"  database not reachable ({str(exc).strip().splitlines()[0]}); retrying in {wait} s")
            time.sleep(wait)


def exists(cur, name: str) -> bool:
    cur.execute("SELECT to_regclass(%s) IS NOT NULL", (name,))
    return bool(cur.fetchone()[0])


def ensure_tables(cur) -> None:
    cur.execute("""
        CREATE TABLE IF NOT EXISTS gold.ml_forecast_feedback (
            id serial PRIMARY KEY,
            run_id int, group_key text NOT NULL, target text NOT NULL,
            checked_at timestamptz NOT NULL DEFAULT now(),
            days int NOT NULL, date_from date, date_to date,
            wmape double precision, mae double precision, naive_wmape double precision,
            verdict text NOT NULL)""")
    cur.execute("COMMENT ON TABLE gold.ml_forecast_feedback IS "
                "'How each published forecast did on the days that had no record when it was made, measured by the "
                "weekly batch (weekly_retrain.py) once those days were uploaded and before the models were retrained. "
                "wmape and naive_wmape are percentages; naive is the same weekday of the last recorded week before the "
                "forecast began. verdict: on track, drifted (worse than naive over a week or more), or too few days to judge.'")
    cur.execute(f"CREATE SCHEMA IF NOT EXISTS {BACKUP}")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS gold.ml_batch_runs (
            id          serial PRIMARY KEY,
            started_at  timestamptz NOT NULL DEFAULT now(),
            finished_at timestamptz,
            trigger     text NOT NULL,          -- scheduled | manual | forced
            status      text NOT NULL,          -- running | no new data | retrained | needs attention | interrupted | failed
            summary     text,
            groups      jsonb NOT NULL DEFAULT '[]'::jsonb,
            host        text,
            log_file    text
        )""")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS gold.ml_batch_watermarks (
            group_key  text PRIMARY KEY,
            inputs     jsonb NOT NULL,          -- the input fingerprints the group was last trained on
            trained_at timestamptz NOT NULL DEFAULT now(),
            run_id     integer
        )""")


def fingerprint(cur, key: str) -> dict:
    table, date_col, sum_col = INPUTS[key]
    if not exists(cur, table):
        return {"table": table, "missing": True}
    total = f"round(sum({sum_col})::numeric, 3)::text" if sum_col else "NULL"
    cur.execute(f"SELECT count(*), max({date_col})::text, {total} FROM {table}")
    rows, latest, s = cur.fetchone()
    return {"table": table, "rows": int(rows), "latest": latest, "total": s}


def load_watermarks(cur) -> dict:
    if not exists(cur, "gold.ml_batch_watermarks"):
        return {}
    cur.execute("SELECT group_key, inputs FROM gold.ml_batch_watermarks")
    return {k: v for k, v in cur.fetchall()}


def describe_change(a: dict | None, b: dict) -> str:
    t = b["table"]
    if not a:
        return f"{t}: not recorded before"
    if b.get("missing"):
        return f"{t}: table is missing"
    parts = []
    if a.get("rows") != b.get("rows"):
        parts.append(f"{num(a.get('rows'))} → {num(b.get('rows'))} rows")
    if a.get("latest") != b.get("latest"):
        parts.append(f"latest {a.get('latest')} → {b.get('latest')}")
    return f"{t}: " + (", ".join(parts) if parts else "values corrected (same rows and dates)")


def changes(g: Group, fp: dict, marks: dict) -> list[str]:
    old = marks.get(g.key)
    if old is None:
        return ["no record yet of the data it was last trained on"]
    return [describe_change(old.get(k), fp[k]) for k in g.inputs if old.get(k) != fp[k]]


def evaluation(cur, where: str):
    """Each target's champion as gold.model_evaluation reports it, plus the newest
    evaluation time (to tell whether a trainer actually wrote new results)."""
    cur.execute("SELECT source, target, model_name, is_champion, primary_metric, primary_value, "
                f"higher_is_better, beats_best_baseline, mase, evaluated_at, accepted FROM gold.model_evaluation WHERE {where}")
    champs, latest = {}, None
    for src, tgt, model, champ, metric, val, hib, beats, mase, ev, accepted in cur.fetchall():
        if ev is not None and (latest is None or ev > latest):
            latest = ev
        if champ:
            champs[f"{tgt} [{src}]"] = {
                "target": tgt, "model": model, "metric": metric,
                "value": None if val is None else float(val), "higher": hib, "beats": beats,
                "mase": None if mase is None else float(mase), "accepted": accepted}
    return champs, latest


def run_check(cur, sql: str):
    try:
        cur.execute(sql)
        v = cur.fetchone()[0]
        return True if v is True else f"got {v}"
    except psycopg2.Error as exc:
        return "error: " + str(exc).strip().splitlines()[0]


# ── backup and restore ───────────────────────────────────────────────────────

def backup_name(g: Group, table: str) -> str:
    schema, name = table.split(".")
    return f"{BACKUP}.{g.key}__{schema}__{name}"


def _remove(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def _copy(src: Path, dst: Path) -> None:
    if src.is_dir():
        shutil.copytree(src, dst)
    else:
        shutil.copy2(src, dst)


def _swap_in(src: Path, dst: Path) -> None:
    """Replaces dst with a copy of src. The copy is finished before dst is touched, so a copy that fails partway
    leaves the old version whole."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".incoming")
    _remove(tmp)
    _copy(src, tmp)
    _remove(dst)
    tmp.rename(dst)


def backup_files(g: Group) -> list[str]:
    """Copies the group's saved models aside, beside what take_backup does for its tables."""
    saved = []
    for live in g.files:
        if live.exists():
            _swap_in(live, MODEL_BACKUP / g.key / live.name)
            saved.append(live.name)
    return saved


def restore_files(g: Group) -> list[str]:
    """Puts the group's saved models back. Without this a rejected model stays on disk for the next run to load."""
    done = []
    for live in g.files:
        kept = MODEL_BACKUP / g.key / live.name
        if kept.exists():
            _swap_in(kept, live)
            done.append(live.name)
    return done


def take_backup(g: Group) -> list[str]:
    """Copies the group's outputs aside, in one transaction, so a half-made backup
    can never replace a good one. Plain CREATE TABLE AS: no defaults or sequences
    are copied, so nothing ties a backup to the live table (a trainer that drops
    and recreates its table, as build_event_surge.py does, is not blocked)."""
    conn = connect()
    try:
        with conn, conn.cursor() as cur:
            saved = []
            for table, where in g.tables:
                b = backup_name(g, table)
                cur.execute(f"DROP TABLE IF EXISTS {b}")
                if exists(cur, table):
                    cur.execute(f"CREATE TABLE {b} AS SELECT * FROM {table} WHERE {where or 'TRUE'}")
                    saved.append(table)
    finally:
        conn.close()
    files = backup_files(g)
    if files:
        say(f"  backed up model files: {', '.join(files)}")
    return saved


def insertable_columns(cur, table: str, backup: str):
    s, t = table.split(".")
    bs, bt = backup.split(".")
    cur.execute("SELECT column_name, is_generated, identity_generation FROM information_schema.columns "
                "WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position", (s, t))
    live = cur.fetchall()
    cur.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = %s AND table_name = %s", (bs, bt))
    have = {r[0] for r in cur.fetchall()}
    cols = [c for c, gen, _ in live if c in have and gen != "ALWAYS"]
    override = any(ident == "ALWAYS" for c, _, ident in live if c in cols)
    return ", ".join(f'"{c}"' for c in cols), override


def restore(g: Group) -> list[str]:
    """Puts the backup back, all tables in one transaction: either every output of
    the group returns to the backed-up version or none does."""
    conn = connect()
    try:
        with conn, conn.cursor() as cur:
            done = []
            for table, where in g.tables:
                b = backup_name(g, table)
                if not exists(cur, b):
                    continue
                if not exists(cur, table):
                    cur.execute(f"CREATE TABLE {table} AS SELECT * FROM {b}")
                    done.append(f"{table} (recreated)")
                    continue
                cols, override = insertable_columns(cur, table, b)
                cur.execute(f"DELETE FROM {table} WHERE {where or 'TRUE'}")
                cur.execute(f"INSERT INTO {table} ({cols}) {'OVERRIDING SYSTEM VALUE ' if override else ''}"
                            f"SELECT {cols} FROM {b}")
                done.append(table)
    finally:
        conn.close()
    files = restore_files(g)
    if files:
        say(f"  restored model files: {', '.join(files)}")
    return done


def checksum(cur, table: str, where: str | None):
    cur.execute(f"SELECT count(*), md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) "
                f"FROM (SELECT * FROM {table} WHERE {where or 'TRUE'}) t")
    return cur.fetchone()


# ── preflight ────────────────────────────────────────────────────────────────

_imports: dict[str, str | None] = {}


def missing_packages(names: list[str]) -> list[str]:
    """Imports each package in a child process, the way the trainers will. Finding
    the files is not enough: on this PC Windows Application Control blocks torch's
    DLLs, so torch can be installed and still fail to load."""
    out = []
    for m in names:
        if m not in _imports:
            r = subprocess.run([sys.executable, "-c", f"import {m}"], capture_output=True, text=True,
                               timeout=600, creationflags=NO_WINDOW)
            last = (r.stderr.strip().splitlines() or [""])[-1]
            _imports[m] = None if r.returncode == 0 else last
        if _imports[m]:
            out.append(f"{m} ({_imports[m][:140]})")
    return out


def cannot_run(g: Group) -> str | None:
    gone = [s.args[0] for s in g.steps if not (s.cwd / s.args[0]).exists()]
    if gone:
        return "trainer not found: " + ", ".join(gone)
    miss = missing_packages(g.needs)
    if miss:
        return "this PC cannot load " + "; ".join(miss)
    return None


# ── running ──────────────────────────────────────────────────────────────────

def run_step(step: Step, log_path: Path) -> dict:
    cmd = [sys.executable, "-u", *step.args]
    env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", **step.env}
    rc, minutes = None, 0.0
    for attempt in (1, 2):
        say(f"    {step.label}  (attempt {attempt})")
        t0 = time.time()
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(f"\n{'=' * 78}\n{datetime.now():%Y-%m-%d %H:%M:%S}  {step.label}  (attempt {attempt})"
                     f"\n  in {step.cwd}\n{'=' * 78}\n")
            fh.flush()
            try:
                rc = subprocess.run(cmd, cwd=step.cwd, env=env, stdout=fh, stderr=subprocess.STDOUT,
                                    timeout=STEP_TIMEOUT_S, creationflags=NO_WINDOW).returncode
            except subprocess.TimeoutExpired:
                rc = "timeout"
        minutes = (time.time() - t0) / 60
        say(f"      exit {rc} after {minutes:.1f} min")
        if rc == 0:
            break
        if attempt == 1:
            say(f"      retrying in {RETRY_WAIT_S} s")
            time.sleep(RETRY_WAIT_S)
    return {"step": step.label, "rc": rc, "minutes": round(minutes, 1), "attempts": attempt}


def compare(b: dict, a: dict) -> tuple[str, list[str]]:
    fails = []
    if b["beats"] is True and a["beats"] is False:
        fails.append("no longer beats its best baseline")
    # MASE crossing 1 says the scored days were harder than the training years (a typhoon, the holidays), not
    # that the model got worse: on the actual record the seasonal naive itself scored 1.555. It fails a model
    # only if the model no longer beats its best baseline on those same days (checked above, by "beats").
    # "beats" is NULL where a target stores no baseline rows (the volume trainer keeps its baselines to itself):
    # then the trainer's own verdict decides, which compares with the seasonal naive on the same scored days.
    beats_now = a["beats"] if a["beats"] is not None else a.get("accepted")
    if (b["mase"] is not None and b["mase"] < 1 and a["mase"] is not None and a["mase"] >= 1
            and beats_now is not True):
        fails.append(f"MASE rose to {a['mase']:.3f} (was {b['mase']:.3f}, below 1) and it no longer beats its best baseline")
    if b["metric"] == a["metric"] and b["value"] is not None and a["value"] is not None and b["higher"] is not None:
        if b["higher"] and b["value"] - a["value"] > SCORE_TOLERANCE:
            fails.append(f"{a['metric']} fell more than {SCORE_TOLERANCE}")
        if not b["higher"] and b["value"] and (a["value"] - b["value"]) / abs(b["value"]) > ERROR_TOLERANCE:
            fails.append(f"{a['metric']} rose more than {ERROR_TOLERANCE:.0%}")
    text = (f"{b['target']}: {b['model']} {b['metric']} {num(b['value'])} → "
            f"{a['model']} {a['metric']} {num(a['value'])}")
    return text, fails


def gate(g: Group, before: dict, stamp_before, after: dict, stamp_after) -> tuple[list[str], list[str], list[str]]:
    """Gate 5. Returns (problems, comparisons, checks passed)."""
    problems, comparisons, passed = [], [], []
    if stamp_before is not None and (stamp_after is None or not stamp_after > stamp_before):
        problems.append("the trainers finished but no new results reached gold.model_evaluation")
    conn = connect()
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            for table, where in g.tables:
                if exists(cur, table):
                    cur.execute(f"SELECT count(*) FROM {table} WHERE {where or 'TRUE'}")
                    if cur.fetchone()[0] == 0:
                        problems.append(f"{table} is empty after retraining")
            for what, sql in g.checks:
                ok = run_check(cur, sql)
                if ok is True:
                    passed.append(what)
                else:
                    problems.append(f"check failed — {what} ({ok})")
    finally:
        conn.close()
    for key, b in before.items():
        a = after.get(key)
        if a is None:
            problems.append(f"{b['target']}: no champion after retraining")
            continue
        text, fails = compare(b, a)
        comparisons.append(text)
        problems += [f"{b['target']}: {f}" for f in fails]
    return problems, comparisons, passed


def champions(champs: dict) -> str | None:
    """The champion models of a group, for the audit log's from/to status: "Prophet, Prophet_nw"."""
    names = sorted({c["model"] for c in champs.values() if c.get("model")})
    return ", ".join(names)[:120] or None


def score_feedback(preds: dict, actuals: dict) -> dict | None:
    """How the published forecast did on the days that now have a record. Pure: dates -> values in, figures out.

    Scored against the seasonal naive every model here is held to: the same weekday of the last recorded week
    before the forecast began. Days in the last recorded week are left out when the upload may still be growing
    that day (the caller passes whole days only). None when no forecast day has a record yet.
    """
    days = sorted(d for d in preds if d in actuals and preds[d] is not None)
    if not days:
        return None
    start = min(preds)
    week = [actuals.get(start - __import__("datetime").timedelta(days=k)) for k in range(7, 0, -1)]   # oldest first
    err = sum(abs(actuals[d] - preds[d]) for d in days)
    total = sum(abs(actuals[d]) for d in days)
    naive_err, naive_n = 0.0, 0
    for d in days:
        ref = week[(d - start).days % 7]
        if ref is not None:
            naive_err += abs(actuals[d] - ref)
            naive_n += 1
    wmape = (err / total * 100) if total > 0 else None
    naive = (naive_err / total * 100) if total > 0 and naive_n == len(days) else None
    if len(days) < FEEDBACK_MIN_DAYS or wmape is None or naive is None:
        verdict = "too few days to judge"
    else:
        verdict = "on track" if wmape <= naive else "drifted"
    return {"days": len(days), "from": days[0], "to": days[-1], "wmape": wmape, "mae": err / len(days),
            "naive_wmape": naive, "verdict": verdict}


def live_feedback(cur, g: Group) -> list[dict]:
    """The published forecasts of `g` against the record that has arrived since. Reads only."""
    out = []
    for spec in FEEDBACK.get(g.key, []):
        try:
            sql = spec["preds"]
            if "column" in spec:
                cur.execute(spec["column"])
                row = cur.fetchone()
                if not row or row[0] not in spec["allowed"]:
                    continue
                sql = sql.format(column=row[0])
            cur.execute(sql)
            preds = {d: v for d, v in cur.fetchall()}
            if not preds:
                continue
            cur.execute(spec["actuals"])
            actuals = {d: v for d, v in cur.fetchall() if v is not None}
            scored = score_feedback(preds, actuals)
            out.append({"target": spec["target"], "unit": spec["unit"], "forecast_from": min(preds), "forecast_to": max(preds),
                        **(scored or {"days": 0, "verdict": "no new record yet"})})
        except Exception as exc:      # a check on the old forecasts must never stop the retrain
            cur.connection.rollback()
            out.append({"target": spec["target"], "unit": spec["unit"], "days": 0, "verdict": f"could not be checked ({str(exc).splitlines()[0]})"})
    return out


def feedback_line(f: dict) -> str:
    if f["days"] == 0:
        return f"published forecast vs new record — {f['target']}: {f['verdict']}"
    naive = "" if f["naive_wmape"] is None else f", same-weekday-last-week {f['naive_wmape']:.1f}%"
    return (f"published forecast vs new record — {f['target']}: {f['days']} day(s) {f['from']} to {f['to']}, "
            f"off by {f['wmape']:.1f}% (MAE {num(f['mae'])} {f['unit']}){naive} → {f['verdict']}")


def record_feedback(run_id: int, g: Group, items: list[dict]) -> None:
    scored = [f for f in items if f["days"] > 0]
    if not scored:
        return
    conn = connect()
    try:
        with conn, conn.cursor() as cur:
            for f in scored:
                cur.execute(
                    "INSERT INTO gold.ml_forecast_feedback (run_id, group_key, target, days, date_from, date_to, "
                    "wmape, mae, naive_wmape, verdict) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (run_id, g.key, f["target"], f["days"], f["from"], f["to"], f["wmape"], f["mae"], f["naive_wmape"], f["verdict"]))
    finally:
        conn.close()


def audit_entry(run_id: int, action: str, outcome: str, entity_type: str, entity_id: str, *,
                from_status: str | None = None, to_status: str | None = None,
                duration_ms: int | None = None, details: dict | None = None) -> None:
    """One audit_logs entry for the Audit Log page, as the system user. Never stops the batch."""
    conn = None
    try:
        conn = connect(attempts=2, wait=10)
        with conn, conn.cursor() as cur:
            if not exists(cur, "audit_logs"):
                return
            cur.execute(
                "INSERT INTO audit_logs (user_id, action, target_resource, details, module, entity_type, entity_id, "
                "from_status, to_status, outcome, duration_ms, actor_role, request_id) "
                "VALUES ('system:weekly-retrain', %s, %s, %s::jsonb, 'model_training', %s, %s, %s, %s, %s, %s, 'system', %s)",
                (action, f"{entity_type}:{entity_id}", json.dumps(details or {}, default=str), entity_type, entity_id,
                 from_status, to_status, outcome, duration_ms, f"weekly-retrain-{run_id}"))
    except Exception as exc:  # the audit log is a record of the batch, not part of it
        say(f"  (audit log entry not written: {str(exc).splitlines()[0]})")
    finally:
        if conn is not None:
            conn.close()


def save(run_id: int, entries: list[dict], status: str | None = None, summary: str | None = None,
         finished: bool = False) -> None:
    conn = connect()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("UPDATE gold.ml_batch_runs SET groups = %s::jsonb, status = COALESCE(%s, status), "
                        "summary = COALESCE(%s, summary), finished_at = CASE WHEN %s THEN now() ELSE finished_at END "
                        "WHERE id = %s", (json.dumps(entries, default=str), status, summary, finished, run_id))
    finally:
        conn.close()


def run_group(g: Group, entry: dict, fp: dict, run_id: int, log_path: Path) -> None:
    conn = connect()
    try:
        with conn.cursor() as cur:
            before, stamp_before = evaluation(cur, g.evaluation)
    finally:
        conn.close()
    entry["from"] = champions(before)
    # Before anything is replaced: how did what we published do on the days that have arrived since?
    conn = connect()
    try:
        with conn.cursor() as cur:
            entry["feedback"] = live_feedback(cur, g)
    finally:
        conn.close()
    notes = [feedback_line(f) for f in entry["feedback"]]
    for n in notes:
        say(f"  {n}")
    record_feedback(run_id, g, entry["feedback"])
    entry["comparisons"] = list(notes)
    saved = take_backup(g)
    say(f"  backed up {len(saved)} table(s) to {BACKUP}")
    for c in g.caches:
        if c.exists():
            c.unlink()
            say(f"  cleared cache {c.name}")
    for step in g.steps:
        result = run_step(step, log_path)
        entry["steps"].append(result)
        if result["rc"] != 0:
            restore(g)
            entry["status"] = "kept previous"
            entry["reason"] = f"{step.label} failed (exit {result['rc']}, twice); last week's models were restored"
            say(f"  {entry['reason']}")
            return
    conn = connect()
    try:
        with conn.cursor() as cur:
            after, stamp_after = evaluation(cur, g.evaluation)
    finally:
        conn.close()
    entry["to"] = champions(after)
    problems, compared, entry["checks"] = gate(g, before, stamp_before, after, stamp_after)
    for c in compared:
        say(f"    {c}")
    entry["comparisons"] = notes + compared
    if problems:
        restore(g)
        entry["status"] = "kept previous"
        entry["reason"] = "failed the model tests: " + "; ".join(problems) + ". Last week's models were restored."
        say(f"  KEPT PREVIOUS — {'; '.join(problems)}")
        return
    conn = connect()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("INSERT INTO gold.ml_batch_watermarks (group_key, inputs, trained_at, run_id) "
                        "VALUES (%s, %s::jsonb, now(), %s) ON CONFLICT (group_key) DO UPDATE SET "
                        "inputs = EXCLUDED.inputs, trained_at = now(), run_id = EXCLUDED.run_id",
                        (g.key, json.dumps({k: fp[k] for k in g.inputs}), run_id))
    finally:
        conn.close()
    entry["status"] = "retrained"
    entry["reason"] = f"passed all {len(entry['checks']) + len(compared)} tests; the new models are live"
    say(f"  RETRAINED — {entry['reason']}")


def batch(args, log_path: Path) -> int:
    batch_start = time.time()
    trigger = "scheduled" if args.scheduled else "forced" if args.force else "manual"
    conn = connect()
    try:
        with conn, conn.cursor() as cur:
            ensure_tables(cur)
            # This process holds the lock, so a run still marked 'running' is one that died
            # (the PC shut down, or the process was killed) part-way through.
            cur.execute("SELECT id, groups FROM gold.ml_batch_runs WHERE status = 'running'")
            stale = cur.fetchall()
            cur.execute("UPDATE gold.ml_batch_runs SET status = 'interrupted', finished_at = now(), "
                        "summary = 'Stopped before it finished (the PC was shut down or the process was killed).' "
                        "WHERE status = 'running'")
            cur.execute("INSERT INTO gold.ml_batch_runs (trigger, status, host, log_file) "
                        "VALUES (%s, 'running', %s, %s) RETURNING id", (trigger, socket.gethostname(), str(log_path)))
            run_id = cur.fetchone()[0]
            fp = {k: fingerprint(cur, k) for k in INPUTS}
            marks = load_watermarks(cur)
            # Interrupted runs never reach their own summary entry, so the Audit Log page showed nothing for them
            # (5 of the first 11 batches). Each one is recorded here, once: any interrupted run with no
            # model.weekly_batch entry yet, including those from before this was added.
            unlogged = []
            if exists(cur, "audit_logs"):
                cur.execute("""SELECT r.id, r.trigger, r.started_at, r.finished_at, r.groups FROM gold.ml_batch_runs r
                               WHERE r.status = 'interrupted' AND NOT EXISTS (
                                 SELECT 1 FROM audit_logs a WHERE a.action = 'model.weekly_batch'
                                   AND a.entity_type = 'batch' AND a.entity_id = r.id::text)
                               ORDER BY r.id""")
                unlogged = cur.fetchall()
    finally:
        conn.close()
    say(f"weekly retrain #{run_id} ({trigger})  log: {log_path}")
    for sid, strig, started, marked, groups in unlogged:
        done = {g.get("key"): g.get("status") for g in groups or [] if g.get("key")}
        audit_entry(sid, "model.weekly_batch", "interrupted", "batch", str(sid), to_status="interrupted",
                    details={"trigger": strig, "started_at": started, "found_interrupted_at": marked,
                             "recorded_by_run": run_id, "groups": done,
                             "reason": "stopped before it finished (the PC was shut down or the process was killed); "
                                       "groups it left half-written were restored from their backups"})
        say(f"  recorded interrupted batch #{sid} (started {started}) in the audit log")

    # A group the dead run left half-written goes back to its backup first. Its
    # backup was taken when that run started on it, so it is the last good version.
    for sid, groups in stale:
        for gr in groups or []:
            if gr.get("status") == "running" and gr.get("key") in BY_KEY:
                say(f"run #{sid} stopped while retraining {gr['title']}: restoring its previous outputs")
                restore(BY_KEY[gr["key"]])

    entries = []
    for g in GROUPS:
        entry = {"key": g.key, "title": g.title, "status": "", "changes": [], "reason": "",
                 "steps": [], "comparisons": [], "checks": []}
        entries.append(entry)
        say("")
        say(f"■ {g.title}")
        if args.only and g.key not in args.only:
            entry["status"], entry["reason"] = "not selected", "left out of this run (--only)"
            say(f"  {entry['reason']}")
            continue
        entry["changes"] = changes(g, fp, marks)
        if not entry["changes"]:
            if not args.force:
                entry["status"], entry["reason"] = "unchanged", "no new data since it was last trained"
                say(f"  {entry['reason']}")
                continue
            entry["changes"] = ["no new data; retrained because the run was forced"]
        for c in entry["changes"]:
            say(f"  changed: {c}")
        why = cannot_run(g)
        if why:
            entry["status"], entry["reason"] = "cannot run here", why + ". Its current models stay."
            say(f"  CANNOT RUN — {why}")
            save(run_id, entries)
            audit_entry(run_id, "model.cannot_run", "cannot run here", "model_group", g.key,
                        details={"title": g.title, "reason": why, "changes": entry["changes"][:3]})
            continue
        entry["status"] = "running"
        save(run_id, entries)
        g_start = time.time()
        try:
            run_group(g, entry, fp, run_id, log_path)
        except Exception as exc:  # the runner itself failed: never leave a group half-written
            say(traceback.format_exc())
            try:
                restore(g)
                entry["status"] = "kept previous"
                entry["reason"] = f"the batch hit an error ({exc}); last week's models were restored"
            except Exception as exc2:
                entry["status"] = "restore failed"
                entry["reason"] = (f"the batch hit an error ({exc}) and restoring the backup also failed ({exc2}). "
                                   f"Run: python weekly_retrain.py --restore {g.key}")
        save(run_id, entries)
        kept = entry["status"] != "retrained"
        audit_entry(
            run_id, {"retrained": "model.retrained", "kept previous": "model.kept_previous"}.get(entry["status"], "model.restore_failed"),
            entry["status"], "model_group", g.key,
            from_status=entry.get("from"), to_status=entry.get("from") if kept else entry.get("to"),
            duration_ms=int((time.time() - g_start) * 1000),
            details={"title": g.title, "reason": entry["reason"], "changes": entry["changes"][:3],
                     "comparisons": entry["comparisons"][:4]})

    counts: dict[str, int] = {}
    for e in entries:
        counts[e["status"]] = counts.get(e["status"], 0) + 1
    if counts.get("restore failed"):
        status = "failed"
    elif all(e["status"] in ("unchanged", "not selected") for e in entries):
        status = "no new data"
    elif counts.get("kept previous") or counts.get("cannot run here"):
        status = "needs attention"
    else:
        status = "retrained"
    summary = ", ".join(f"{v} {k}" for k, v in counts.items())
    save(run_id, entries, status, summary, finished=True)
    audit_entry(run_id, "model.weekly_batch", status, "batch", str(run_id),
                duration_ms=int((time.time() - batch_start) * 1000),
                details={"trigger": trigger, "summary": summary, "groups": {e["key"]: e["status"] for e in entries}})
    say("")
    say(f"done: {status} — {summary}")
    return 1 if status == "failed" else 0


# ── the other modes ──────────────────────────────────────────────────────────

def plan(args) -> int:
    conn = connect()
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            fp = {k: fingerprint(cur, k) for k in INPUTS}
            marks = load_watermarks(cur)
            if exists(cur, "gold.ml_batch_runs"):
                cur.execute("SELECT id, started_at, status, summary FROM gold.ml_batch_runs ORDER BY id DESC LIMIT 1")
                last = cur.fetchone()
                say(f"last batch: #{last[0]} {last[1]:%Y-%m-%d %H:%M} — {last[2]} ({last[3]})" if last else "no batch has run yet")
            else:
                say("no batch has run yet (gold.ml_batch_runs does not exist; the first run creates it)")
            say("")
            say("inputs now:")
            for v in fp.values():
                state = "MISSING" if v.get("missing") else f"{num(v['rows']):>11} rows, latest {v['latest']}"
                say(f"  {v['table']:<40} {state}")
            for g in GROUPS:
                if args.only and g.key not in args.only:
                    continue
                ch = changes(g, fp, marks)
                say("")
                say(f"■ {g.title} [{g.key}]")
                for c in ch:
                    say(f"  changed: {c}")
                why = cannot_run(g)
                verdict = ("would NOT run: " + why) if why and (ch or args.force) else \
                          ("would retrain" if ch or args.force else "would skip: no new data")
                say(f"  {verdict}")
                champs, _ = evaluation(cur, g.evaluation)
                for c in champs.values():
                    beats = "" if c["beats"] is None else (" beats baseline" if c["beats"] else " does NOT beat baseline")
                    say(f"  now: {c['target']}: {c['model']} {c['metric']} {num(c['value'])}"
                        f"{'' if c['mase'] is None else f', MASE {c['mase']:.3f}'}{beats}")
                for what, sql in g.checks:
                    ok = run_check(cur, sql)
                    say(f"  test on current outputs: {'pass' if ok is True else 'FAIL'} — {what}{'' if ok is True else f' ({ok})'}")
                for f in live_feedback(cur, g):
                    say(f"  {feedback_line(f)}")
    finally:
        conn.close()
    return 0


def manual_restore(key: str) -> int:
    g = BY_KEY[key]
    done = restore(g)
    if not done:
        say(f"no backup of {g.title} in {BACKUP}: nothing restored")
        return 1
    conn = connect()
    try:
        with conn, conn.cursor() as cur:
            if exists(cur, "gold.ml_batch_watermarks"):
                # The restored models were trained on older data, so next Sunday retrains them.
                cur.execute("DELETE FROM gold.ml_batch_watermarks WHERE group_key = %s", (key,))
    finally:
        conn.close()
    say(f"restored {g.title} from {BACKUP}: {', '.join(done)}")
    return 0


def test_restore(key: str) -> int:
    """Backs the group up, restores it, and checks every table came back identical:
    proof on the live tables that the rollback works, without changing any data.
    It replaces the group's backup with the current version."""
    g = BY_KEY[key]
    conn = connect()
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            before = {t: checksum(cur, t, w) for t, w in g.tables if exists(cur, t)}
        take_backup(g)
        done = restore(g)
        with conn.cursor() as cur:
            after = {t: checksum(cur, t, w) for t, w in g.tables if exists(cur, t)}
    finally:
        conn.close()
    ok = True
    for t in before:
        same = before[t] == after.get(t)
        ok &= same
        say(f"  {'identical' if same else 'DIFFERENT'}  {t}  ({num(before[t][0])} rows)")
    say(f"{g.title}: restored {len(done)} table(s) — {'rollback verified' if ok else 'ROLLBACK CHANGED DATA'}")
    return 0 if ok else 1


def main() -> int:
    global _log
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    p = argparse.ArgumentParser(description="Weekly batch retrain and test (every Sunday 22:00).")
    p.add_argument("--plan", action="store_true", help="read-only: what changed, what would run, current test results")
    p.add_argument("--force", action="store_true", help="retrain even where no data changed")
    p.add_argument("--only", type=lambda s: [x.strip() for x in s.split(",") if x.strip()], default=None,
                   help="comma-separated groups: " + ", ".join(BY_KEY))
    p.add_argument("--restore", choices=list(BY_KEY), help="put back the version before the latest retrain")
    p.add_argument("--test-restore", choices=list(BY_KEY), help="back up, restore, and compare the group's tables")
    p.add_argument("--scheduled", action="store_true", help=argparse.SUPPRESS)
    args = p.parse_args()
    if args.only:
        bad = [k for k in args.only if k not in BY_KEY]
        if bad:
            p.error(f"unknown group(s): {', '.join(bad)}; choose from {', '.join(BY_KEY)}")

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if args.plan:
        return plan(args)
    if args.restore:
        return manual_restore(args.restore)
    if args.test_restore:
        return test_restore(args.test_restore)

    log_path = LOG_DIR / f"weekly_retrain_{datetime.now():%Y%m%d_%H%M%S}.log"
    _log = open(log_path, "a", encoding="utf-8")
    # The cloud workflow (.github/workflows/weekly-retrain.yml) is the weekly batch since it first ran on 1 Nov 2026.
    # This PC's Sunday task is the fallback: both retrained everything that week, the PC's run died part-way (the PC
    # slept) and the cloud restored what it had left half-written. A scheduled run here does nothing while the cloud
    # has finished a batch within 8 days, and takes over by itself if the cloud stops running.
    if args.scheduled and not os.environ.get("GITHUB_ACTIONS"):
        c = connect()
        try:
            with c.cursor() as cur:
                cur.execute("SELECT id, host, finished_at FROM gold.ml_batch_runs WHERE trigger = 'scheduled' "
                            "AND host IS DISTINCT FROM %s AND status IN ('retrained', 'no new data', 'needs attention') "
                            "AND finished_at > now() - interval '8 days' ORDER BY id DESC LIMIT 1",
                            (socket.gethostname(),))
                recent = cur.fetchone()
        finally:
            c.close()
        if recent:
            say(f"the cloud ran this week's batch (#{recent[0]} on {recent[1]}, finished {recent[2]}); "
                "this PC's scheduled run is only a fallback, so nothing to do")
            return 0
    lock = connect()
    lock.autocommit = True
    try:
        with lock.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_lock(%s)", (LOCK_KEY,))
            if not cur.fetchone()[0]:
                say("another weekly retrain is already running; nothing to do")
                return 0
        return batch(args, log_path)
    finally:
        try:
            lock.close()            # releases the advisory lock
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
