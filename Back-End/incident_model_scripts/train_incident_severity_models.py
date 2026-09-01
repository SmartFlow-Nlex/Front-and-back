#!/usr/bin/env python3
"""
SmartFlow NLEX — Incident Severity/Clearance Models (Block 2: Secondary Incident Risk)
========================================================================================
Per-INCIDENT models, a third grain alongside train_incident_models.py's per-day
pipeline and train_incident_spatial_models.py's per-exit one:

  1. Ordinal Logistic Regression + XGBoost — compete on predicting an
     incident's SEVERITY (Property-Damage-Only / Injury / Fatal), from
     pre-incident context only (cause, type, weather, corridor position,
     time). Champion = whichever holds up better on a chronological holdout.

  2. Cox Proportional Hazards — survival-analyses the response DURATION
     (see the caveat below on what this duration actually measures), the
     source for the clearance survival curve and the predicted-clearance-time
     output.

  3. A small logistic regression scoring "secondary incident risk": did
     another incident start nearby, before this one's response window
     closed? That label doesn't exist in the source data — it is derived
     here from a spatiotemporal self-join (see label_secondary_incidents()).

Data source and a real gap in it, stated up front:
  nlex_road_crashes / nlex_motorcycle_crashes carry a `severity` column, but
  it is 100% NULL on every row in this warehouse (verified: 8,641 + 1,077
  rows, zero non-null). Severity is therefore DERIVED here from recorded
  injury/fatality counts (0 -> PDO, injuries only -> Injury, any fatality ->
  Fatal) — the standard KABCO-style taxonomy, not an invented metric. Those
  same injury/fatality columns are consequences of the crash, not causes, so
  they are excluded from the FEATURE set below on pain of leaking the label
  into its own predictors.

  Neither table has a "cleared_time"/"road reopened" column — only
  `reported_time` and `response_time`, the same pair
  src/services/incident.service.ts's RESPONSE_MIN already computes minutes
  from for the descriptive dashboard. What this script calls `duration_min`
  is that same response-time gap, and it is a proxy for "time to clear",
  not a confirmed scene-cleared timestamp. Every caption downstream says
  "response duration" for this reason.

Only nlex_road_crashes and nlex_motorcycle_crashes feed this script.
nlex_stalled_vehicles is excluded: it carries no severity information and a
different (much sparser) feature set, and mixing a table with no severity at
all into a severity model would just be rows of missing labels.

Usage:
    python train_incident_severity_models.py                 # train + report only
    python train_incident_severity_models.py --write-db       # + write to gold.*
    python train_incident_severity_models.py --dry-write       # rehearse the write, then roll back
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import psycopg2
import psycopg2.extras
import statsmodels.api as sm
from dotenv import load_dotenv
from lifelines import CoxPHFitter
from sklearn.metrics import accuracy_score, mean_absolute_error, roc_auc_score
from statsmodels.miscmodels.ordinal_model import OrderedModel
from xgboost import XGBClassifier

SEED = 42
# Chronological holdout, same "score on the most recent slice" protocol as
# train_incident_models.py's default (protocol="holdout") — trains on the
# older ~80%, scores on the most recent ~20% of incidents by report time.
HOLDOUT_FRACTION = 0.2
# How close two incidents' km-posts have to be to count as "nearby" for the
# secondary-incident label. NLEX's 20 exits average ~4km apart, so 2km is
# roughly "the same immediate stretch of corridor", not the whole highway.
SECONDARY_KM_RADIUS = 2.0
# Extra minutes added past a primary incident's own response duration before
# its "secondary incident" window closes — a following incident during the
# response itself, plus a short tail while the scene is still being cleared.
SECONDARY_BUFFER_MIN = 30


def set_all_seeds(seed: int = SEED) -> None:
    random.seed(seed)
    np.random.seed(seed)


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
# Data loading
# ---------------------------------------------------------------------------
_D = "CASE WHEN date LIKE '%/%' THEN to_date(date, 'MM/DD/YYYY') ELSE date::date END"
POOLED_INCIDENTS_SQL = f"""
    SELECT {_D} AS d, reported_time, response_time, cause_of_accident, type_of_accident,
           weather_condition, km_value,
           COALESCE(injuries_male, 0) + COALESCE(injuries_female, 0) AS injuries,
           COALESCE(fatalities_male, 0) + COALESCE(fatalities_female, 0) AS fatalities,
           'road' AS source
    FROM nlex_road_crashes
    WHERE date IS NOT NULL AND km_value IS NOT NULL
      AND reported_time IS NOT NULL AND response_time IS NOT NULL
    UNION ALL
    SELECT {_D} AS d, reported_time, response_time, cause_of_accident, type_of_accident,
           weather_condition, km_value,
           COALESCE(injuries_male, 0) + COALESCE(injuries_female, 0),
           COALESCE(fatalities_male, 0) + COALESCE(fatalities_female, 0),
           'moto'
    FROM nlex_motorcycle_crashes
    WHERE date IS NOT NULL AND km_value IS NOT NULL
      AND reported_time IS NOT NULL AND response_time IS NOT NULL
"""


def load_holidays(conn) -> set:
    df = pd.read_sql("SELECT date_day FROM dim_holiday WHERE is_holiday", conn)
    return set(pd.to_datetime(df["date_day"]).dt.date)


def load_incidents(conn) -> pd.DataFrame:
    df = pd.read_sql(POOLED_INCIDENTS_SQL, conn)
    df["d"] = pd.to_datetime(df["d"])
    return df


# ---------------------------------------------------------------------------
# Feature/label construction
# ---------------------------------------------------------------------------
def build_features(df: pd.DataFrame, holidays: set) -> pd.DataFrame:
    out = df.copy()

    # reported_time/response_time carry a date component that is not
    # trustworthy on its own (the same reason RESPONSE_MIN in
    # incident.service.ts truncates both to ::time before differencing) — the
    # authoritative date is `d`. duration_min re-derives that exact formula
    # (mod 1440, so a response past midnight still reads as a small positive
    # gap rather than a large negative one), and full_reported_at re-anchors
    # reported_time's time-of-day onto `d` so every downstream timestamp
    # comparison (the secondary-incident window, the holdout split) uses a
    # date that is actually correct.
    reported_t = pd.to_datetime(out["reported_time"]).dt.time
    response_t = pd.to_datetime(out["response_time"]).dt.time
    reported_sec = reported_t.map(lambda t: t.hour * 3600 + t.minute * 60 + t.second)
    response_sec = response_t.map(lambda t: t.hour * 3600 + t.minute * 60 + t.second)
    out["duration_min"] = ((response_sec - reported_sec + 86400) % 86400) / 60.0
    # A handful of exact-zero durations are plausible (immediate response
    # logged to the same minute); Cox PH's log-hazard blows up at exactly
    # zero, so this floors them at 30 seconds rather than dropping real rows.
    out["duration_min"] = out["duration_min"].clip(lower=0.5)

    out["full_reported_at"] = out["d"] + pd.to_timedelta(reported_sec, unit="s")
    out["hour_of_day"] = reported_sec // 3600

    # Severity: derived, not read — see the module docstring for why (the
    # source `severity` column is entirely NULL). injuries/fatalities are
    # kept on the frame for this derivation only; build_design_matrix below
    # excludes both from the feature set.
    out["severity_code"] = np.select(
        [out["fatalities"] > 0, out["injuries"] > 0],
        [2, 1],
        default=0,
    )

    dow = out["d"].dt.dayofweek
    doy = out["d"].dt.dayofyear
    out["dow"] = dow
    out["is_weekend"] = dow.isin([5, 6]).astype(int)
    out["is_holiday"] = out["d"].dt.date.map(lambda x: int(x in holidays))
    out["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
    out["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)

    return out.sort_values("full_reported_at").reset_index(drop=True)


def label_secondary_incidents(df: pd.DataFrame) -> pd.Series:
    """For each incident, did another incident (source table irrelevant —
    both pools share one corridor) start within SECONDARY_KM_RADIUS of it and
    within [its own report time, its own report time + response duration +
    SECONDARY_BUFFER_MIN]?

    O(n log n) via a time-sorted search rather than an O(n^2) pairwise scan:
    df is already sorted by full_reported_at (build_features' last step), so
    for each row the candidate window is a contiguous slice found by
    searchsorted, and only THAT slice is checked against the km radius.
    """
    times = df["full_reported_at"].values
    kms = df["km_value"].values
    window_end = (df["full_reported_at"] + pd.to_timedelta(df["duration_min"] + SECONDARY_BUFFER_MIN, unit="m")).values

    has_secondary = np.zeros(len(df), dtype=bool)
    lo_idx = np.searchsorted(times, times, side="right")  # first candidate strictly after this row
    for i in range(len(df)):
        hi = np.searchsorted(times, window_end[i], side="right")
        lo = lo_idx[i]
        if hi <= lo:
            continue
        nearby = np.abs(kms[lo:hi] - kms[i]) <= SECONDARY_KM_RADIUS
        has_secondary[i] = bool(nearby.any())
    return pd.Series(has_secondary, index=df.index, name="had_secondary")


CATEGORICAL_COLS = ["cause_of_accident", "type_of_accident", "weather_condition", "source"]
NUMERIC_COLS = ["km_value", "hour_of_day", "dow", "is_weekend", "is_holiday", "doy_sin", "doy_cos"]


def build_design_matrix(df: pd.DataFrame, dummy_columns: list[str] | None = None) -> pd.DataFrame:
    """Pre-incident-context features only — no injuries/fatalities/duration/
    severity_code/had_secondary, all of which are outcomes of the incident,
    not context available before or at the moment it was reported.

    `dummy_columns` pins the one-hot column set (fit on train, reindexed onto
    validation/holdout) so a category absent from one split can't silently
    shift every other column's position in X.
    """
    X = pd.get_dummies(df[CATEGORICAL_COLS], drop_first=True)
    X = pd.concat([df[NUMERIC_COLS].reset_index(drop=True), X.reset_index(drop=True)], axis=1)
    X = X.astype(float)
    if dummy_columns is not None:
        X = X.reindex(columns=dummy_columns, fill_value=0.0)
    return X


# ---------------------------------------------------------------------------
# Model 1: Severity — Ordinal Logistic Regression vs XGBoost
# ---------------------------------------------------------------------------
SEVERITY_LABELS = {0: "Property Damage Only", 1: "Injury", 2: "Fatal"}


# Verified against a real run: OrdinalLogistic and XGBoost land on the exact
# same holdout predictions (100% row agreement), which traces to `source`
# alone — motorcycle crashes are 76.6% injury-involved here against 8.2% for
# cars (riders have none of a car's physical protection), a signal so
# dominant that neither model finds enough elsewhere to move off the
# moto->Injury / road->PDO split it induces. Not a bug and not leakage
# (source is known at report time); it does mean most of both models'
# "skill" over the majority-class baseline reduces to that one split.
def fit_severity_models(train: pd.DataFrame, holdout: pd.DataFrame) -> dict:
    X_train = build_design_matrix(train)
    X_holdout = build_design_matrix(holdout, dummy_columns=list(X_train.columns))
    y_train, y_holdout = train["severity_code"].values, holdout["severity_code"].values

    ordinal = OrderedModel(y_train, X_train, distr="logit")
    ordinal_res = ordinal.fit(method="bfgs", disp=False, maxiter=200)
    ordinal_proba = np.asarray(ordinal_res.predict(X_holdout))
    ordinal_pred = ordinal_proba.argmax(axis=1)

    xgb = XGBClassifier(
        n_estimators=200, max_depth=4, learning_rate=0.05, subsample=0.9,
        colsample_bytree=0.9, objective="multi:softprob", num_class=3, random_state=SEED,
    )
    xgb.fit(X_train, y_train)
    xgb_pred = xgb.predict(X_holdout)

    def metrics_for(pred: np.ndarray) -> dict:
        return {
            "accuracy": float(accuracy_score(y_holdout, pred)),
            # Ordinal codes are a real ordering (PDO < Injury < Fatal), so a
            # miss of one class away from the truth is a smaller error than
            # a miss of two — MAE on the code captures that; plain accuracy
            # would score both misses identically.
            "MAE_ordinal": float(mean_absolute_error(y_holdout, pred)),
            "n": int(len(y_holdout)),
        }

    ordinal_metrics = metrics_for(ordinal_pred)
    xgb_metrics = metrics_for(xgb_pred)
    champion = "OrdinalLogistic" if ordinal_metrics["accuracy"] >= xgb_metrics["accuracy"] else "XGBoost"

    holdout_predictions = holdout[["d", "full_reported_at", "km_value", "source", "severity_code"]].copy()
    holdout_predictions["pred_ordinal"] = ordinal_pred
    holdout_predictions["pred_xgboost"] = xgb_pred
    holdout_predictions["pred_champion"] = ordinal_pred if champion == "OrdinalLogistic" else xgb_pred

    return {
        "champion": champion,
        "metrics": {"OrdinalLogistic": ordinal_metrics, "XGBoost": xgb_metrics},
        "holdout_predictions": holdout_predictions,
        "feature_columns": list(X_train.columns),
    }


# ---------------------------------------------------------------------------
# Model 2: Cox PH — response-duration survival, feeds the clearance curve
# ---------------------------------------------------------------------------
def fit_cox_ph(train: pd.DataFrame, holdout: pd.DataFrame) -> dict:
    X_train = build_design_matrix(train)
    X_holdout = build_design_matrix(holdout, dummy_columns=list(X_train.columns))

    cox_train = X_train.copy()
    cox_train["duration_min"] = train["duration_min"].values
    # No censoring signal exists in this data (every historical incident has
    # a recorded response_time) — event=1 throughout. A genuinely open,
    # not-yet-responded-to incident would be the honest place to introduce
    # censoring, and there are none of those in a historical training table.
    cox_train["event"] = 1.0

    cph = CoxPHFitter(penalizer=0.1)  # small L2 penalty: several one-hot columns are near-collinear (cause x type)
    cph.fit(cox_train, duration_col="duration_min", event_col="event")

    pred_median = cph.predict_median(X_holdout)
    # predict_median returns inf when a row's estimated survival never drops
    # below 0.5 within the observed follow-up window — falls back to that
    # row's expected value (still finite) rather than leaving an
    # unusable infinity in what gets written to the DB.
    pred_expectation = cph.predict_expectation(X_holdout)
    pred_clearance = pred_median.where(np.isfinite(pred_median), pred_expectation)

    finite_mask = np.isfinite(pred_clearance.values)
    mae = float(mean_absolute_error(
        holdout["duration_min"].values[finite_mask], pred_clearance.values[finite_mask]
    )) if finite_mask.any() else None

    # Representative survival curves for the clearance-survival-curve
    # visualization: the corridor-wide baseline, plus one curve per severity
    # class holding every other covariate at its training-set mean — shows
    # whether a more severe incident is expected to take longer to clear.
    baseline = cph.baseline_survival_.iloc[:, 0]
    curves = [{"group": "Baseline (average incident)", "times": baseline.index.tolist(), "survival": baseline.values.tolist()}]

    mean_profile = X_train.mean().to_frame().T
    for code, label in SEVERITY_LABELS.items():
        profile = mean_profile.copy()
        # Severity itself isn't a Cox PH covariate (it's excluded from
        # build_design_matrix as an outcome, same as injuries/fatalities) —
        # these group curves instead condition on the average incident of
        # each OBSERVED severity class's own feature profile, which is the
        # honest way to ask "how did fatal incidents actually tend to clear"
        # without fabricating severity as something Cox PH was fit to use.
        subset = train[train["severity_code"] == code]
        if len(subset) == 0:
            continue
        subset_X = build_design_matrix(subset, dummy_columns=list(X_train.columns))
        profile = subset_X.mean().to_frame().T
        sf = cph.predict_survival_function(profile)
        curves.append({"group": label, "times": sf.index.tolist(), "survival": sf.iloc[:, 0].values.tolist()})

    return {
        "concordance_index": float(cph.concordance_index_),
        "mae_minutes": mae,
        "n": int(len(holdout)),
        "pred_clearance": pred_clearance,
        "curves": curves,
        "coefficients": cph.summary.reset_index().rename(columns={"index": "variable"}).to_dict("records"),
    }


# ---------------------------------------------------------------------------
# Model 3: Secondary incident risk — small logistic regression
# ---------------------------------------------------------------------------
def fit_secondary_risk(train: pd.DataFrame, holdout: pd.DataFrame) -> dict:
    X_train = build_design_matrix(train)
    X_holdout = build_design_matrix(holdout, dummy_columns=list(X_train.columns))
    y_train, y_holdout = train["had_secondary"].astype(int).values, holdout["had_secondary"].astype(int).values

    Xtr_c = sm.add_constant(X_train, has_constant="add")
    Xho_c = sm.add_constant(X_holdout, has_constant="add")
    model = sm.Logit(y_train, Xtr_c).fit(disp=False, maxiter=200)
    proba = np.asarray(model.predict(Xho_c))

    auc = float(roc_auc_score(y_holdout, proba)) if len(np.unique(y_holdout)) > 1 else None

    return {
        "auc": auc,
        "base_rate": float(y_holdout.mean()),
        "n": int(len(y_holdout)),
        "holdout_scores": proba,
    }


# ---------------------------------------------------------------------------
# DB write
# ---------------------------------------------------------------------------
def ensure_schema(conn, commit: bool = True) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE SCHEMA IF NOT EXISTS gold;

            CREATE TABLE IF NOT EXISTS gold.ml_incident_severity_predictions (
                id SERIAL PRIMARY KEY,
                incident_date DATE NOT NULL,
                reported_at TIMESTAMPTZ NOT NULL,
                km_value DOUBLE PRECISION NOT NULL,
                source TEXT NOT NULL,
                actual_severity_code INT NOT NULL,
                predicted_severity_code INT NOT NULL,
                severity_model TEXT NOT NULL,
                predicted_clearance_min DOUBLE PRECISION,
                secondary_incident_risk DOUBLE PRECISION,
                actual_had_secondary BOOLEAN,
                trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS gold.ml_incident_survival_curve (
                id SERIAL PRIMARY KEY,
                group_label TEXT NOT NULL,
                time_min DOUBLE PRECISION NOT NULL,
                survival_probability DOUBLE PRECISION NOT NULL,
                trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS gold.ml_incident_severity_metadata (
                id SERIAL PRIMARY KEY,
                metadata_json JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            """
        )
    if commit:
        conn.commit()


def write_to_db(conn, holdout: pd.DataFrame, severity_out: dict, cox_out: dict,
                 secondary_out: dict, metadata: dict, dry: bool = False) -> None:
    ensure_schema(conn, commit=not dry)

    preds = severity_out["holdout_predictions"].reset_index(drop=True)
    clearance = cox_out["pred_clearance"].reset_index(drop=True)
    secondary_scores = secondary_out["holdout_scores"]
    actual_secondary = holdout["had_secondary"].reset_index(drop=True)

    def num(v):
        return None if v is None or (isinstance(v, float) and not np.isfinite(v)) else float(v)

    rows = []
    for i in range(len(preds)):
        rows.append((
            preds.loc[i, "d"].date(), preds.loc[i, "full_reported_at"], float(preds.loc[i, "km_value"]),
            preds.loc[i, "source"], int(preds.loc[i, "severity_code"]), int(preds.loc[i, "pred_champion"]),
            severity_out["champion"], num(clearance.iloc[i]), num(secondary_scores[i]), bool(actual_secondary.iloc[i]),
        ))

    with conn.cursor() as cur:
        cur.execute("DELETE FROM gold.ml_incident_severity_predictions")
        psycopg2.extras.execute_values(
            cur,
            """INSERT INTO gold.ml_incident_severity_predictions
               (incident_date, reported_at, km_value, source, actual_severity_code,
                predicted_severity_code, severity_model, predicted_clearance_min,
                secondary_incident_risk, actual_had_secondary) VALUES %s""",
            rows,
        )

        cur.execute("DELETE FROM gold.ml_incident_survival_curve")
        curve_rows = [
            (c["group"], t, s)
            for c in cox_out["curves"]
            for t, s in zip(c["times"], c["survival"])
        ]
        psycopg2.extras.execute_values(
            cur,
            "INSERT INTO gold.ml_incident_survival_curve (group_label, time_min, survival_probability) VALUES %s",
            curve_rows,
        )

        cur.execute("DELETE FROM gold.ml_incident_severity_metadata")
        cur.execute("INSERT INTO gold.ml_incident_severity_metadata (metadata_json) VALUES (%s)",
                    [json.dumps(metadata, default=str)])

    if dry:
        conn.rollback()
        print("DRY WRITE: every query ran, transaction rolled back — gold.* is unchanged")
    else:
        conn.commit()


def print_report(severity_out: dict, cox_out: dict, secondary_out: dict) -> str:
    L = []
    L.append("=" * 80)
    L.append("  INCIDENT SEVERITY / CLEARANCE MODELS (per-incident)")
    L.append("=" * 80)
    L.append("")
    L.append("  Severity — chronological holdout")
    for name, m in severity_out["metrics"].items():
        tag = "[SELECTED]" if name == severity_out["champion"] else ""
        L.append(f"    {name:<16} accuracy={m['accuracy']:.3f}  MAE_ordinal={m['MAE_ordinal']:.3f}  n={m['n']}  {tag}")
    L.append("")
    L.append("  Cox PH — response-duration survival (a proxy for clearance time; see module docstring)")
    L.append(f"    concordance index = {cox_out['concordance_index']:.3f}")
    L.append(f"    MAE (minutes)     = {cox_out['mae_minutes']:.2f}" if cox_out["mae_minutes"] is not None else "    MAE (minutes)     = n/a")
    L.append(f"    n                 = {cox_out['n']}")
    L.append("")
    L.append("  Secondary incident risk — logistic regression")
    L.append(f"    AUC       = {secondary_out['auc']:.3f}" if secondary_out["auc"] is not None else "    AUC       = n/a")
    L.append(f"    base rate = {secondary_out['base_rate'] * 100:.1f}% of holdout incidents had a secondary incident follow")
    L.append(f"    n         = {secondary_out['n']}")
    L.append("=" * 80)
    return "\n".join(L)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-db", action="store_true")
    parser.add_argument("--dry-write", action="store_true")
    args = parser.parse_args()

    conn = get_conn()
    try:
        print("Loading road + motorcycle crashes...")
        raw = load_incidents(conn)
        print(f"  {len(raw)} incidents (road + motorcycle only; stalled vehicles excluded — no severity data)")

        holidays = load_holidays(conn)
        feat = build_features(raw, holidays)

        print("Labeling secondary incidents (spatiotemporal self-join)...")
        feat["had_secondary"] = label_secondary_incidents(feat)
        print(f"  {feat['had_secondary'].sum()} of {len(feat)} incidents ({feat['had_secondary'].mean() * 100:.1f}%) "
              f"had another incident start within {SECONDARY_KM_RADIUS}km during their response window")

        cut = int(len(feat) * (1 - HOLDOUT_FRACTION))
        train, holdout = feat.iloc[:cut].reset_index(drop=True), feat.iloc[cut:].reset_index(drop=True)
        print(f"  train={len(train)} ({train['d'].min().date()}..{train['d'].max().date()})  "
              f"holdout={len(holdout)} ({holdout['d'].min().date()}..{holdout['d'].max().date()})")

        print("\nFitting severity models (Ordinal Logistic vs XGBoost)...")
        severity_out = fit_severity_models(train, holdout)

        print("Fitting Cox PH...")
        cox_out = fit_cox_ph(train, holdout)

        print("Fitting secondary-incident-risk logistic regression...")
        secondary_out = fit_secondary_risk(train, holdout)

        report = print_report(severity_out, cox_out, secondary_out)
        print("\n" + report)
        report_path = Path(__file__).resolve().parent / "model_results_severity.txt"
        report_path.write_text(report, encoding="utf-8")
        print(f"\nFull report written to {report_path}")

        if not args.write_db and not args.dry_write:
            print("\nTraining complete. Re-run with --write-db once you've reviewed the report above.")
            return

        metadata = {
            "severity": {"champion": severity_out["champion"], "metrics": severity_out["metrics"],
                         "feature_columns": severity_out["feature_columns"]},
            "cox_ph": {"concordance_index": cox_out["concordance_index"], "mae_minutes": cox_out["mae_minutes"],
                       "n": cox_out["n"], "coefficients": cox_out["coefficients"]},
            "secondary_risk": {"auc": secondary_out["auc"], "base_rate": secondary_out["base_rate"], "n": secondary_out["n"]},
            "secondary_km_radius": SECONDARY_KM_RADIUS,
            "secondary_buffer_min": SECONDARY_BUFFER_MIN,
            "holdout_fraction": HOLDOUT_FRACTION,
            "trained_at": pd.Timestamp.utcnow().isoformat(),
        }
        print("\nWriting gold.ml_incident_severity_predictions / ml_incident_survival_curve / ml_incident_severity_metadata...")
        write_to_db(conn, holdout, severity_out, cox_out, secondary_out, metadata,
                    dry=args.dry_write and not args.write_db)
        print("Rolled back (dry write)." if (args.dry_write and not args.write_db) else "Committed.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
