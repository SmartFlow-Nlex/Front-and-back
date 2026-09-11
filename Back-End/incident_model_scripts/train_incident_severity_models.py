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

  2. Cox Proportional Hazards — survival-analyses the CLEARANCE duration
     (site_cleared - event_start_date, a real elapsed time now — see the
     data-source note below), the source for the clearance survival curve
     and the predicted-clearance-time output.

  3. A small logistic regression scoring "secondary incident risk": did
     another incident start nearby, before this one's clearance window
     closed? That label doesn't exist in the source data — it is derived
     here from a spatiotemporal self-join (see label_secondary_incidents()).

Data source (rebuilt on the accident_data event export — see below for the
two gaps this closes relative to the old nlex_road_crashes/
nlex_motorcycle_crashes source):
  silver.nlex_accident_events_clean carries REAL, recorded
  number_of_injured / number_of_fatality counts (unlike nlex_road_crashes /
  nlex_motorcycle_crashes, whose `severity` column is 100% NULL on every
  row). Severity is still DERIVED from those counts (0 -> PDO, injuries only
  -> Injury, any fatality -> Fatal, the standard KABCO-style taxonomy), but
  the counts themselves are now genuine, not an always-empty placeholder.
  Those same injury/fatality columns are consequences of the accident, not
  causes, so they stay excluded from the FEATURE set below on pain of
  leaking the label into its own predictors.

  This table also carries a real scene-cleared timestamp, site_cleared —
  unlike the old tables, which had no clearance column at all (only
  reported_time/response_time, the same pair
  src/services/incident.service.ts's RESPONSE_MIN computes minutes from for
  the descriptive dashboard, and which this script used to reuse as a
  "time to clear" proxy). `duration_min` below is now
  site_cleared - event_start_date: a real elapsed-time-to-clear, not a
  proxy — every caption downstream can honestly say "clearance time"
  instead of "response duration".

Only accident_data (silver.nlex_accident_events_clean) feeds this script.
breakdown_data (silver.nlex_breakdown_events_clean) is excluded: mechanical
breakdowns carry no injury/fatality information at all, so mixing it in
would just be rows of missing severity labels — the same reason
nlex_stalled_vehicles was excluded from the old version of this script. Its
per-service dispatch/response records (`deployments`) feed a separate,
purely descriptive analysis (getEventBreakdownFromDb / /api/incident/event-breakdown)
rather than this trained-model pipeline.

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
# Extra minutes added past a primary incident's own clearance duration before
# its "secondary incident" window closes — a following incident during the
# clearance itself, plus a short tail after the scene is reported cleared.
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
# event_start_date/site_cleared are already full, trustworthy timestamps (no
# date/time-of-day split to reconstruct, unlike the old road/moto tables) —
# see build_features for what that simplifies. clearance_min is silver's own
# derivation (NULLed, not row-dropped, when outside 0-1440 minutes).
POOLED_INCIDENTS_SQL = """
    SELECT event_start_date::date AS d, event_start_date, site_cleared, clearance_min,
           main_cause, sub_cause, type_of_event, weather_condition,
           damage_to_property, km_value, number_of_vehicles,
           number_of_injured AS injuries, number_of_fatality AS fatalities,
           'accident' AS source
    FROM silver.nlex_accident_events_clean
    WHERE event_start_date IS NOT NULL AND km_value IS NOT NULL
      AND site_cleared IS NOT NULL
"""


def load_holidays(conn) -> set:
    df = pd.read_sql("SELECT date_day FROM dim_holiday WHERE is_holiday", conn)
    return set(pd.to_datetime(df["date_day"]).dt.date)


def load_incidents(conn) -> pd.DataFrame:
    df = pd.read_sql(POOLED_INCIDENTS_SQL, conn)
    df["d"] = pd.to_datetime(df["d"])
    return df


# split_label = '80_20': mirrors train_incident_models.py's own
# DAILY_VOLUME_SQL, kept in sync by hand — that table stores each date twice
# (an '80_20' and a '90_10' row), and an unfiltered join silently doubles
# every value. See that script's own doc comment for the full incident.
DAILY_VOLUME_SQL = """
    SELECT forecast_date AS d, actual_volume::float AS volume
    FROM gold.ml_predictive_volume
    WHERE actual_volume IS NOT NULL AND split_label = '80_20'
    ORDER BY 1
"""


def load_daily_volume(conn) -> pd.DataFrame:
    """Volume covers 2022-01-01 onward; accident_data starts right around the
    same date, so coverage is now high (89.0% of accidents, verified) rather
    than the ~28%-missing gap the old road/moto-crash source (which ran back
    to 2020) had — but it is not total, and the remaining gap is not papered
    over with an imputed value. Rows outside coverage carry volume=NaN and
    are excluded from any grouping that needs it, the same way a handful of
    null predicted_clearance_min rows already get excluded from that average
    elsewhere in this pipeline rather than filled in."""
    df = pd.read_sql(DAILY_VOLUME_SQL, conn)
    df["d"] = pd.to_datetime(df["d"])
    return df


# ---------------------------------------------------------------------------
# Feature/label construction
# ---------------------------------------------------------------------------
def build_features(df: pd.DataFrame, holidays: set) -> pd.DataFrame:
    out = df.copy()

    # event_start_date/site_cleared are already full, trustworthy timestamps
    # (unlike the old reported_time/response_time pair, which carried only a
    # time-of-day and had to be re-anchored onto `d` by hand) — clearance_min
    # is silver's own site_cleared - event_start_date derivation, already
    # NULLed there when it fell outside 0-1440 minutes. A handful of
    # exact-zero durations are plausible (an immediate clear logged to the
    # same minute); Cox PH's log-hazard blows up at exactly zero, so this
    # floors them at 30 seconds rather than dropping real rows.
    out["duration_min"] = out["clearance_min"].clip(lower=0.5)
    out["event_start_date"] = pd.to_datetime(out["event_start_date"])
    out["hour_of_day"] = out["event_start_date"].dt.hour

    # Log-transformed to match train_incident_models.py's own log_volume
    # feature (same corridor-wide daily total, same reasoning: incident
    # counts/response times relate to volume multiplicatively, not linearly).
    # NaN on any incident date that predates volume tracking (2022-01-01) —
    # left as NaN rather than filled, since fit_cox_ph filters on it directly
    # rather than silently training on a guessed value.
    out["log_volume"] = np.log1p(out["volume"])

    # Severity: derived from real recorded injury/fatality counts (0 -> PDO,
    # injuries only -> Injury, any fatality -> Fatal, KABCO-style) — see the
    # module docstring for how this differs from the old, always-NULL source
    # column. injuries/fatalities are kept on the frame for this derivation
    # only; build_design_matrix below excludes both from the feature set.
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

    # duration_min is NaN on the handful of rows silver already NULLed as
    # outside a plausible 0-1440-minute clearance window — not dropped here
    # (severity classification and secondary-incident labeling don't need a
    # valid duration), the same "filter locally, at the model that actually
    # needs the value" approach fit_cox_ph already uses for volume below.
    return out.sort_values("event_start_date").reset_index(drop=True)


def label_secondary_incidents(df: pd.DataFrame) -> pd.Series:
    """For each incident, did another incident start within
    SECONDARY_KM_RADIUS of it and within [its own report time, its own
    report time + clearance duration + SECONDARY_BUFFER_MIN]?

    O(n log n) via a time-sorted search rather than an O(n^2) pairwise scan:
    df is already sorted by event_start_date (build_features' last step), so
    for each row the candidate window is a contiguous slice found by
    searchsorted, and only THAT slice is checked against the km radius.
    """
    times = df["event_start_date"].values
    kms = df["km_value"].values
    # duration_min is NaN on the rare row silver couldn't derive a plausible
    # clearance for (see build_features) — falls back to just the buffer
    # window rather than propagating NaT, so those incidents still get a
    # secondary-incident check instead of silently never being flagged.
    duration = df["duration_min"].fillna(0)
    window_end = (df["event_start_date"] + pd.to_timedelta(duration + SECONDARY_BUFFER_MIN, unit="m")).values

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


# `source` and `damage_to_property` are deliberately excluded: source is now
# constant ('accident' — see POOLED_INCIDENTS_SQL, kept only as gold-table
# metadata) and damage_to_property is an outcome of the incident, not
# pre-incident context (same leakage reasoning that excludes
# injuries/fatalities below) — it's used only as a Cox-curve grouping
# dimension, not a model feature (see fit_cox_ph).
#
# `main_cause` is ALSO excluded, not just redundant-but-harmless: it's a
# strict coarsening of `sub_cause` (verified — every one of the 20 sub_cause
# values maps to exactly one main_cause, 0 exceptions), so one-hot-encoding
# both together makes their combined dummy columns perfectly collinear.
# statsmodels' OrderedModel actively rejects that ("There should not be a
# constant in the model" — an implicit-constant rank check, not a literal
# constant column) rather than silently dropping the redundant df like
# XGBoost would. sub_cause alone carries at least as much signal.
CATEGORICAL_COLS = ["sub_cause", "type_of_event", "weather_condition"]
NUMERIC_COLS = ["km_value", "number_of_vehicles", "hour_of_day", "dow", "is_weekend", "is_holiday", "doy_sin", "doy_cos"]


def build_design_matrix(
    df: pd.DataFrame, dummy_columns: list[str] | None = None, numeric_cols: list[str] | None = None
) -> pd.DataFrame:
    """Pre-incident-context features only — no injuries/fatalities/duration/
    severity_code/had_secondary, all of which are outcomes of the incident,
    not context available before or at the moment it was reported.

    `dummy_columns` pins the one-hot column set (fit on train, reindexed onto
    validation/holdout) so a category absent from one split can't silently
    shift every other column's position in X.

    `numeric_cols` overrides the module-level NUMERIC_COLS — used by
    fit_cox_ph to add log_volume for the rows that actually have it, without
    forcing severity/secondary-risk (which run on the full, not
    volume-filtered, dataset) to carry a column full of NaN for the ~28% of
    incidents that predate volume tracking.

    Keeps df's own index on the result (order-preserving, so a caller that
    filtered df to a subset can reindex predictions back onto the original
    frame afterward) rather than resetting to 0..n-1.
    """
    cols = numeric_cols if numeric_cols is not None else NUMERIC_COLS
    X = pd.get_dummies(df[CATEGORICAL_COLS], drop_first=True)
    X = pd.concat([df[cols], X], axis=1)
    X = X.astype(float)
    if dummy_columns is not None:
        X = X.reindex(columns=dummy_columns, fill_value=0.0)
    return X


# ---------------------------------------------------------------------------
# Model 1: Severity — Ordinal Logistic Regression vs XGBoost
# ---------------------------------------------------------------------------
SEVERITY_LABELS = {0: "Property Damage Only", 1: "Injury", 2: "Fatal"}
# Replaces the old road-vs-motorcycle SOURCE_LABELS: with a single accident
# source table there's no source split left to report, but damage_to_property
# is a real, validated 2-way split in this data (median clearance 4min vs
# 12min — see the module docstring / migration notes) and fills the same
# role for the Cox-curve cross-comparison below.
DAMAGE_LABELS = {"NO": "No Property Damage", "YES": "Property Damage"}


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

    holdout_predictions = holdout[["d", "event_start_date", "km_value", "source", "severity_code"]].copy()
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
    # weather_condition is already in CATEGORICAL_COLS (100% coverage, no
    # filtering needed) — already a trained covariate here, moving every
    # predicted_clearance_min below. Volume is not, and can't just be added
    # to NUMERIC_COLS: accident_data starts 2021-12-31/2022-01-01, almost
    # exactly when volume tracking does, so coverage is now high (89.0% —
    # 19,076 of 21,428 incidents, verified) but not total, and Cox PH can't
    # fit through a NaN column.
    #
    # Rather than impute a guessed volume for those rows (fabricating a
    # feature value the incident never actually had) or drop them from every
    # model in this script (severity/secondary-risk don't need volume and
    # would lose real training data for no reason), the Cox regression is
    # fit and scored on the volume-covered subset only — a real train/test
    # split on the rows that genuinely have the feature, honestly reported
    # via cox_n/cox_coverage below rather than silently smaller. Holdout
    # rows outside that coverage simply get predicted_clearance_min=None:
    # an honest "can't score this one," not a value borrowed from a model
    # that never saw a comparable row. A row with no valid duration_min
    # (silver NULLed it — see build_features) is excluded from this fit for
    # the same reason: Cox PH cannot fit a NaN duration.
    cox_numeric_cols = NUMERIC_COLS + ["log_volume"]
    train_covered = train[train["volume"].notna() & train["duration_min"].notna()]
    holdout_covered = holdout[holdout["volume"].notna() & holdout["duration_min"].notna()]

    X_train = build_design_matrix(train_covered, numeric_cols=cox_numeric_cols)
    X_holdout_covered = build_design_matrix(holdout_covered, dummy_columns=list(X_train.columns), numeric_cols=cox_numeric_cols)

    cox_train = X_train.copy()
    cox_train["duration_min"] = train_covered["duration_min"].values
    # No censoring signal exists in this data (train_covered already requires
    # a valid duration_min, i.e. a real recorded site_cleared) — event=1
    # throughout. A genuinely open, not-yet-cleared incident would be the
    # honest place to introduce censoring, and there are none of those in a
    # historical training table.
    cox_train["event"] = 1.0

    cph = CoxPHFitter(penalizer=0.1)  # small L2 penalty: several one-hot columns are near-collinear (cause x type)
    cph.fit(cox_train, duration_col="duration_min", event_col="event")

    pred_median_covered = cph.predict_median(X_holdout_covered)
    # predict_median returns inf when a row's estimated survival never drops
    # below 0.5 within the observed follow-up window — falls back to that
    # row's expected value (still finite) rather than leaving an
    # unusable infinity in what gets written to the DB.
    pred_expectation_covered = cph.predict_expectation(X_holdout_covered)
    pred_clearance_covered = pred_median_covered.where(np.isfinite(pred_median_covered), pred_expectation_covered)
    # Reindexed back onto the FULL holdout (build_design_matrix keeps the
    # input's own index, so this lines up row-for-row) — every holdout row
    # gets a slot, volume-covered or not, which is what write_to_db's
    # positional loop over the full holdout requires; rows outside coverage
    # land as NaN here and become a null predicted_clearance_min there.
    pred_clearance = pred_clearance_covered.reindex(holdout.index)

    finite_mask = np.isfinite(pred_clearance.values)
    mae = float(mean_absolute_error(
        holdout["duration_min"].values[finite_mask], pred_clearance.values[finite_mask]
    )) if finite_mask.any() else None
    cox_n = int(len(train_covered)) + int(len(holdout_covered))

    # Representative survival curves for the clearance-survival-curve
    # visualization: the corridor-wide baseline, plus one curve per severity
    # class and one per damage_to_property value. Built from the EMPIRICAL
    # data (Kaplan-Meier), not from the Cox model, and that choice is
    # load-bearing, not stylistic:
    #
    # A prior version of this script (over the old road/moto-crash source)
    # built each group's curve by averaging that group's covariates into one
    # "representative profile" and scoring THAT through
    # cph.predict_survival_function — a known statistical trap for a
    # non-linear model, caught there by cross-checking averaged-then-predicted
    # medians against the model's own per-row predict_median on real holdout
    # rows and against the exact raw (zero-censoring) medians: averaging first
    # was quietly wrong by tens of minutes. That risk is structural to Cox PH,
    # not specific to the old data, so the same fix carries forward here:
    # group curves are never routed through the regularized, collinear
    # covariate model. With event=1 on every row (no incident here is still
    # open), Kaplan-Meier collapses to the plain empirical survival function,
    # which is simple, exact by construction, and unaffected by whatever the
    # model's fit does elsewhere. The Cox model itself is untouched for what
    # it's actually suited to — the per-incident predicted_clearance_min
    # above, the concordance KPI, and the coefficient table — this only
    # changes how the DISPLAYED group curves are built.
    def empirical_curve(durations: np.ndarray) -> tuple[list[float], list[float]]:
        d = np.sort(durations)
        n = len(d)
        times = np.unique(d).tolist()
        survival = [float((d > t).sum() / n) for t in times]
        return times, survival

    def group_curve(mask: pd.Series, label: str, dimension: str) -> dict | None:
        subset = train.loc[mask, "duration_min"].values
        if len(subset) == 0:
            return None
        times, survival = empirical_curve(subset)
        # n travels with every curve, not just the crossed ones — the
        # crossed cells are the thinnest (as low as 25), but a reader
        # comparing across views has no way to know that unless every curve
        # states its own sample size, not only the ones that happen to need it.
        return {"group": label, "dimension": dimension, "times": times, "survival": survival, "n": int(len(subset))}

    base_times, base_survival = empirical_curve(train["duration_min"].values)
    curves = [{
        "group": "Baseline (average incident)", "dimension": "baseline",
        "times": base_times, "survival": base_survival, "n": int(len(train)),
    }]

    for code, label in SEVERITY_LABELS.items():
        c = group_curve(train["severity_code"] == code, label, "severity")
        if c:
            curves.append(c)

    # A second factor alongside severity — damage_to_property (NO/YES) — is a
    # real, verified clearance-time split in this data: median 4min (NO,
    # n=18,962) vs 12min (YES, n=2,466), mean 19.1 vs 50.9 (checked against
    # the live warehouse). weather_condition was checked too and ruled out
    # (Fair vs Rainy medians 5min vs 6min — not a real split), the same
    # "is this real" scrutiny that rules stalled vehicles out of this script
    # entirely (that table's response-time field is near-uniform random noise
    # over 0-8 minutes, not a genuine duration signal).
    for dmg, label in DAMAGE_LABELS.items():
        c = group_curve(train["damage_to_property"] == dmg, label, "damage_to_property")
        if c:
            curves.append(c)

    # Both factors crossed — 2 damage values x 3 severities. Smallest cross
    # cell in the full ingested dataset is n=15 (Property Damage x Fatal,
    # verified against the live warehouse) — thin, but real; n travels with
    # each curve's group label so the frontend can show it rather than let a
    # 15-incident curve read with the same implied confidence as a
    # thousands-incident one.
    for dmg, dmg_label in DAMAGE_LABELS.items():
        for code, sev_label in SEVERITY_LABELS.items():
            mask = (train["damage_to_property"] == dmg) & (train["severity_code"] == code)
            c = group_curve(mask, f"{dmg_label} — {sev_label}", "both")
            if c:
                curves.append(c)

    # Km position along the corridor — a fourth factor, rendered by the
    # frontend as a bar chart of each segment's median rather than more
    # overlaid survival curves (six "both" lines is already close to the
    # limit of what one chart can show).
    #
    # km_value is now near-continuous (946 distinct values across ~21K
    # accidents, verified — StartKM is recorded to the nearest 100m, not
    # snapped to coarse waypoints the way the old crash tables were), so
    # fixed-width bins would be a reasonable option here too; quantile bins
    # are kept anyway for the same guarantee they gave the old, coarser data
    # — equal INCIDENT COUNT per segment, unequal km width — so every segment
    # has comparable statistical power, and the label states the actual km
    # range each one covers so the unequal width is never hidden.
    KM_QUANTILE_GROUPS = 4
    sorted_train = train.sort_values("km_value")
    n_train = len(sorted_train)
    group_size = n_train // KM_QUANTILE_GROUPS
    for i in range(KM_QUANTILE_GROUPS):
        lo = i * group_size
        hi = (i + 1) * group_size if i < KM_QUANTILE_GROUPS - 1 else n_train
        chunk = sorted_train.iloc[lo:hi]
        km_lo, km_hi = float(chunk["km_value"].min()), float(chunk["km_value"].max())
        mask = pd.Series(train.index.isin(chunk.index), index=train.index)
        c = group_curve(mask, f"Km {km_lo:.0f}–{km_hi:.0f}", "km")
        if c:
            curves.append(c)

    return {
        "concordance_index": float(cph.concordance_index_),
        "mae_minutes": mae,
        "n": int(len(holdout)),
        # The model now trains and scores on the volume-covered subset only
        # (see the doc comment at the top of this function) — cox_n/
        # cox_coverage_pct report that real, smaller sample honestly rather
        # than letting the headline "n" above imply the full holdout was used.
        "cox_n": cox_n,
        "cox_coverage_pct": float(cox_n / (len(train) + len(holdout)) * 100),
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

            -- Which factor a curve is grouped by ('baseline' / 'severity' /
            -- 'damage_to_property' / 'km' / 'both') — lets the dashboard
            -- offer toggled views instead of every curve on one chart. Added
            -- via ALTER because the table predates the crossed curves; the
            -- dimension's own values changed from 'source' to
            -- 'damage_to_property' when this script moved to accident_data
            -- (see fit_cox_ph), which needed no schema change — dimension
            -- and group_label were already plain TEXT.
            ALTER TABLE gold.ml_incident_survival_curve
                ADD COLUMN IF NOT EXISTS dimension TEXT NOT NULL DEFAULT 'severity';

            -- How many incidents this one curve is built from — the 'both'
            -- (severity x damage_to_property) cross has cells as thin as 15,
            -- and a reader has no way to know that unless every curve states
            -- its own sample size.
            ALTER TABLE gold.ml_incident_survival_curve
                ADD COLUMN IF NOT EXISTS n INT;

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
            preds.loc[i, "d"].date(), preds.loc[i, "event_start_date"], float(preds.loc[i, "km_value"]),
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
            (c["group"], c["dimension"], t, s, c["n"])
            for c in cox_out["curves"]
            for t, s in zip(c["times"], c["survival"])
        ]
        psycopg2.extras.execute_values(
            cur,
            "INSERT INTO gold.ml_incident_survival_curve (group_label, dimension, time_min, survival_probability, n) VALUES %s",
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
    L.append("  Cox PH — clearance-time survival (site_cleared - event_start_date; see module docstring)")
    L.append(f"    concordance index = {cox_out['concordance_index']:.3f}")
    L.append(f"    MAE (minutes)     = {cox_out['mae_minutes']:.2f}" if cox_out["mae_minutes"] is not None else "    MAE (minutes)     = n/a")
    L.append(f"    n (holdout)       = {cox_out['n']}")
    L.append(f"    trained+scored on = {cox_out['cox_n']} incidents with known daily volume "
              f"({cox_out['cox_coverage_pct']:.1f}% of all incidents — volume now a real covariate, "
              f"alongside weather, cause, type, and corridor position)")
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
        print("Loading accident events...")
        raw = load_incidents(conn)
        print(f"  {len(raw)} accidents (accident_data only; breakdown_data excluded — no severity data)")

        volume = load_daily_volume(conn)
        raw = raw.merge(volume, on="d", how="left")
        covered = int(raw["volume"].notna().sum())
        print(f"  {covered} of {len(raw)} incidents ({covered / len(raw) * 100:.1f}%) fall on a date with known "
              f"traffic volume (tracking starts {volume['d'].min().date()}) and can feed volume into the Cox PH "
              f"clearance model below; the rest are excluded from that fit rather than backfilled with a guess")

        holidays = load_holidays(conn)
        feat = build_features(raw, holidays)

        print("Labeling secondary incidents (spatiotemporal self-join)...")
        feat["had_secondary"] = label_secondary_incidents(feat)
        print(f"  {feat['had_secondary'].sum()} of {len(feat)} incidents ({feat['had_secondary'].mean() * 100:.1f}%) "
              f"had another incident start within {SECONDARY_KM_RADIUS}km during their clearance window")

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
                       "n": cox_out["n"], "cox_n": cox_out["cox_n"], "cox_coverage_pct": cox_out["cox_coverage_pct"],
                       "coefficients": cox_out["coefficients"]},
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
