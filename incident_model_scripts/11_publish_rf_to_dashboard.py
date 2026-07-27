"""
PUBLISH RANDOM FOREST INCIDENT FORECAST TO THE DASHBOARD
========================================================
Rebuilds the three tables the Predictive > Incident tab reads:

    ml_daily_actuals          d, total                     -> blue "Actual Incidents"
    ml_predictive_incidents   forecast_date, prediction_type,
                              predicted_incident_count,
                              champion_model               -> green predicted + forecast
    ml_training_metadata      metadata_json                -> model info cards + metrics

Source data: bronze.road_crashes + motorcycle_crashes + stalled_vehicles ONLY.
No weather, no traffic volume (matches the agreed incident-model scope).

Existing rows are backed up to _dashboard_backup_<timestamp>.json before deletion.

Run:  set PGURL=...  &&  python 11_publish_rf_to_dashboard.py
"""
import os
import re
import json
import warnings
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
import statsmodels.api as sm
import xgboost as xgb
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import r2_score

warnings.filterwarnings("ignore")

PGURL = os.environ["PGURL"]
HERE = os.path.dirname(os.path.abspath(__file__))

SEED = 42
WARMUP = 168
DISPLAY_DAYS = 180        # history shown on the dashboard chart
VALIDATION_DAYS = 60      # holdout window scored one-step-ahead (orange band)
FUTURE_DAYS = 30          # forecast horizon (green band)
# Start the forecast this far BEFORE the end of the data. The forecast then
# overlaps known actuals for that stretch, so the green line can be read against
# the blue one instead of hanging off the right edge as a 7-day sliver.
FORECAST_BACKOFF_DAYS = 22

# Panel A candidates this script knows how to build. Sequence models (LSTM/GRU)
# are evaluated in the report but are not deployable through this path yet: the
# recursive forecast below feeds scalars back as lags, which a sequence model
# cannot consume. If one of them wins, we fall back to the best buildable
# candidate and record that decision in the metadata.
BUILDABLE = {"XGBoost", "Random Forest", "Poisson GLM", "Negative Binomial GLM"}
RESULTS_JSON = os.path.join(HERE, "outputs", "models", "all_incident_models.json")

FEATURES = [
    "hour_sin", "hour_cos", "dow_sin", "dow_cos", "month_sin", "month_cos",
    "is_weekend", "is_rush_hour",
    "inc_lag_1h", "inc_lag_2h", "inc_lag_3h", "inc_lag_24h", "inc_lag_168h",
    "inc_roll_24h", "inc_roll_168h",
]
# human-readable names for the dashboard's feature-importance panel
PRETTY = {
    "hour_sin": "Hour of day (cyclical)", "hour_cos": "Hour of day (cyclical)",
    "dow_sin": "Day of week (cyclical)", "dow_cos": "Day of week (cyclical)",
    "month_sin": "Month (seasonal)", "month_cos": "Month (seasonal)",
    "is_weekend": "Weekend flag", "is_rush_hour": "Rush hour flag",
    "inc_lag_1h": "Incidents 1h ago", "inc_lag_2h": "Incidents 2h ago",
    "inc_lag_3h": "Incidents 3h ago", "inc_lag_24h": "Incidents 24h ago",
    "inc_lag_168h": "Incidents 1 week ago",
    "inc_roll_24h": "24h rolling average", "inc_roll_168h": "7-day rolling average",
}


# ----------------------------------------------------------------- extraction
def parse_km(loc):
    if not loc:
        return np.nan
    s = str(loc).strip()
    m = re.search(r"[Kk][Mm]\s*(\d+)\s*\+\s*(\d+)", s)
    if m:
        return float(m.group(1)) + float(m.group(2)) / 1000.0
    m = re.search(r"[Kk][Mm]\s*(\d+)", s)
    if m:
        return float(m.group(1))
    return {"balintawak toll plaza": 5.0, "bocaue barrier": 28.0,
            "cdv toll plaza": 29.0}.get(s.lower(), np.nan)


def parse_hour(t, ampm):
    if not t:
        return np.nan
    s = str(t).strip().upper()
    if ampm or "AM" in s or "PM" in s:
        m = re.match(r"(\d{1,2}):(\d{2})\s*(AM|PM)", s)
        if not m:
            return np.nan
        h = int(m.group(1)) % 12
        return h + 12 if m.group(3) == "PM" else h
    m = re.match(r"(\d{1,2}):(\d{2})", s)
    return int(m.group(1)) if m else np.nan


def load_incidents(conn):
    """The three bronze tables store dates/times in different formats."""
    specs = [("road_crashes", "%Y-%m-%d", False),
             ("motorcycle_crashes", "%m/%d/%Y", True),
             ("stalled_vehicles", "%Y-%m-%d", False)]
    frames = []
    for tbl, dfmt, ampm in specs:
        d = pd.read_sql(f"SELECT date, reported_time, location FROM bronze.{tbl}", conn)
        d["dt"] = pd.to_datetime(d["date"], format=dfmt, errors="coerce")
        d["hour_of_day"] = d["reported_time"].apply(lambda x: parse_hour(x, ampm))
        d["src"] = tbl
        frames.append(d[["dt", "hour_of_day", "location", "src"]])
        print(f"    bronze.{tbl:22s} {len(d):6d} rows")
    inc = pd.concat(frames, ignore_index=True).dropna(subset=["dt", "hour_of_day"])
    inc["hour_of_day"] = inc["hour_of_day"].astype(int)
    inc = inc[inc["hour_of_day"].between(0, 23)]
    inc["km_value"] = inc["location"].apply(parse_km)
    return inc


def build_panel(inc):
    lo, hi = inc["dt"].min(), inc["dt"].max()
    spine = pd.DataFrame({"dt": np.repeat(pd.date_range(lo, hi, freq="D"), 24)})
    spine["hour_of_day"] = np.tile(np.arange(24), len(spine) // 24)
    agg = inc.groupby(["dt", "hour_of_day"]).size().reset_index(name="incident_count")
    g = spine.merge(agg, on=["dt", "hour_of_day"], how="left")
    g["incident_count"] = g["incident_count"].fillna(0).astype(int)

    g["ts"] = g["dt"] + pd.to_timedelta(g["hour_of_day"], unit="h")
    g = g.sort_values("ts").reset_index(drop=True)
    dow, mth, h = g["dt"].dt.dayofweek, g["dt"].dt.month, g["hour_of_day"]
    g["hour_sin"], g["hour_cos"] = np.sin(2 * np.pi * h / 24), np.cos(2 * np.pi * h / 24)
    g["dow_sin"], g["dow_cos"] = np.sin(2 * np.pi * dow / 7), np.cos(2 * np.pi * dow / 7)
    g["month_sin"], g["month_cos"] = np.sin(2 * np.pi * mth / 12), np.cos(2 * np.pi * mth / 12)
    g["is_weekend"] = (dow >= 5).astype(int)
    g["is_rush_hour"] = h.isin([6, 7, 8, 9, 16, 17, 18, 19]).astype(int)

    s = g["incident_count"]
    for lag in (1, 2, 3, 24, 168):
        g[f"inc_lag_{lag}h"] = s.shift(lag).fillna(0)
    g["inc_roll_24h"] = s.shift(1).rolling(24, min_periods=1).mean().fillna(0)
    g["inc_roll_168h"] = s.shift(1).rolling(168, min_periods=1).mean().fillna(0)
    return g.iloc[WARMUP:].reset_index(drop=True)


def calendar_row(ts):
    h, dow, mth = ts.hour, ts.dayofweek, ts.month
    return {"hour_sin": np.sin(2 * np.pi * h / 24), "hour_cos": np.cos(2 * np.pi * h / 24),
            "dow_sin": np.sin(2 * np.pi * dow / 7), "dow_cos": np.cos(2 * np.pi * dow / 7),
            "month_sin": np.sin(2 * np.pi * mth / 12), "month_cos": np.cos(2 * np.pi * mth / 12),
            "is_weekend": 1.0 if dow >= 5 else 0.0,
            "is_rush_hour": 1.0 if h in (6, 7, 8, 9, 16, 17, 18, 19) else 0.0}


def recursive_forecast(model, history, start_ts, n_hours):
    buf = list(history[-336:])
    out = {}
    for i in range(n_hours):
        ts = start_ts + pd.Timedelta(hours=i)
        r = calendar_row(ts)
        r["inc_lag_1h"], r["inc_lag_2h"], r["inc_lag_3h"] = buf[-1], buf[-2], buf[-3]
        r["inc_lag_24h"], r["inc_lag_168h"] = buf[-24], buf[-168]
        r["inc_roll_24h"] = float(np.mean(buf[-24:]))
        r["inc_roll_168h"] = float(np.mean(buf[-168:]))
        p = float(max(model.predict(np.array([[r[f] for f in FEATURES]]))[0], 0.0))
        out[ts] = p
        buf.append(p)
    return pd.Series(out)


def poisson_dev(y, mu):
    y = np.asarray(y, float)
    mu = np.clip(np.asarray(mu, float), 1e-9, None)
    t = np.zeros_like(y)
    nz = y > 0
    t[nz] = y[nz] * np.log(y[nz] / mu[nz])
    return float(2 * np.mean(t - (y - mu)))


# ------------------------------------------------------- champion selection
def pick_champion():
    """
    Read the champion off the evaluation results instead of hardcoding it.

    Same rule as INCIDENT_MODEL_REPORT.txt: drop anything with MASE >= 1.0 (no
    better than the naive benchmark), then rank survivors by Poisson deviance.
    This is what stops the dashboard silently serving a model that has since been
    beaten - the previous version pinned CHAMPION = "Random Forest" in source, so
    a re-evaluation could never change what got deployed.
    """
    if not os.path.exists(RESULTS_JSON):
        raise SystemExit(f"{RESULTS_JSON} not found - run 13_train_incident_models.py "
                         f"then 14_spatial_models.py first.")
    with open(RESULTS_JSON) as fh:
        res = json.load(fh)

    panel_a = [v for v in res.values() if v.get("target") == "incident_count"]
    ranked = sorted(panel_a, key=lambda v: (v["metrics"]["MASE"] >= 1.0,
                                            v["metrics"]["Poisson_Deviance"]))
    if not ranked:
        raise SystemExit("No Panel A candidates found in the results file.")

    best, note = ranked[0], None
    if best["model"] not in BUILDABLE:
        fallback = next((v for v in ranked if v["model"] in BUILDABLE), None)
        if fallback is None:
            raise SystemExit(f"Champion {best['model']} is not deployable and no "
                             f"buildable candidate was found.")
        note = (f"{best['model']} ranked first but is a sequence model and cannot be "
                f"served through the recursive-forecast path; deploying "
                f"{fallback['model']} instead.")
        print(f"  !! {note}")
        best = fallback

    print("  Panel A ranking (Poisson deviance, MASE>=1.0 rejected):")
    for i, v in enumerate(ranked, 1):
        flag = "   <-- deploying" if v["model"] == best["model"] else ""
        print(f"     {i}. {v['model']:<24s} PoisDev={v['metrics']['Poisson_Deviance']:<9}"
              f" MASE={v['metrics']['MASE']}{flag}")
    return best["model"], best["metrics"], best["split_r2_diagnostic"], ranked, note


def build_model(name):
    """Construct a candidate by name, matching 13_train_incident_models.py."""
    if name == "XGBoost":
        return xgb.XGBRegressor(objective="count:poisson", n_estimators=400,
                                max_depth=5, learning_rate=0.05, subsample=0.8,
                                colsample_bytree=0.8, min_child_weight=5,
                                reg_lambda=1.0, random_state=SEED, n_jobs=-1)
    if name == "Random Forest":
        return RandomForestRegressor(n_estimators=300, max_depth=12,
                                     min_samples_leaf=20, random_state=SEED, n_jobs=-1)
    if name in ("Poisson GLM", "Negative Binomial GLM"):
        return _GLM(name)
    raise SystemExit(f"build_model: no builder for '{name}'")


class _GLM:
    """statsmodels GLM behind a fit/predict interface."""

    def __init__(self, name):
        self.name = name
        self.res = None

    def fit(self, X, y):
        Xc = sm.add_constant(X, has_constant="add")
        if self.name == "Negative Binomial GLM":
            pois = sm.GLM(y, Xc, family=sm.families.Poisson()).fit()
            mu = np.clip(pois.predict(Xc), 1e-6, None)
            alpha = float(np.mean(((y - mu) ** 2 - mu) / mu ** 2))
            fam = sm.families.NegativeBinomial(alpha=min(max(alpha, 1e-4), 10.0))
        else:
            fam = sm.families.Poisson()
        self.res = sm.GLM(y, Xc, family=fam).fit()
        return self

    def predict(self, X):
        return self.res.predict(sm.add_constant(X, has_constant="add"))

    @property
    def feature_importances_(self):
        c = np.abs(np.asarray(self.res.params, dtype=float))[1:]   # drop intercept
        return c / c.sum() if c.sum() > 0 else c


# ----------------------------------------------------------------------- main
def main():
    print("Selecting champion from the evaluation results ...")
    CHAMPION, OFF_M, OFF_S, RANKED, FALLBACK_NOTE = pick_champion()
    print(f"  champion -> {CHAMPION}")

    conn = psycopg2.connect(PGURL)
    print("Loading incidents from AWS (3 bronze tables) ...")
    inc = load_incidents(conn)
    print(f"    combined                {len(inc):6d} usable incidents")

    g = build_panel(inc)
    X, y = g[FEATURES].values.astype(float), g["incident_count"].values.astype(float)
    ts = pd.DatetimeIndex(g["ts"])
    hist_end = ts[-1]

    # forecast origin sits BEFORE the end of the data (see FORECAST_BACKOFF_DAYS)
    fc_start = (hist_end - pd.Timedelta(days=FORECAST_BACKOFF_DAYS)).normalize()
    val_start = fc_start - pd.Timedelta(days=VALIDATION_DAYS)
    cut = int(np.searchsorted(ts, val_start))        # end of training
    fc_i = int(np.searchsorted(ts, fc_start))        # end of validation / forecast origin
    print(f"    hourly panel            {len(g)} rows  {ts[0].date()} -> {hist_end.date()}")
    print(f"    forecast origin         {fc_start.date()} "
          f"(+{FUTURE_DAYS}d -> {(fc_start + pd.Timedelta(days=FUTURE_DAYS)).date()})")

    # ---- train on everything before the validation window ----
    print(f"Training {CHAMPION}: {cut} train hours / {fc_i - cut} validation hours ...")
    mdl = build_model(CHAMPION)
    mdl.fit(X[:cut], y[:cut])
    p_tr = np.clip(mdl.predict(X[:cut]), 0, None)
    p_va = np.clip(mdl.predict(X[cut:fc_i]), 0, None)

    # Local sanity numbers only. What gets PUBLISHED as the model's metrics are the
    # official walk-forward figures from the evaluation, not these - the dashboard
    # must agree with INCIDENT_MODEL_REPORT.txt.
    mae = float(np.mean(np.abs(y[cut:fc_i] - p_va)))
    pdev = poisson_dev(y[cut:fc_i], p_va)
    tr_r2, va_r2 = float(r2_score(y[:cut], p_tr)), float(r2_score(y[cut:fc_i], p_va))
    print(f"    local check: MAE={mae:.4f} PoisDev={pdev:.4f} "
          f"TrainR2={tr_r2:.4f} ValR2={va_r2:.4f}")

    # ---- refit on history up to the forecast origin, then forecast forward ----
    # Trained only on data before fc_start, so the overlap with known actuals is a
    # genuine out-of-sample forecast, not a fit.
    mdl_full = build_model(CHAMPION)
    mdl_full.fit(X[:fc_i], y[:fc_i])
    fut = recursive_forecast(mdl_full, y[:fc_i], fc_start, FUTURE_DAYS * 24)

    # ---- daily rollups (the dashboard chart is daily) ----
    d_act = pd.Series(y, index=ts).resample("D").sum()
    d_pred = pd.Series(np.concatenate([p_tr, p_va]), index=ts[:fc_i]).resample("D").sum()
    d_fut = fut.resample("D").sum()

    # Accuracy check against the actuals that exist past the forecast origin.
    # Measured here, then dropped from what is published: on the chart the blue
    # line must stop at the forecast boundary.
    overlap = d_fut.index.intersection(d_act.index)
    if len(overlap):
        err = float(np.mean(np.abs(d_fut[overlap].values - d_act[overlap].values)))
        print(f"    forecast vs actual overlap: {len(overlap)} days, daily MAE {err:.2f} "
              f"(checked, not published)")

    # actuals run to the forecast origin only, so PAST + PRESENT end where FUTURE begins
    window_start = (fc_start - pd.Timedelta(days=DISPLAY_DAYS)).normalize()
    d_act = d_act[(d_act.index >= window_start) & (d_act.index < fc_start)]
    d_pred_val = d_pred[(d_pred.index >= val_start.normalize())
                        & (d_pred.index < fc_start)]

    print(f"    daily actuals  {len(d_act)} days, mean {d_act.mean():.1f}/day")
    print(f"    validation     {len(d_pred_val)} days, mean {d_pred_val.mean():.1f}/day")
    print(f"    future         {len(d_fut)} days, mean {d_fut.mean():.1f}/day, "
          f"7-day total {d_fut.sum():.0f}")

    # ---- back up what is there now, then replace ----
    cur = conn.cursor()
    backup = {}
    for t in ["ml_daily_actuals", "ml_predictive_incidents", "ml_training_metadata"]:
        cur.execute(f"SELECT * FROM {t}")
        cols = [c[0] for c in cur.description]
        backup[t] = [dict(zip(cols, r)) for r in cur.fetchall()]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    bpath = os.path.join(HERE, f"_dashboard_backup_{stamp}.json")
    with open(bpath, "w") as fh:
        json.dump(backup, fh, indent=2, default=str)
    print(f"Backed up {sum(len(v) for v in backup.values())} existing rows -> "
          f"{os.path.basename(bpath)}")

    # ---- ml_daily_actuals ----
    cur.execute("DELETE FROM ml_daily_actuals")
    execute_values(cur, "INSERT INTO ml_daily_actuals (d, total) VALUES %s",
                   [(d.date(), float(v)) for d, v in d_act.items()])

    # ---- ml_predictive_incidents ----
    cur.execute("DELETE FROM ml_predictive_incidents")
    rows = [(d.strftime("%Y-%m-%d"), "validation", float(v), CHAMPION)
            for d, v in d_pred_val.items()]
    rows += [(d.strftime("%Y-%m-%d"), "future", float(v), CHAMPION)
             for d, v in d_fut.items()]
    execute_values(cur, """INSERT INTO ml_predictive_incidents
                   (forecast_date, prediction_type, predicted_incident_count,
                    champion_model) VALUES %s""", rows)

    # ---- ml_training_metadata ----
    imp = {}
    for f, v in zip(FEATURES, mdl.feature_importances_):
        imp[PRETTY[f]] = imp.get(PRETTY[f], 0.0) + float(v)   # merge sin/cos pairs
    imp = dict(sorted(imp.items(), key=lambda kv: -kv[1]))

    # Published metrics are the OFFICIAL 3-fold walk-forward figures from the
    # evaluation, so the dashboard cards agree with INCIDENT_MODEL_REPORT.txt.
    # The local holdout above is only a sanity check and is not published.
    metadata = {
        "champion_model": CHAMPION,
        "metrics": {"MAE": OFF_M["MAE"], "Poisson_Deviance": OFF_M["Poisson_Deviance"],
                    "RMSE": OFF_M["RMSE"], "MASE": OFF_M["MASE"],
                    "R2": OFF_M["R2"],
                    "Train_R2": OFF_S["Train_R2"], "Val_R2": OFF_S["Val_R2"],
                    "Gap": OFF_S["Gap"]},
        "metrics_source": "3-fold expanding-window walk-forward "
                          "(all_incident_models.json)",
        "selection_rule": "reject MASE >= 1.0, then rank by Poisson deviance",
        "candidate_ranking": [
            {"rank": i, "model": v["model"],
             "Poisson_Deviance": v["metrics"]["Poisson_Deviance"],
             "MASE": v["metrics"]["MASE"]}
            for i, v in enumerate(RANKED, 1)],
        "deployment_note": FALLBACK_NOTE,
        "training_timestamp": datetime.now(timezone.utc).isoformat(),
        "training_period": f"{ts[0].date()} to {ts[cut].date()}",
        "validation_period": f"{ts[cut].date()} to {fc_start.date()}",
        "training_samples": int(cut),
        "validation_samples": int(fc_i - cut),
        "forecast_origin": str(fc_start.date()),
        "forecast_horizon_days": FUTURE_DAYS,
        "feature_importance": imp,
        # taken from the actual evaluation, not a hand-written list
        "models_evaluated": [v["model"] for v in RANKED],
        "data_sources": ["bronze.road_crashes", "bronze.motorcycle_crashes",
                         "bronze.stalled_vehicles"],
        "excludes_weather": True,
        "target_variable": "incident_count",
    }
    cur.execute("DELETE FROM ml_training_metadata")
    cur.execute("INSERT INTO ml_training_metadata (metadata_json, created_at) "
                "VALUES (%s, NOW())", (json.dumps(metadata),))

    conn.commit()
    print(f"\nPublished: {len(d_act)} actual days, {len(rows)} prediction rows, "
          f"1 metadata record.")

    # ---- verify what the API will now read ----
    cur.execute("SELECT MIN(total), MAX(total), AVG(total) FROM ml_daily_actuals")
    print("  ml_daily_actuals  min/max/avg = %.1f / %.1f / %.1f" % cur.fetchone())
    cur.execute("""SELECT prediction_type, COUNT(*), AVG(predicted_incident_count)
                   FROM ml_predictive_incidents GROUP BY 1 ORDER BY 1""")
    for r in cur.fetchall():
        print(f"  ml_predictive_incidents  {r[0]:<11s} n={r[1]:<4d} avg={r[2]:.1f}")
    conn.close()


if __name__ == "__main__":
    main()
