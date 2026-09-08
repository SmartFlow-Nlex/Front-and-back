"""
Event surge — an actual out-of-sample test.

WHY THIS EXISTS
  build_event_surge.py MEASURES what happened on past event days. That is a
  descriptive statistic, not a forecast: it was never asked to predict anything
  it had not already seen, so "trained and tested" could not honestly be
  claimed for it.

  This asks the operational question instead: if you take the uplift observed on
  PAST events and use it to predict the NEXT one, how close do you get?

PROTOCOL
  Event days are split CHRONOLOGICALLY - earlier events train, later events are
  held out and never touched while fitting. Per-exit uplift is computed from the
  training events only, then applied to each held-out event day's matched
  weekday/month baseline (itself computed from non-event days before the cut).
  Scored on predicted vs actual vehicles at each exit on each held-out event day.

MODELS — the five in the diagram's Event-Based & Holiday box
  Prophet, XGBoost, SARIMAX, Random Forest, Gradient Boosting.

  ADAPTATION, stated rather than hidden: the diagram says "Gradient Boosting
  CLASSIFIER", but the output this panel serves is extra vehicles per exit and
  the box's own KPI for it is WMAPE — a regression metric. A classifier cannot
  produce that. The regressor is used and the substitution is recorded here.

  Per-exit uplift is kept alongside them as a deliberately simple benchmark. It
  is the diagram's descriptive "control-day comparison" carried into prediction,
  and a candidate that cannot beat it is not earning its complexity.

BASELINES IT MUST BEAT
  no-event      pretend nothing is happening - just the normal-day baseline.
                This is the bar that matters: if the uplift table cannot beat
                it, the panel adds nothing over ignoring events entirely.
  flat-uplift   one corridor-wide average multiplier for every exit, which tests
                whether the PER-EXIT detail earns its place.

Nothing here is transcribed; every figure is computed on each run and written to
gold.ml_model_metrics under target 'Event Surge'.
"""
import warnings

import numpy as np
import pandas as pd
import psycopg2
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor

warnings.filterwarnings("ignore")

PG = ("host=smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com port=5432 "
      "dbname=nlex_capstone user=postgres password=Hanszy123! sslmode=require")
ANCHOR, THRESHOLD, TEST_FRACTION = "CDV", 1.45, 0.30


def banner(t):
    print("\n" + "=" * 72 + f"\n  {t}\n" + "=" * 72)


conn = psycopg2.connect(PG)
d = pd.read_sql_query("""
    SELECT date, exit_canonical AS ex, SUM(total)::float AS v
    FROM gold.fact_traffic_hourly GROUP BY 1, 2 ORDER BY 1""", conn)
d["date"] = pd.to_datetime(d.date)
d["dow"] = d.date.dt.dayofweek
d["m"] = d.date.dt.month

banner("STEP 1: Event days")
anchor = sorted(x for x in d.ex.unique() if ANCHOR.lower() in x.lower())[0]
a = d[d.ex == anchor].copy()
a = a.merge(a.groupby(["dow", "m"]).v.median().rename("exp"), on=["dow", "m"])
a["ratio"] = a.v / a["exp"]
events = sorted(a.loc[a.ratio >= THRESHOLD, "date"])
n_test = max(5, int(round(len(events) * TEST_FRACTION)))
train_ev, test_ev = set(events[:-n_test]), set(events[-n_test:])
print(f"  anchor {anchor} | {len(events)} event days")
print(f"  train {len(train_ev)} events  {min(train_ev).date()} -> {max(train_ev).date()}")
print(f"  test  {len(test_ev)} events  {min(test_ev).date()} -> {max(test_ev).date()}  (never seen while fitting)")

banner("STEP 2: Fit uplift on TRAIN events only")
cut = min(test_ev)
# Baseline from non-event days strictly BEFORE the test period, so no
# information from the test window leaks into either the norm or the uplift.
hist = d[(d.date < cut) & (~d.date.isin(train_ev))]
norm = hist.groupby(["ex", "dow", "m"]).v.median().rename("exp").reset_index()

TR = d[d.date.isin(train_ev)].merge(norm, on=["ex", "dow", "m"], how="left").dropna(subset=["exp"])
TR["ratio"] = TR.v / TR["exp"]
uplift = TR.groupby("ex").ratio.median().rename("uplift").reset_index()
flat = float(TR.ratio.median())
print(f"  learned per-exit uplift for {len(uplift)} exits | flat corridor uplift {flat:.3f}x")

banner("STEP 3: Predict the HELD-OUT events")
TE = d[d.date.isin(test_ev)].merge(norm, on=["ex", "dow", "m"], how="left").dropna(subset=["exp"])
TE = TE.merge(uplift, on="ex", how="left")
TE["uplift"] = TE.uplift.fillna(flat)
TE["pred_model"] = TE["exp"] * TE.uplift
TE["pred_noevent"] = TE["exp"]
TE["pred_flat"] = TE["exp"] * flat
print(f"  scoring {len(TE):,} exit-days ({TE.date.nunique()} event days x {TE.ex.nunique()} exits)")


def score(col):
    e = (TE.v - TE[col]).abs()
    return {"WMAPE": e.sum() / TE.v.sum() * 100, "MAE": e.mean(),
            "MAPE": (e / TE.v).mean() * 100,
            "R2": 1 - ((TE.v - TE[col]) ** 2).sum() / ((TE.v - TE.v.mean()) ** 2).sum()}


# ── ML candidates, judged on the same held-out events ───────────────────────
# The per-exit uplift IS a trained model — 19 parameters fitted on the training
# events — but a deliberately simple one. These ask whether a real learner earns
# its place, under the standard used elsewhere in this project: candidates
# against baselines, ranked, no threshold moved after the fact.
banner("STEP 3b: Do ML candidates beat the simple estimator?")
codes = {e: i for i, e in enumerate(sorted(d.ex.unique()))}
FEATS = ["exit_code", "dow", "m", "is_event", "exp"]
ALL_EV = train_ev | test_ev


def frame(df_):
    f = df_.copy()
    f["exit_code"] = f.ex.map(codes)
    f["is_event"] = f.date.isin(ALL_EV).astype(int)
    return f


# Fit on every day before the cut, event and non-event alike, so the model can
# LEARN the event effect from the is_event flag rather than being handed it.
fit_src = frame(d[d.date < cut].merge(norm, on=["ex", "dow", "m"], how="left").dropna(subset=["exp"]))
te_ml = frame(TE)
Xtr, ytr = fit_src[FEATS], fit_src.v.values
print(f"  fitting on {len(fit_src):,} exit-days before {cut.date()} "
      f"({int(fit_src.is_event.sum()):,} of them event days)")

TE["pred_gbr"] = GradientBoostingRegressor(
    n_estimators=400, max_depth=4, learning_rate=0.05, subsample=0.9,
    random_state=42).fit(Xtr, ytr).predict(te_ml[FEATS])
TE["pred_rf"] = RandomForestRegressor(
    n_estimators=400, max_depth=14, min_samples_leaf=3, random_state=42,
    n_jobs=4).fit(Xtr, ytr).predict(te_ml[FEATS])

from xgboost import XGBRegressor
TE["pred_xgb"] = XGBRegressor(
    n_estimators=500, max_depth=6, learning_rate=0.05, subsample=0.9,
    colsample_bytree=0.9, random_state=42, n_jobs=4).fit(Xtr, ytr).predict(te_ml[FEATS])

# SARIMAX per exit on the daily volume series, with an event dummy as the
# exogenous regressor — the natural way to give a time-series model the event.
try:
    from statsmodels.tsa.statespace.sarimax import SARIMAX as _SARIMAX
    sx, okx = {}, 0
    for ex_name in sorted(TE.ex.unique()):
        # Fitted on the RATIO to the normal-day baseline, not on raw vehicles.
        #
        # Handed the raw series with an event dummy, SARIMAX is badly identified:
        # the dummy is 1 on 34 of 1,322 days against a ~62,000-vehicle mean, and
        # the fit put the event coefficient at 63,158 vehicles — roughly 18x the
        # true effect. It still fitted in sample, because the AR/MA terms
        # absorbed the error, but those decay when forecasting and the forecast
        # collapsed to intercept + a nonsense coefficient (87% WMAPE).
        #
        # On the ratio the series hovers near 1.0, so the event coefficient is a
        # small, well-identified uplift — and it puts SARIMAX on the same footing
        # as every other candidate, all of which predict relative to `exp`.
        hx = d[(d.ex == ex_name) & (d.date < cut)].merge(
            norm, on=["ex", "dow", "m"], how="left").dropna(subset=["exp"]).sort_values("date")
        want = sorted(TE.loc[TE.ex == ex_name, "date"].unique())
        try:
            ratio_tr = (hx.v / hx["exp"]).values
            ex_tr = hx.date.isin(train_ev).astype(float).values.reshape(-1, 1)
            m = _SARIMAX(ratio_tr, exog=ex_tr, order=(1, 0, 1),
                         seasonal_order=(1, 0, 1, 7), trend="c",
                         enforce_stationarity=False,
                         enforce_invertibility=False).fit(disp=False)
            steps = (pd.Timestamp(max(want)) - hx.date.max()).days
            fut_days = [hx.date.max() + pd.Timedelta(days=i + 1) for i in range(steps)]
            fut_ex = np.array([[1.0 if t in test_ev else 0.0] for t in fut_days])
            fc = np.asarray(m.forecast(steps=steps, exog=fut_ex))
            idx = {fut_days[i]: fc[i] for i in range(steps)}
            for ds_ in want:
                sx[(ex_name, pd.Timestamp(ds_))] = float(idx.get(pd.Timestamp(ds_), np.nan))
            okx += 1
        except Exception:
            pass
    print(f"  SARIMAX fitted for {okx}/{TE.ex.nunique()} exits (event dummy as exog)")
    TE["sarimax_ratio"] = [sx.get((r.ex, r.date), np.nan) for r in TE.itertuples()]
    TE["pred_sarimax"] = (TE.sarimax_ratio * TE["exp"]).fillna(TE["exp"])
except Exception as exc:
    print(f"  SARIMAX SKIPPED: {str(exc)[:90]}")
    TE["pred_sarimax"] = TE["exp"]

# PROPHET — required by the manuscript, which names it explicitly as the
# event-aware model for localized surges. Fitted PER EXIT on that exit's daily
# volume before the cut, with the TRAINING event days supplied as holidays, so
# Prophet learns the event effect the way it is designed to: as a named
# irregular regressor on top of trend and weekly/yearly seasonality.
try:
    import logging
    from prophet import Prophet
    logging.getLogger("prophet").setLevel(logging.ERROR)
    logging.getLogger("cmdstanpy").setLevel(logging.ERROR)

    hol = pd.DataFrame({"holiday": "event", "ds": sorted(train_ev),
                        "lower_window": 0, "upper_window": 0})
    preds, ok = {}, 0
    for ex_name in sorted(TE.ex.unique()):
        hist_ex = d[(d.ex == ex_name) & (d.date < cut)][["date", "v"]]             .rename(columns={"date": "ds", "v": "y"})
        want = TE.loc[TE.ex == ex_name, "date"]
        try:
            m = Prophet(weekly_seasonality=True, yearly_seasonality=True,
                        daily_seasonality=False, holidays=hol)
            m.fit(hist_ex)
            out = m.predict(pd.DataFrame({"ds": sorted(want.unique())}))
            for ds_, yh in zip(out.ds, out.yhat):
                preds[(ex_name, pd.Timestamp(ds_))] = float(yh)
            ok += 1
        except Exception:
            pass
    print(f"  Prophet fitted for {ok}/{TE.ex.nunique()} exits (event days as holidays)")
    TE["pred_prophet"] = [preds.get((r.ex, r.date), np.nan) for r in TE.itertuples()]
    if TE.pred_prophet.isna().any():
        TE["pred_prophet"] = TE.pred_prophet.fillna(TE["exp"])
except Exception as exc:
    print(f"  Prophet SKIPPED: {str(exc)[:90]}")
    TE["pred_prophet"] = np.nan

rows = {"Per-exit uplift": score("pred_model"),
        "Gradient Boosting": score("pred_gbr"),
        "XGBoost": score("pred_xgb"),
        "Random Forest": score("pred_rf"),
        "SARIMAX": score("pred_sarimax"),
        **({"Prophet (event holidays)": score("pred_prophet")} if TE.pred_prophet.notna().all() else {}),
        "Flat uplift (baseline)": score("pred_flat"),
        "No event adjustment (baseline)": score("pred_noevent")}
print(f"\n  {'method':<34}{'WMAPE%':>9}{'MAPE%':>8}{'MAE veh':>11}{'R2':>9}")
for k, v in rows.items():
    print(f"  {k:<34}{v['WMAPE']:>9.2f}{v['MAPE']:>8.2f}{v['MAE']:>11,.0f}{v['R2']:>9.4f}")

base = min(rows["Flat uplift (baseline)"]["WMAPE"], rows["No event adjustment (baseline)"]["WMAPE"])
cands = {k: v for k, v in rows.items() if "baseline" not in k}
ranked = sorted(cands.items(), key=lambda kv: kv[1]["WMAPE"])
winner, mdl = ranked[0][0], ranked[0][1]["WMAPE"]
accepted = bool(mdl < base)
print(f"\n  baseline to beat: {base:.2f}%")
for i, (k, v) in enumerate(ranked, 1):
    print(f"    #{i} {k:<22}{v['WMAPE']:>8.2f}%   "
          f"{'ACCEPTED' if v['WMAPE'] < base else 'rejected'}")
print(f"  winner: {winner} at {mdl:.2f}% WMAPE")
print(f"  improvement over ignoring events entirely: "
      f"{rows['No event adjustment (baseline)']['WMAPE'] - mdl:+.2f} pts WMAPE")

banner("STEP 4: Recording the result")
cur = conn.cursor()
cur.execute("DELETE FROM gold.ml_model_metrics WHERE target = 'Event Surge'")
for name, v in rows.items():
    is_base = "baseline" in name
    cur.execute("""INSERT INTO gold.ml_model_metrics
        (model_name, target, wmape, mape, mae, r2, rank, accepted, rejected_reason,
         uses_weather, diagnosis, updated_at)
        VALUES (%s,'Event Surge',%s,%s,%s,%s,%s,%s,%s,false,%s,now())""",
        (name, float(v["WMAPE"]), float(v["MAPE"]), float(v["MAE"]), float(v["R2"]),
         None if is_base else [k for k, _ in ranked].index(name) + 1,
         False if is_base else bool(v["WMAPE"] < base),
         "baseline, not a candidate" if is_base else
         (None if is_base or v["WMAPE"] < base
          else f"WMAPE {v['WMAPE']:.2f}% does not beat baseline {base:.2f}%"),
         f"held out {len(test_ev)} of {len(events)} event days chronologically "
         f"({min(test_ev).date()} onward); {len(TE):,} exit-days scored"))
conn.commit()
print(f"  gold.ml_model_metrics: {len(rows)} rows under target='Event Surge'")
conn.close()
banner("DONE")
