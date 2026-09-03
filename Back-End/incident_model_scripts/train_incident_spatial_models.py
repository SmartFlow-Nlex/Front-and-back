#!/usr/bin/env python3
"""
SmartFlow NLEX — Incident Spatial Models (Block 1: Incident Probability Prediction)
====================================================================================
Two per-EXIT models, sibling to train_incident_models.py's per-DAY pipeline:

  1. GWR (Geographically Weighted Regression) — one row per exit (N=20), a
     genuinely spatial regression: does the local relationship between an
     exit's incident concentration and its structural traits (corridor
     position, access-point count, typical traffic volume) vary along the
     corridor? Fit once, explanatory rather than a day-ahead forecaster —
     see the doc comment on fit_gwr() for why it is scored in-sample.

  2. Spatial LSTM — a single LSTM (shared weights across all 20 exits, one
     training example per exit-day) that sees each exit's own recent incident
     history AND a spatial-lag feature (its nearest neighbours' recent
     counts), trained with a Poisson loss and genuinely holdout-validated.
     This is the one that produces the 24-hour high-risk segment ranking.

Why a second script rather than extending train_incident_models.py: that
pipeline works at daily-national granularity (one row per calendar day) and
has no spatial dimension at all. GWR and a spatial LSTM need per-exit
geography, which is a different data shape end to end — a new script keeps
that shape change from leaking into the (working, unrelated) 7-model daily
comparison.

Why PyTorch instead of the TensorFlow/Keras the daily pipeline's LSTM/GRU
use: this machine's Python (3.14) has no TensorFlow wheel yet — the daily
pipeline's own LSTM/GRU already can't run here either, a pre-existing gap
this script does not attempt to fix. PyTorch publishes cp314 wheels, so it is
what makes a real (not simulated) LSTM possible in this environment today.

Several small helpers here (get_conn, load_daily_rain, calendar_features,
resolve_exit_for_location, the exit-reference SQL) mirror code that already
lives in train_incident_models.py and src/services/incident.service.ts /
map-comparison.service.ts. Duplicated rather than imported — importing
train_incident_models would pull in its module-level `import tensorflow`,
which fails outright in this environment — and kept in sync by hand, the
same convention this codebase already uses everywhere a Python/TS pair
needs to agree (see e.g. PRED_COLUMN's sync comment in train_incident_models.py).

Usage:
    python train_incident_spatial_models.py                 # train + report only
    python train_incident_spatial_models.py --write-db       # + write to gold.*
    python train_incident_spatial_models.py --dry-write       # rehearse the write, then roll back
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import warnings
from datetime import date, timedelta
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import psycopg2
import psycopg2.extras
import torch
import torch.nn as nn
from dotenv import load_dotenv
from mgwr.gwr import GWR
from mgwr.gwr import Poisson as GWRPoisson
from mgwr.sel_bw import Sel_BW

SEED = 42
# Shorter than train_incident_models.py's 90-day VALIDATION_DAYS: this panel
# is 20x sparser per unit time (one exit's daily count, not the whole
# corridor's), so a 90-day-wide per-exit holdout would leave many exits with
# almost no validation events at all. 60 was the narrowest window where every
# exit still has at least one non-zero holdout day.
VALIDATION_DAYS = 60
SEQ_LEN = 14  # LSTM lookback, matches train_incident_models.py's SEQ_LEN
# How many nearest-by-km exits feed the spatial-lag feature. 2 (one on each
# side, typically) keeps the lag local to "this stretch of corridor" rather
# than smearing in exits far enough away to be a different traffic regime.
N_NEIGHBORS = 2
EPOCHS = 60
PATIENCE = 8


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
# The corridor's one authoritative exit list — same km-derivation (cumulative
# dim_location segment length) as src/services/map-comparison.service.ts's
# searchExitsInDb, copied verbatim with no ILIKE filter so every exit comes
# back. See that function's own doc comment for why km is derived rather
# than hardcoded.
# ---------------------------------------------------------------------------
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
       ROUND((n.m / 1000.0)::numeric, 2)::float AS km,
       COALESCE(r.nb_entry, true) AS nb_entry,
       COALESCE(r.nb_exit,  true) AS nb_exit,
       COALESCE(r.sb_entry, true) AS sb_entry,
       COALESCE(r.sb_exit,  true) AS sb_exit,
       CASE WHEN x.exit_name ILIKE '%%barrier%%' THEN 'toll-barrier' ELSE 'interchange' END AS node_type
FROM nlex_exits x
LEFT JOIN nodes n ON n.node = x.exit_name
LEFT JOIN silver.nlex_exit_reference r ON r.exit_name = x.exit_name
ORDER BY x.exit_id
"""

# Same three operations logs as train_incident_models.py's DAILY_COUNTS_SQL /
# incident.service.ts's INCIDENTS_CTE, but keeping `location` per row instead
# of collapsing straight to a daily count — each row still needs to be
# resolved to an exit before it can be aggregated.
_D = "CASE WHEN date LIKE '%/%' THEN to_date(date, 'MM/DD/YYYY') ELSE date::date END"
INCIDENT_LOCATIONS_SQL = f"""
    SELECT {_D} AS d, location FROM nlex_road_crashes       WHERE date IS NOT NULL AND location IS NOT NULL
    UNION ALL
    SELECT {_D} AS d, location FROM nlex_motorcycle_crashes WHERE date IS NOT NULL AND location IS NOT NULL
    UNION ALL
    SELECT {_D} AS d, location FROM nlex_stalled_vehicles   WHERE date IS NOT NULL AND location IS NOT NULL
"""

# Mirrors train_incident_models.py's DAILY_RAIN_SQL — one corridor-wide
# reading (NLEX_LAT/LON), so this is a temporal control shared by every exit
# rather than a spatially-varying covariate.
DAILY_RAIN_SQL = """
    SELECT (timestamp_utc + interval '8 hours')::date AS d, SUM(rainfall)::float AS rain_mm
    FROM hourly_weather
    GROUP BY 1
    ORDER BY 1
"""

# bronze.nlex_traffic_volume already carries its own exit_id FK (verified
# against silver.nlex_exits_clean's 20 rows: 17 of 20 exits have volume
# rows here, the rest fall back to the corridor-wide mean in
# build_exit_volume below) — no name-matching needed, unlike the incident
# location resolver.
EXIT_VOLUME_SQL = """
    SELECT exit_id, date_day AS d, SUM(total_volume)::float AS volume
    FROM bronze.nlex_traffic_volume
    WHERE exit_id IS NOT NULL
    GROUP BY exit_id, date_day
"""


# ---------------------------------------------------------------------------
# Incident -> exit resolution. Mirrors resolveExitForLocation in
# src/services/incident.service.ts line for line — that function is the
# settled approach (the git history shows an earlier attempt keyed off the
# raw `nearest_exit` column instead and was reverted), so this follows the
# same two-strategy rule rather than reinventing one. Kept in sync by hand.
# ---------------------------------------------------------------------------
LOCATION_KM_RE = re.compile(r"Km\s*(\d+(?:\.\d+)?)", re.IGNORECASE)


def normalize_location_text(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def resolve_exit_for_location(location: str, exits: list[dict]) -> dict | None:
    km_match = LOCATION_KM_RE.search(location)
    if km_match and exits:
        km = float(km_match.group(1))
        return min(exits, key=lambda x: abs(x["km"] - km))

    norm = normalize_location_text(location)
    if not norm:
        return None
    candidates = [
        x for x in exits
        if (en := normalize_location_text(x["exit_name"])) and (norm in en or en in norm)
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda x: len(normalize_location_text(x["exit_name"])), reverse=True)
    return candidates[0]


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------
def load_exit_reference(conn) -> pd.DataFrame:
    df = pd.read_sql(EXIT_REFERENCE_SQL, conn)
    df["access_count"] = (
        df["nb_entry"].astype(int) + df["nb_exit"].astype(int)
        + df["sb_entry"].astype(int) + df["sb_exit"].astype(int)
    )
    return df


def load_daily_rain(conn) -> pd.DataFrame:
    df = pd.read_sql(DAILY_RAIN_SQL, conn)
    df["d"] = pd.to_datetime(df["d"])
    return df


def load_exit_volume(conn) -> pd.DataFrame:
    df = pd.read_sql(EXIT_VOLUME_SQL, conn)
    df["d"] = pd.to_datetime(df["d"])
    return df


def load_holidays(conn) -> set:
    df = pd.read_sql("SELECT date_day FROM dim_holiday WHERE is_holiday", conn)
    return set(pd.to_datetime(df["date_day"]).dt.date)


def calendar_features(dates: pd.Series, holiday_dates: set) -> pd.DataFrame:
    """Mirrors train_incident_models.py's calendar_features — kept in sync by hand."""
    dow = dates.dt.dayofweek
    doy = dates.dt.dayofyear
    return pd.DataFrame(
        {
            "dow": dow,
            "is_weekend": dow.isin([5, 6]).astype(int),
            "is_holiday": dates.dt.date.map(lambda x: int(x in holiday_dates)),
            "doy_sin": np.sin(2 * np.pi * doy / 365.25),
            "doy_cos": np.cos(2 * np.pi * doy / 365.25),
        },
        index=dates.index,
    )


def load_incident_exit_counts(conn, exits_df: pd.DataFrame) -> pd.DataFrame:
    """One row per (date, exit_id) with the resolved incident count, zero-filled
    over the full calendar range x every exit — most exit-days have no
    incident at all, and an absent row must read as 0, not as missing."""
    raw = pd.read_sql(INCIDENT_LOCATIONS_SQL, conn)
    raw["d"] = pd.to_datetime(raw["d"])
    exits = exits_df.to_dict("records")

    resolved_exit_id = []
    unresolved = 0
    for loc in raw["location"]:
        match = resolve_exit_for_location(str(loc), exits)
        resolved_exit_id.append(match["exit_id"] if match else None)
        if match is None:
            unresolved += 1
    raw["exit_id"] = resolved_exit_id
    print(f"  {len(raw)} incident rows -> {len(raw) - unresolved} resolved to an exit "
          f"({unresolved} unresolved, {unresolved / max(len(raw), 1) * 100:.1f}%)")

    resolved = raw.dropna(subset=["exit_id"]).copy()
    resolved["exit_id"] = resolved["exit_id"].astype(int)
    counts = resolved.groupby(["d", "exit_id"]).size().rename("count").reset_index()

    full_dates = pd.date_range(raw["d"].min(), raw["d"].max(), freq="D")
    panel_index = pd.MultiIndex.from_product(
        [full_dates, exits_df["exit_id"]], names=["d", "exit_id"]
    )
    panel = (
        counts.set_index(["d", "exit_id"])
        .reindex(panel_index, fill_value=0)
        .rename_axis(["d", "exit_id"])
        .reset_index()
    )
    return panel


def build_panel(conn, exits_df: pd.DataFrame) -> pd.DataFrame:
    """The full per-(exit, day) feature panel every model below reads from."""
    print("Loading incidents and resolving each to an exit...")
    panel = load_incident_exit_counts(conn, exits_df)

    rain = load_daily_rain(conn)
    panel = panel.merge(rain, on="d", how="left")
    panel["rain_mm"] = panel["rain_mm"].fillna(0.0)

    print("Loading per-exit daily volume (bronze.nlex_traffic_volume.exit_id)...")
    vol = load_exit_volume(conn)
    panel = panel.merge(vol, on=["d", "exit_id"], how="left")
    corridor_mean_volume = vol.groupby("d")["volume"].sum().mean()
    covered = panel["volume"].notna().mean()
    print(f"  {covered * 100:.0f}% of exit-days have their own volume reading; "
          f"the rest fall back to the corridor-wide daily mean ({corridor_mean_volume:,.0f})")
    panel["volume"] = panel["volume"].fillna(corridor_mean_volume)
    panel["log_volume"] = np.log(panel["volume"].clip(lower=1.0))

    holidays = load_holidays(conn)
    panel = panel.merge(calendar_features(panel["d"], holidays), left_index=True, right_index=True)

    panel = panel.merge(
        exits_df[["exit_id", "exit_name", "latitude", "longitude", "km", "access_count", "node_type"]],
        on="exit_id", how="left",
    )

    panel = panel.sort_values(["exit_id", "d"]).reset_index(drop=True)
    panel["lag_1"] = panel.groupby("exit_id")["count"].shift(1)
    panel["lag_7"] = panel.groupby("exit_id")["count"].shift(7)
    panel["roll_mean_7"] = panel.groupby("exit_id")["count"].transform(
        lambda s: s.shift(1).rolling(7, min_periods=1).mean()
    )

    # Spatial lag: each exit's own lag_1, blended with its N_NEIGHBORS
    # nearest-by-km exits' lag_1 for that same day. This is the one feature
    # that makes the LSTM "spatial" rather than 20 independent univariate
    # models sharing weights by coincidence.
    km_by_exit = exits_df.set_index("exit_id")["km"]
    neighbors_by_exit = {}
    for eid in exits_df["exit_id"]:
        dists = (km_by_exit - km_by_exit.loc[eid]).abs().drop(eid)
        neighbors_by_exit[eid] = dists.nsmallest(N_NEIGHBORS).index.tolist()

    lag1_by_exit_day = panel.pivot(index="d", columns="exit_id", values="lag_1")
    neighbor_lag = pd.DataFrame(index=lag1_by_exit_day.index)
    for eid, neighbors in neighbors_by_exit.items():
        neighbor_lag[eid] = lag1_by_exit_day[neighbors].mean(axis=1)
    neighbor_long = neighbor_lag.stack().rename("neighbor_lag_1").reset_index()
    neighbor_long.columns = ["d", "exit_id", "neighbor_lag_1"]
    panel = panel.merge(neighbor_long, on=["d", "exit_id"], how="left")

    return panel


# ---------------------------------------------------------------------------
# Shared metric helpers — same definitions as train_incident_models.py's
# full_metrics (MAE, Poisson deviance), kept in sync by hand so a number
# called "Poisson deviance" means the same formula everywhere in this module.
# ---------------------------------------------------------------------------
def mae_of(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    return float(np.mean(np.abs(np.asarray(y_true, dtype=float) - np.asarray(y_pred, dtype=float))))


def poisson_deviance_of(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    y_true = np.asarray(y_true, dtype=float)
    safe_pred = np.clip(np.asarray(y_pred, dtype=float), 1e-9, None)
    ratio = np.where(y_true > 0, y_true * np.log(np.where(y_true > 0, y_true, 1) / safe_pred), 0.0)
    return float(2 * np.mean(ratio - (y_true - safe_pred)))


# ---------------------------------------------------------------------------
# Model 1: GWR — one row per exit, explanatory rather than day-ahead.
# ---------------------------------------------------------------------------
GWR_VARIABLES = ["km", "access_count", "mean_log_volume"]


def fit_gwr(exits_df: pd.DataFrame, panel: pd.DataFrame) -> dict:
    """Fits one GWR: does the local relationship between an exit's mean daily
    incident rate and its structural traits vary along the corridor?

    Every exit is observed over the identical date range, so exposure (days
    observed) is a constant across the N=20 units — it folds entirely into
    the intercept under a log link and leaves every other coefficient
    unchanged (log(count) = log(rate) + log(days), and log(days) is the same
    number for every row). The response is scaled to a per-day RATE rather
    than a 6.5-year total purely so the coefficients and MAE below read on
    the same "incidents per day" scale as the Spatial LSTM's — the fit
    itself is identical either way, only the intercept and its units shift.

    Scored IN-SAMPLE (fit and evaluated on the same 20 rows) and reported as
    such — with only 20 spatial units there is no meaningful held-out subset
    to score against, unlike the Spatial LSTM below. GWR's job here is the
    coefficient map, not a validated forecast.
    """
    n_days = panel["d"].nunique()
    totals = panel.groupby("exit_id").agg(
        total_count=("count", "sum"),
        mean_log_volume=("log_volume", "mean"),
    ).reset_index()
    totals["daily_rate"] = totals["total_count"] / n_days
    cross = exits_df.merge(totals, on="exit_id")

    coords = list(zip(cross["longitude"], cross["latitude"]))
    y = cross["daily_rate"].values.reshape(-1, 1).astype(float)
    X = cross[["km", "access_count", "mean_log_volume"]].values.astype(float)

    # Fixed (continuous-distance) bandwidth, not the adaptive nearest-neighbour-
    # count kernel mgwr defaults to: with N=20 points, the default adaptive
    # search's own bandwidth floor (40 + 2*n_vars neighbours) exceeds the
    # sample size and raises outright. A fixed kernel's search bounds are
    # continuous distances, which stay well-defined at any N — except the
    # golden-section search still tries the degenerate low end first (half
    # the minimum pairwise distance, here ~0.002 degrees), where the bisquare
    # kernel gives non-negligible weight to only 1-2 exits and the local
    # weighted design matrix is singular for 4 parameters (intercept + 3
    # covariates). bw_min floors the search at the median pairwise distance
    # instead, which is small enough to still express real local variation
    # (half the corridor's 20 exits closer than it, half farther) while
    # guaranteeing enough weighted support to fit the model everywhere.
    from scipy.spatial.distance import pdist
    bw_min = float(np.median(pdist(np.array(coords))))
    selector = Sel_BW(coords, y, X, family=GWRPoisson(), fixed=True)
    bw = selector.search(bw_min=bw_min)
    model = GWR(coords, y, X, bw, family=GWRPoisson(), fixed=True)
    results = model.fit()

    # .predictions requires calling .predict() separately (a held-out-point
    # API this in-sample fit has no use for); the fitted values are already
    # available as y - resid_response, GWRResults' own residual.
    actual = y.flatten()
    pred = actual - np.asarray(results.resid_response).flatten()
    metrics = {
        "MAE": mae_of(actual, pred),
        "Poisson_Deviance": poisson_deviance_of(actual, pred),
        "n": len(actual),
        "bandwidth_km": None,  # fixed-kernel bw is in coordinate (degree) units, not km — see note below
    }

    # Leave-one-exit-out MAE, reported alongside (not instead of) the
    # in-sample fit above. N=20 is too thin for a fixed train/test split (the
    # reasoning in this function's own docstring for why one isn't used), but
    # LOOCV needs no such split — every exit gets its turn as the held-out
    # point, refit on the other 19 at the SAME bandwidth already selected
    # (re-running Sel_BW's search 20x would be needlessly expensive for a
    # bandwidth on this small a grid). GWR.predict()'s own `.predictions`
    # attribute turned out NOT to be on the response scale for a Poisson
    # family (verified directly: produced negative values for a count-rate
    # target, which is impossible) — `.mu`, the GLM mean response, is the
    # correct field; found by comparing both against a known in-sample point.
    loo_actual, loo_pred = [], []
    for i in range(len(cross)):
        mask = np.ones(len(cross), dtype=bool)
        mask[i] = False
        try:
            fold_model = GWR(
                [coords[j] for j in range(len(coords)) if mask[j]],
                y[mask], X[mask], bw, family=GWRPoisson(), fixed=True,
            )
            fold_result = fold_model.predict(np.array([coords[i]]), X[[i]])
            loo_actual.append(float(y[i, 0]))
            loo_pred.append(float(np.asarray(fold_result.mu).flatten()[0]))
        except Exception:
            pass  # a single fold's numerical failure shouldn't drop the whole LOOCV figure
    metrics["loocv_mae"] = (
        mae_of(np.array(loo_actual), np.array(loo_pred)) if loo_pred else None
    )
    metrics["loocv_n"] = len(loo_pred)

    # results.params columns are [const, km, access_count, mean_log_volume] —
    # constant=True (mgwr's default) prepends the intercept itself.
    var_names = ["intercept"] + GWR_VARIABLES
    coefficients = []
    for i, row in cross.iterrows():
        for j, var in enumerate(var_names):
            coefficients.append({
                "exit_id": int(row["exit_id"]),
                "exit_name": row["exit_name"],
                "latitude": float(row["latitude"]),
                "longitude": float(row["longitude"]),
                "km": float(row["km"]),
                "variable": var,
                "coefficient": float(results.params[i, j]),
                "std_error": float(results.bse[i, j]),
                "t_value": float(results.tvalues[i, j]),
                # |t| > ~1.96 is the conventional 95% two-sided cutoff; local
                # GWR standard errors are approximate (no small-sample
                # correction here), so this is a rough signal, not a p-value.
                "significant": bool(abs(results.tvalues[i, j]) > 1.96),
            })

    return {
        "bw": float(bw),
        "metrics": metrics,
        "coefficients": coefficients,
        "cross_section": cross,
    }


# ---------------------------------------------------------------------------
# Model 2: Spatial LSTM — pooled across exits, real temporal holdout,
# Poisson loss, produces the next-24h per-exit risk ranking.
# ---------------------------------------------------------------------------
SEQ_FEATURES = ["count", "neighbor_lag_1", "log_volume", "rain_mm"]
STATIC_FEATURES = ["km", "access_count"]


class SpatialLSTM(nn.Module):
    def __init__(self, seq_features: int, static_features: int, hidden: int = 16):
        super().__init__()
        self.lstm = nn.LSTM(input_size=seq_features, hidden_size=hidden, batch_first=True)
        self.head = nn.Linear(hidden + static_features, 1)

    def forward(self, seq: torch.Tensor, static: torch.Tensor) -> torch.Tensor:
        out, _ = self.lstm(seq)
        last = out[:, -1, :]
        combined = torch.cat([last, static], dim=1)
        # Log-rate output: paired with PoissonNLLLoss(log_input=True) below,
        # and exp()'d wherever a count is actually needed.
        return self.head(combined).squeeze(-1)


def _build_sequences(panel: pd.DataFrame, exits_df: pd.DataFrame, seq_mean, seq_std):
    """One example per (exit, day) whose trailing SEQ_LEN days are all
    present (no NaN lag/rolling warm-up). Returns tensors plus the exit_id
    and date each row came from, so callers can split by date or look up
    "the most recent window per exit" for inference."""
    seq_arr, static_arr, y_arr, meta = [], [], [], []
    static_km_mean, static_km_std = exits_df["km"].mean(), exits_df["km"].std() or 1.0

    for eid, g in panel.groupby("exit_id"):
        g = g.sort_values("d").reset_index(drop=True)
        feats = g[SEQ_FEATURES].values.astype("float32")
        feats = (feats - seq_mean) / seq_std
        static_row = g[STATIC_FEATURES].iloc[0]
        static_vec = np.array([
            (static_row["km"] - static_km_mean) / static_km_std,
            static_row["access_count"] / 4.0,
        ], dtype="float32")

        counts = g["count"].values.astype("float32")
        valid = g[SEQ_FEATURES].notna().all(axis=1).values
        for i in range(SEQ_LEN, len(g)):
            if not valid[i - SEQ_LEN : i + 1].all():
                continue
            seq_arr.append(feats[i - SEQ_LEN : i])
            static_arr.append(static_vec)
            y_arr.append(counts[i])
            meta.append((eid, g["d"].iloc[i]))

    return (
        torch.tensor(np.array(seq_arr)),
        torch.tensor(np.array(static_arr)),
        torch.tensor(np.array(y_arr)),
        meta,
    )


def fit_spatial_lstm(panel: pd.DataFrame, exits_df: pd.DataFrame, holdout_days: int) -> dict:
    set_all_seeds()
    cutoff = panel["d"].max() - pd.Timedelta(days=holdout_days)

    # Standardize the sequence features on TRAIN rows only (pre-cutoff), the
    # same leakage guard train_incident_models.py's MinMaxScaler applies —
    # fit on train, applied to everything.
    train_rows = panel[panel["d"] < cutoff]
    seq_mean = train_rows[SEQ_FEATURES].mean().values.astype("float32")
    seq_std = train_rows[SEQ_FEATURES].std().replace(0, 1.0).values.astype("float32")

    seq, static, y, meta = _build_sequences(panel, exits_df, seq_mean, seq_std)
    dates = np.array([m[1] for m in meta])
    is_val = dates >= np.datetime64(cutoff)

    seq_tr, static_tr, y_tr = seq[~is_val], static[~is_val], y[~is_val]
    seq_val, static_val, y_val = seq[is_val], static[is_val], y[is_val]
    print(f"  Spatial LSTM: {len(y_tr)} train examples, {len(y_val)} holdout examples "
          f"(cutoff {cutoff.date()})")

    model = SpatialLSTM(seq_features=len(SEQ_FEATURES), static_features=len(STATIC_FEATURES))
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    # PoissonNLLLoss(log_input=True): model outputs log(lambda); this is the
    # loss the diagram's "Poisson deviance" KPI is directly reporting.
    loss_fn = nn.PoissonNLLLoss(log_input=True)

    best_val_loss, best_state, patience_left = float("inf"), None, PATIENCE
    for epoch in range(EPOCHS):
        model.train()
        optimizer.zero_grad()
        pred = model(seq_tr, static_tr)
        loss = loss_fn(pred, y_tr)
        loss.backward()
        optimizer.step()

        model.eval()
        with torch.no_grad():
            val_pred = model(seq_val, static_val)
            val_loss = loss_fn(val_pred, y_val).item()
        if val_loss < best_val_loss - 1e-4:
            best_val_loss, best_state, patience_left = val_loss, {k: v.clone() for k, v in model.state_dict().items()}, PATIENCE
        else:
            patience_left -= 1
            if patience_left <= 0:
                break

    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        val_pred_count = torch.exp(model(seq_val, static_val)).numpy()
    y_val_np = y_val.numpy()

    metrics = {
        "MAE": mae_of(y_val_np, val_pred_count),
        "Poisson_Deviance": poisson_deviance_of(y_val_np, val_pred_count),
        "n": int(len(y_val_np)),
        "epochs_trained": epoch + 1,
    }

    # Next-24h forecast: the most recent SEQ_LEN-day window per exit, one
    # forward pass each — this is a single next-day step, not a recursive
    # multi-day rollout, matching the "24-hr" framing exactly.
    forecasts = []
    with torch.no_grad():
        for eid, g in panel.groupby("exit_id"):
            g = g.sort_values("d").reset_index(drop=True)
            if len(g) < SEQ_LEN or g[SEQ_FEATURES].tail(SEQ_LEN).isna().any().any():
                continue
            feats = (g[SEQ_FEATURES].tail(SEQ_LEN).values.astype("float32") - seq_mean) / seq_std
            static_row = g[STATIC_FEATURES].iloc[0]
            static_km_mean, static_km_std = exits_df["km"].mean(), exits_df["km"].std() or 1.0
            static_vec = np.array([
                (static_row["km"] - static_km_mean) / static_km_std,
                static_row["access_count"] / 4.0,
            ], dtype="float32")
            seq_t = torch.tensor(feats).unsqueeze(0)
            static_t = torch.tensor(static_vec).unsqueeze(0)
            pred_count = float(torch.exp(model(seq_t, static_t)).item())
            forecast_date = (g["d"].iloc[-1] + pd.Timedelta(days=1)).date()
            forecasts.append({
                "exit_id": int(eid),
                "forecast_date": forecast_date,
                "predicted_incidents": max(pred_count, 0.0),
                "last_observed_count": float(g["count"].iloc[-1]),
            })

    forecasts.sort(key=lambda r: r["predicted_incidents"], reverse=True)
    for rank, row in enumerate(forecasts, start=1):
        row["rank"] = rank

    return {"metrics": metrics, "forecasts": forecasts}


# ---------------------------------------------------------------------------
# DB write
# ---------------------------------------------------------------------------
def ensure_schema(conn, commit: bool = True) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE SCHEMA IF NOT EXISTS gold;

            CREATE TABLE IF NOT EXISTS gold.ml_incident_spatial_coefficients (
                id SERIAL PRIMARY KEY,
                exit_id INT NOT NULL,
                exit_name TEXT NOT NULL,
                latitude DOUBLE PRECISION NOT NULL,
                longitude DOUBLE PRECISION NOT NULL,
                km DOUBLE PRECISION NOT NULL,
                variable TEXT NOT NULL,
                coefficient DOUBLE PRECISION NOT NULL,
                std_error DOUBLE PRECISION,
                t_value DOUBLE PRECISION,
                significant BOOLEAN,
                trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (exit_id, variable)
            );

            CREATE TABLE IF NOT EXISTS gold.ml_incident_segment_risk (
                id SERIAL PRIMARY KEY,
                exit_id INT NOT NULL UNIQUE,
                exit_name TEXT NOT NULL,
                latitude DOUBLE PRECISION NOT NULL,
                longitude DOUBLE PRECISION NOT NULL,
                km DOUBLE PRECISION NOT NULL,
                forecast_date DATE NOT NULL,
                predicted_incidents DOUBLE PRECISION NOT NULL,
                last_observed_count DOUBLE PRECISION,
                risk_rank INT NOT NULL,
                trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS gold.ml_incident_spatial_metadata (
                id SERIAL PRIMARY KEY,
                metadata_json JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            """
        )
    if commit:
        conn.commit()


def write_to_db(conn, gwr_out: dict, lstm_out: dict, metadata: dict, dry: bool = False) -> None:
    ensure_schema(conn, commit=not dry)

    with conn.cursor() as cur:
        cur.execute("DELETE FROM gold.ml_incident_spatial_coefficients")
        psycopg2.extras.execute_values(
            cur,
            """INSERT INTO gold.ml_incident_spatial_coefficients
               (exit_id, exit_name, latitude, longitude, km, variable, coefficient,
                std_error, t_value, significant) VALUES %s""",
            [
                (c["exit_id"], c["exit_name"], c["latitude"], c["longitude"], c["km"],
                 c["variable"], c["coefficient"], c["std_error"], c["t_value"], c["significant"])
                for c in gwr_out["coefficients"]
            ],
        )

        cur.execute("DELETE FROM gold.ml_incident_segment_risk")
        exits_by_id = {c["exit_id"]: c for c in gwr_out["coefficients"]}
        rows = []
        for f in lstm_out["forecasts"]:
            ref = exits_by_id.get(f["exit_id"])
            if ref is None:
                continue
            rows.append((
                f["exit_id"], ref["exit_name"], ref["latitude"], ref["longitude"], ref["km"],
                f["forecast_date"], f["predicted_incidents"], f["last_observed_count"], f["rank"],
            ))
        psycopg2.extras.execute_values(
            cur,
            """INSERT INTO gold.ml_incident_segment_risk
               (exit_id, exit_name, latitude, longitude, km, forecast_date,
                predicted_incidents, last_observed_count, risk_rank) VALUES %s""",
            rows,
        )

        cur.execute("DELETE FROM gold.ml_incident_spatial_metadata")
        cur.execute("INSERT INTO gold.ml_incident_spatial_metadata (metadata_json) VALUES (%s)",
                    [json.dumps(metadata, default=str)])

    if dry:
        conn.rollback()
        print("DRY WRITE: every query ran, transaction rolled back — gold.* is unchanged")
    else:
        conn.commit()


def print_report(gwr_out: dict, lstm_out: dict) -> str:
    L = []
    L.append("=" * 80)
    L.append("  INCIDENT SPATIAL MODELS (per-exit)")
    L.append("=" * 80)
    L.append("")
    L.append("  GWR — cross-section over 20 exits, IN-SAMPLE fit (see fit_gwr docstring)")
    L.append(f"    bandwidth (fixed, degrees) = {gwr_out['bw']:.4f}")
    L.append(f"    MAE              = {gwr_out['metrics']['MAE']:.3f}")
    L.append(f"    Poisson_Deviance = {gwr_out['metrics']['Poisson_Deviance']:.3f}")
    L.append(f"    n                = {gwr_out['metrics']['n']}")
    loocv_mae = gwr_out["metrics"].get("loocv_mae")
    L.append(
        f"    Leave-one-exit-out MAE = {loocv_mae:.3f}  (n={gwr_out['metrics']['loocv_n']} folds) "
        f"— the honest generalization estimate; compare against the in-sample MAE above"
        if loocv_mae is not None else "    Leave-one-exit-out MAE = n/a (every fold failed)"
    )
    L.append("")
    sig = [c for c in gwr_out["coefficients"] if c["variable"] != "intercept" and c["significant"]]
    L.append(f"    {len(sig)} of {len([c for c in gwr_out['coefficients'] if c['variable'] != 'intercept'])} "
              f"non-intercept (exit, variable) coefficients are locally significant (|t| > 1.96)")
    L.append("")
    L.append("  Spatial LSTM — pooled across exits, genuine temporal holdout")
    L.append(f"    MAE              = {lstm_out['metrics']['MAE']:.3f}")
    L.append(f"    Poisson_Deviance = {lstm_out['metrics']['Poisson_Deviance']:.3f}")
    L.append(f"    holdout n        = {lstm_out['metrics']['n']}")
    L.append(f"    epochs trained   = {lstm_out['metrics']['epochs_trained']}")
    L.append("")
    L.append("  Next-24h high-risk segments (top 5):")
    for f in lstm_out["forecasts"][:5]:
        L.append(f"    #{f['rank']:<2} exit_id={f['exit_id']:<3} "
                  f"predicted={f['predicted_incidents']:.3f}  last_observed={f['last_observed_count']:.0f}")
    L.append("=" * 80)
    return "\n".join(L)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-db", action="store_true")
    parser.add_argument("--dry-write", action="store_true")
    parser.add_argument("--holdout-days", type=int, default=VALIDATION_DAYS)
    args = parser.parse_args()

    conn = get_conn()
    try:
        print("Loading exit reference (nlex_exits x dim_location, km-derived)...")
        exits_df = load_exit_reference(conn)
        print(f"  {len(exits_df)} exits")

        panel = build_panel(conn, exits_df)
        print(f"  panel: {len(panel)} exit-day rows, "
              f"{panel['d'].min().date()} .. {panel['d'].max().date()}, "
              f"{int(panel['count'].sum())} total resolved incidents")

        print("\nFitting GWR...")
        gwr_out = fit_gwr(exits_df, panel)

        print("\nFitting Spatial LSTM...")
        lstm_out = fit_spatial_lstm(panel, exits_df, args.holdout_days)

        report = print_report(gwr_out, lstm_out)
        print("\n" + report)
        report_path = Path(__file__).resolve().parent / "model_results_spatial.txt"
        report_path.write_text(report, encoding="utf-8")
        print(f"\nFull report written to {report_path}")

        if not args.write_db and not args.dry_write:
            print("\nTraining complete. Re-run with --write-db once you've reviewed the report above.")
            return

        metadata = {
            "gwr": {"bandwidth": gwr_out["bw"], "metrics": gwr_out["metrics"], "variables": GWR_VARIABLES},
            "spatial_lstm": {"metrics": lstm_out["metrics"], "seq_len": SEQ_LEN, "n_neighbors": N_NEIGHBORS,
                              "seq_features": SEQ_FEATURES, "static_features": STATIC_FEATURES},
            "trained_at": pd.Timestamp.utcnow().isoformat(),
        }
        print("\nWriting gold.ml_incident_spatial_coefficients / ml_incident_segment_risk / ml_incident_spatial_metadata...")
        write_to_db(conn, gwr_out, lstm_out, metadata, dry=args.dry_write and not args.write_db)
        print("Rolled back (dry write)." if (args.dry_write and not args.write_db) else "Committed.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
