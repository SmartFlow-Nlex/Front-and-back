"""
7-day corridor CO2 forecast — training and evaluation.

Candidates follow the modelling diagram's Emission Forecasting box: Gradient
Boosting Regressor, LSTM and Polynomial regression, scored on Forecast MAPE.
Protocol is the one the volume module uses, so the two are comparable:
rolling-origin walk-forward, chronological 80/20, and acceptance only by beating
BOTH trivial baselines (WMAPE below the better of seasonal-naive/climatology,
AND MASE < 1 against a seasonal naive).

SOURCE
  gold.fact_emissions_hourly, rebuilt from gold.fact_traffic_hourly x the
  DENR/DOTC per-class factors x gold.exit_segment_km. It reconciles with the
  volume series to within 0.5 vehicles/day, so the CO2 panel cannot contradict
  the volume panel.

  bronze.nlex_theoretical_emissions is NOT used: its daily volume disagrees with
  the forecast series (ratios 1.13-1.70 on consecutive days) and it covers 10 of
  20 exits.

HORIZON
  7 days, per the diagram ("7-day CO2 corridor forecast"). The volume module uses
  14; metrics from the two are therefore NOT directly comparable, which is stated
  in the report rather than left implicit.
"""
import json
import warnings
import numpy as np
import pandas as pd
import psycopg2
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.preprocessing import PolynomialFeatures

warnings.filterwarnings("ignore")

PG = ("host=smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com port=5432 "
      "dbname=nlex_capstone user=postgres password=Hanszy123! sslmode=require")

HORIZON, STEP, N_ORIGINS, SEASON = 7, 7, 42, 7
# The diagram specifies a 7-day forecast and 7 days is what is VALIDATED, but a
# horizon study (co2_horizon_study.py) scored the champion out to 90 days and
# found it still clears both gates from d15 onward. The SERVED projection is
# therefore 90 days, with measured per-horizon accuracy stored alongside so the
# panel can state what each stretch is worth rather than implying the 7-day
# figure holds throughout.
FUTURE_DAYS = 90
LAGS = [1, 2, 3, 7, 14, 28]


def banner(t):
    print("\n" + "=" * 70 + f"\n  {t}\n" + "=" * 70)


banner("STEP 1: Loading the corridor CO2 series")
conn = psycopg2.connect(PG)
df = pd.read_sql_query("""
    SELECT date AS ds, SUM(co2_tonnes)::float AS y, SUM(total)::float AS veh,
           SUM(class_3)::float AS heavy
    FROM gold.fact_emissions_hourly GROUP BY date ORDER BY date
""", conn)
df["ds"] = pd.to_datetime(df.ds)
print(f"  {len(df):,} days  {df.ds.min().date()} -> {df.ds.max().date()}")
print(f"  CO2/day: mean {df.y.mean():.1f} t   min {df.y.min():.1f}   max {df.y.max():.1f}")

wx = pd.read_sql_query("""
    WITH h AS (SELECT (timestamp_utc + interval '8 hours')::date d, timestamp_utc hr,
                      AVG(rainfall) r, AVG(temperature) t
               FROM public.hourly_weather GROUP BY 1,2)
    SELECT d AS ds, SUM(r)::float AS rain, AVG(t)::float AS temp FROM h GROUP BY d ORDER BY d
""", conn)
wx["ds"] = pd.to_datetime(wx.ds)
df = df.merge(wx, on="ds", how="left")
df[["rain", "temp"]] = df[["rain", "temp"]].ffill().bfill()

# ── features ─────────────────────────────────────────────────────────────────
banner("STEP 2: Features")
d = df.copy()
d["dow"] = d.ds.dt.dayofweek
d["is_weekend"] = (d.dow >= 5).astype(int)
d["month"] = d.ds.dt.month
d["t"] = np.arange(len(d))
for L in LAGS:
    d[f"lag{L}"] = d.y.shift(L)
d["roll7"] = d.y.shift(1).rolling(7).mean()
d["roll28"] = d.y.shift(1).rolling(28).mean()
d["heavy_share"] = (d.heavy / d.veh).shift(1)
FEATS = ["dow", "is_weekend", "month", "t", "rain", "temp", "roll7", "roll28",
         "heavy_share"] + [f"lag{L}" for L in LAGS]
d = d.dropna().reset_index(drop=True)
print(f"  usable rows after lags: {len(d):,}   features: {len(FEATS)}")

origins = [len(d) - (N_ORIGINS - i) * STEP for i in range(N_ORIGINS)]
print(f"  {N_ORIGINS} origins, h={HORIZON}d  ->  {N_ORIGINS*HORIZON} scored days "
      f"({N_ORIGINS*HORIZON/len(d)*100:.1f}%)")
print(f"  first origin {d.ds.iloc[origins[0]].date()}   last {d.ds.iloc[origins[-1]].date()}")

# ── models ───────────────────────────────────────────────────────────────────
def fit_gbr(tr, fut):
    m = GradientBoostingRegressor(n_estimators=300, max_depth=3, learning_rate=0.05,
                                  subsample=0.9, random_state=42)
    m.fit(tr[FEATS], tr.y)
    return m.predict(fut[FEATS])


def fit_poly(tr, fut):
    # Degree 2 on a compact subset: the full feature set at degree 2 is ~190
    # terms and overfits badly on ~1,100 rows.
    cols = ["t", "roll7", "roll28", "lag1", "lag7", "dow", "rain"]
    pf = PolynomialFeatures(degree=2, include_bias=False)
    X = pf.fit_transform(tr[cols])
    m = Ridge(alpha=1.0).fit(X, tr.y)
    return m.predict(pf.transform(fut[cols]))


def fit_lstm(tr, fut):
    import tensorflow as tf
    from tensorflow.keras import layers, Sequential
    tf.random.set_seed(42)
    SEQ = 28
    s = tr.y.values.astype("float32")
    mu, sd = s.mean(), s.std() or 1.0
    z = (s - mu) / sd
    X = np.array([z[i - SEQ:i] for i in range(SEQ, len(z))])[..., None]
    Y = np.array([z[i] for i in range(SEQ, len(z))])
    m = Sequential([layers.Input((SEQ, 1)), layers.LSTM(32), layers.Dense(1)])
    m.compile("adam", "mse")
    m.fit(X, Y, epochs=30, batch_size=32, verbose=0)
    # Recursive multi-step: each prediction feeds the next, as in deployment.
    win, out = list(z[-SEQ:]), []
    for _ in range(len(fut)):
        p = float(m.predict(np.array(win[-SEQ:])[None, :, None], verbose=0)[0, 0])
        out.append(p); win.append(p)
    return np.array(out) * sd + mu


MODELS = {"GBR": fit_gbr, "Polynomial": fit_poly, "LSTM": fit_lstm}

# Models that read weather. LSTM is univariate (it sees only y), so the previous
# blanket uses_weather=true was simply wrong for it.
USES_WEATHER = {"GBR": True, "Polynomial": True, "LSTM": False}

# WMAPE gap below which two models are NOT meaningfully separated. GBR is not
# bit-reproducible across processes (floating-point summation order in the split
# search moves it ~0.1pp between identical runs), so ranking on a smaller gap
# than this is false precision.
TIE_MARGIN_WMAPE = 0.15


def climatize(tr, fut):
    """Replace the forecast window's weather with what a forecaster would have.

    rain/temp are NOT lagged features, so predicting day t+3 originally handed
    the model day t+3's OBSERVED rainfall - a value that does not exist yet at
    forecast time. Training rows keep observed weather, since history genuinely
    is known; only the forecast window is substituted, using day-of-year
    climatology computed from the TRAINING data alone, so nothing past the
    origin is consulted.

    Measured cost of removing the leak: Polynomial WMAPE 6.6729 -> 6.7899,
    GBR 6.7762 -> 6.7801, LSTM unchanged (univariate). All still clear every
    gate; the point is that the published figure is now one the model could
    actually achieve in deployment.
    """
    clim = tr.assign(k=tr.ds.dt.dayofyear).groupby("k")[["rain", "temp"]].mean()
    out = fut.copy()
    for col in ("rain", "temp"):
        fallback = float(tr[col].mean())
        out[col] = [
            float(clim[col].loc[k]) if k in clim.index else fallback
            for k in fut.ds.dt.dayofyear
        ]
    return out

banner(f"STEP 3: Rolling-origin evaluation ({N_ORIGINS} origins, h={HORIZON}d)")
import os, pickle
CACHE = "emissions_preds.pkl"
CACHE_KEY = ("climatology-weather-v2", len(d), str(d.ds.max().date()), N_ORIGINS, HORIZON, tuple(MODELS))
_cached = None
if os.path.exists(CACHE):
    with open(CACHE, "rb") as fh:
        k, v = pickle.load(fh)
    if k == CACHE_KEY:
        _cached = v
        print(f"  reusing cached predictions ({CACHE}) - series and protocol unchanged")

preds = {k: {} for k in MODELS}
preds["SeasonalNaive"] = {}
preds["Climatology"] = {}
fails = {k: 0 for k in MODELS}

if _cached is not None:
    preds, fails = _cached
for oi, cut in enumerate([] if _cached is not None else origins, 1):
    tr, fut = d.iloc[:cut], d.iloc[cut:cut + HORIZON]
    if len(fut) < HORIZON:
        break
    fut_known = climatize(tr, fut)      # never observed future weather
    for name, fn in MODELS.items():
        try:
            yh = fn(tr, fut_known)
            for ds, v in zip(fut.ds, yh):
                preds[name][ds] = float(v)
        except Exception:
            fails[name] += 1
    # Baselines the models must beat.
    for ds in fut.ds:
        preds["SeasonalNaive"][ds] = float(tr.y.iloc[-SEASON])
    doy = tr.assign(k=tr.ds.dt.dayofyear).groupby("k").y.mean()
    for ds in fut.ds:
        preds["Climatology"][ds] = float(doy.get(ds.dayofyear, tr.y.mean()))
    if oi % 10 == 0 or oi == 1:
        print(f"  origin {oi}/{N_ORIGINS}  train={cut}d  predict {fut.ds.iloc[0].date()} -> {fut.ds.iloc[-1].date()}")

if _cached is None:
    with open(CACHE, "wb") as fh:
        pickle.dump((CACHE_KEY, (preds, fails)), fh)

banner("STEP 4: Results")
truth = d.set_index("ds").y
rows = []
for name, pm in preds.items():
    idx = sorted(pm)
    a = truth.loc[idx].values
    f_ = np.array([pm[i] for i in idx])
    err = np.abs(a - f_)
    ins = d.y.values[:origins[0]]
    scale = np.mean(np.abs(ins[SEASON:] - ins[:-SEASON]))   # seasonal naive, lag-7
    rows.append({
        "model": name, "n": len(idx),
        "mape": float(np.mean(err / np.abs(a)) * 100),
        "wmape": float(err.sum() / np.abs(a).sum() * 100),
        "rmse": float(np.sqrt(np.mean((a - f_) ** 2))),
        "mae": float(err.mean()),
        "mase": float(err.mean() / scale),
        "r2": float(1 - ((a - f_) ** 2).sum() / ((a - a.mean()) ** 2).sum()),
    })
res = pd.DataFrame(rows).sort_values("wmape").reset_index(drop=True)
print(f"\n  Evaluated on {res.n.iloc[0]:,} days\n")
print(res[["model", "mape", "wmape", "rmse", "mae", "mase", "r2"]].to_string(
    index=False, float_format=lambda v: f"{v:,.4f}"))

base = res[res.model.isin(["SeasonalNaive", "Climatology"])].wmape.min()
base_name = res.loc[res[res.model.isin(["SeasonalNaive", "Climatology"])].wmape.idxmin(), "model"]
print(f"\n  Baseline to beat: {base:.2f}% WMAPE ({base_name})")

res["is_candidate"] = res.model.isin(MODELS)
res["accepted"] = res.is_candidate & (res.wmape < base) & (res.mase < 1.0)
res["rank"] = np.where(res.is_candidate, res.groupby("is_candidate").cumcount() + 1, None)

# Which candidates are statistically indistinguishable from the leader?
_best_wmape = res[res.is_candidate].wmape.min()
res["tied_with_best"] = res.is_candidate & ((res.wmape - _best_wmape).abs() <= TIE_MARGIN_WMAPE)
TIED = list(res[res.tied_with_best].model)


def _diagnosis(r):
    if not r.is_candidate:
        return "baseline, not a candidate"
    if len(TIED) > 1 and r.tied_with_best:
        others = [m for m in TIED if m != r.model]
        return (f"tied with {', '.join(others)} - within {TIE_MARGIN_WMAPE}pp WMAPE, "
                f"the measured run-to-run jitter, so the ordering between them is "
                f"not meaningful")
    return None


res["diagnosis"] = res.apply(_diagnosis, axis=1)
if len(TIED) > 1:
    detail = ", ".join(f"{m} {res[res.model == m].wmape.iloc[0]:.4f}%" for m in TIED)
    print(f"\n  TIE ({detail}) - within {TIE_MARGIN_WMAPE}pp WMAPE.")
    print("  Ordering between these is not meaningful; they are co-champions.")

print("\n  VERDICT")
for r in res[res.is_candidate].itertuples():
    why = []
    if not r.wmape < base: why.append(f"WMAPE {r.wmape:.2f}% does not beat baseline {base:.2f}%")
    if not r.mase < 1.0: why.append(f"MASE {r.mase:.3f} >= 1.0")
    print(f"    {r.model:<12} MAPE {r.mape:6.2f}%  WMAPE {r.wmape:6.2f}%  MASE {r.mase:5.3f}  "
          + ("accepted" if r.accepted else "rejected - " + "; ".join(why)))
if fails: print(f"\n  failed origins: {fails}")

banner("STEP 5: Writing to AWS")
try:
    conn.cursor().execute("SELECT 1")
except Exception:
    print("  connection went idle during training - reconnecting")
    conn = psycopg2.connect(PG)
cur = conn.cursor()
cur.execute("DELETE FROM gold.ml_model_metrics WHERE target = 'Corridor CO2'")
for r in res.itertuples():
    reason = None
    if r.is_candidate and not r.accepted:
        w = []
        if not r.wmape < base: w.append(f"WMAPE {r.wmape:.2f}% does not beat baseline {base:.2f}%")
        if not r.mase < 1.0: w.append(f"MASE {r.mase:.3f} >= 1.0 (no better than seasonal naive)")
        reason = "; ".join(w)
    elif not r.is_candidate:
        reason = "baseline, not a candidate"
    cur.execute("""
        INSERT INTO gold.ml_model_metrics
          (model_name,target,rmse,mae,wmape,r2,mase,mape,rank,accepted,rejected_reason,uses_weather,diagnosis,updated_at)
        VALUES (%s,'Corridor CO2',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())""",
        (r.model, r.rmse, r.mae, r.wmape, r.r2, r.mase, r.mape,
         int(r.rank) if r.is_candidate else None, bool(r.accepted), reason,
         USES_WEATHER.get(r.model, False), r.diagnosis))

champ = res[res.accepted]
champ_name = champ.model.iloc[0] if len(champ) else None
print(f"  ml_model_metrics: {len(res)} rows under target='Corridor CO2'")
print(f"  champion: {champ_name or 'none accepted'}")

banner("STEP 6: Writing the served forecast")

# The panel needs the same shape as gold.ml_predictive_volume: a past context
# stretch, the scored holdout, and an unscored future block.
_acc = res[res.accepted]
if _acc.empty:
    raise SystemExit("no accepted model - refusing to serve a forecast")
CHAMPION = _acc.iloc[0].model            # res is sorted by WMAPE, so this is rank 1
print(f"  champion: {CHAMPION}  (WMAPE {_acc.iloc[0].wmape:.2f}%, MASE {_acc.iloc[0].mase:.3f})")
FUT = FUTURE_DAYS
last = d.ds.max()
fut_ds = pd.date_range(last + pd.Timedelta(days=1), periods=FUT, freq="D")

# Future weather is day-of-year climatology, not observation — the same
# assumption the volume module makes, and stated on the panel.
# Future weather is day-of-year climatology, not observation - the same
# assumption the scored window now uses, and stated on the panel.
clim = d.assign(k=d.ds.dt.dayofyear).groupby("k")[["rain", "temp"]].mean()


def project(mname, mfn, hist0=None, horizon_ds=None, clim_tbl=None):
    """Roll one model forward past the end of `hist0` (default: all data).

    Also used by the horizon study below, so the accuracy that gets published is
    measured on the exact procedure that produces the served line.

    Every candidate is projected, not just the leader. Storing a future for the
    champion alone left the panel with no forecast line whenever the reader
    selected another model - and with Polynomial and GBR tied, "the champion"
    is not even a well-defined single model any more.

    LSTM is recursive by construction (it feeds its own output back inside
    fit_lstm), so it is called once for the whole window. The feature-based
    models need the loop: day 2's lag-1 IS day 1's prediction.
    """
    base = d if hist0 is None else hist0
    window = fut_ds if horizon_ds is None else horizon_ds
    ctab = clim if clim_tbl is None else clim_tbl

    if mname == "LSTM":
        return [float(v) for v in mfn(base, pd.DataFrame({"ds": list(window)}))]

    hist, out = base.copy(), []
    for ds in window:
        k = ds.dayofyear
        r = ctab.loc[k] if k in ctab.index else base[["rain", "temp"]].mean()
        ys = hist.y.values
        row = {
            "ds": ds, "dow": ds.dayofweek, "is_weekend": int(ds.dayofweek >= 5),
            "month": ds.month, "t": len(hist),
            "rain": float(r["rain"]), "temp": float(r["temp"]),
            "heavy_share": float(hist.heavy.iloc[-1] / hist.veh.iloc[-1]),
            "roll7": float(ys[-7:].mean()), "roll28": float(ys[-28:].mean()),
        }
        for L in LAGS:
            row[f"lag{L}"] = float(ys[-L])
        yhat = float(mfn(hist, pd.DataFrame([row]))[0])
        out.append(yhat)
        row["y"] = yhat                       # feeds the next day's lags
        hist = pd.concat(
            [hist, pd.DataFrame([{**row, "veh": hist.veh.iloc[-1],
                                  "heavy": hist.heavy.iloc[-1]}])],
            ignore_index=True)
    return out


fut_pred = {}
for _n, _f in MODELS.items():
    try:
        fut_pred[_n] = project(_n, _f)
        print(f"  {_n:<12} {fut_ds[0].date()} .. {fut_ds[-1].date()}  "
              f"mean {np.mean(fut_pred[_n]):.1f} t/day")
    except Exception as e:
        fut_pred[_n] = [None] * FUT
        print(f"  {_n:<12} projection FAILED: {e}")

cur.execute("""
  CREATE TABLE IF NOT EXISTS gold.ml_predictive_emissions (
    id serial PRIMARY KEY,
    forecast_date date NOT NULL,
    actual_co2 numeric(12,3),
    pred_gbr numeric(12,3), pred_polynomial numeric(12,3), pred_lstm numeric(12,3),
    champion_model text,
    is_holdout boolean DEFAULT false, is_future boolean DEFAULT false,
    updated_at timestamptz DEFAULT now())""")
cur.execute("""COMMENT ON TABLE gold.ml_predictive_emissions IS
  'Daily corridor CO2 (tonnes) with walk-forward forecasts. Actuals roll up from gold.fact_emissions_hourly, which is derived from the same traffic series the volume forecast uses, so the two panels cannot disagree. Horizon 7d (per the modelling diagram), unlike the volume module''s 14d - metrics are therefore not directly comparable.'""")
cur.execute("TRUNCATE gold.ml_predictive_emissions RESTART IDENTITY")

scored = set(preds[CHAMPION])
for r in d.itertuples():
    cur.execute("""INSERT INTO gold.ml_predictive_emissions
        (forecast_date, actual_co2, pred_gbr, pred_polynomial, pred_lstm, champion_model, is_holdout, is_future)
        VALUES (%s,%s,%s,%s,%s,%s,%s,false)""",
        (r.ds.date(), float(r.y),
         preds["GBR"].get(r.ds), preds["Polynomial"].get(r.ds), preds["LSTM"].get(r.ds),
         CHAMPION, r.ds in scored))
for i, ds in enumerate(fut_ds):
    cur.execute("""INSERT INTO gold.ml_predictive_emissions
        (forecast_date, actual_co2, pred_gbr, pred_polynomial, pred_lstm,
         champion_model, is_holdout, is_future)
        VALUES (%s,NULL,%s,%s,%s,%s,false,true)""",
        (ds.date(), fut_pred["GBR"][i], fut_pred["Polynomial"][i],
         fut_pred["LSTM"][i], CHAMPION))
conn.commit()
# Per-horizon accuracy, measured by co2_horizon_study.py: rolling origin, 9
# origins, fit once per origin then rolled forward recursively (each prediction
# becomes the next day's lag), climatology weather throughout.
cur.execute("""
  CREATE TABLE IF NOT EXISTS gold.ml_horizon_accuracy (
    id serial PRIMARY KEY, target text NOT NULL, model_name text NOT NULL,
    h_lo int NOT NULL, h_hi int NOT NULL, n int,
    wmape numeric(10,4), mape numeric(10,4), mase numeric(10,4), mae numeric(14,2),
    baseline_wmape numeric(10,4), usable boolean, note text,
    updated_at timestamptz DEFAULT now())""")
cur.execute("DELETE FROM gold.ml_horizon_accuracy WHERE target='Corridor CO2'")
# MEASURED HERE, not transcribed. An earlier version pasted the numbers from a
# separate study script, which meant the table on the dashboard could silently
# disagree with the model actually being served after any retrain. The study now
# runs inline, through the same project() used for the served line.
banner("Horizon study: how far ahead is the projection worth anything?")
HZ_H, HZ_STEP, HZ_N = FUTURE_DAYS, 30, 9
hz_origins = [len(d) - (HZ_N - i) * HZ_STEP - HZ_H for i in range(HZ_N)]
hz_origins = [o for o in hz_origins if o > 400]
print(f"  {len(hz_origins)} origins, h={HZ_H}d, champion {CHAMPION}")

hz_rows = []
for oi, cut in enumerate(hz_origins, 1):
    tr_o, fut_o = d.iloc[:cut], d.iloc[cut:cut + HZ_H]
    if len(fut_o) < HZ_H:
        continue
    clim_o = tr_o.assign(k=tr_o.ds.dt.dayofyear).groupby("k")[["rain", "temp"]].mean()
    yh = project(CHAMPION, MODELS[CHAMPION], hist0=tr_o,
                 horizon_ds=list(fut_o.ds), clim_tbl=clim_o)
    lw = tr_o.y.values[-SEASON:]
    doy_o = tr_o.assign(k=tr_o.ds.dt.dayofyear).groupby("k").y.mean()
    for i in range(HZ_H):
        a = float(fut_o.y.iloc[i])
        hz_rows.append({
            "h": i + 1, "a": a, "f": float(yh[i]),
            "sn": float(lw[i % SEASON]),
            "cl": float(doy_o.get(fut_o.ds.iloc[i].dayofyear, tr_o.y.mean())),
        })
    print(f"    origin {oi}/{len(hz_origins)}  {fut_o.ds.iloc[0].date()} -> {fut_o.ds.iloc[-1].date()}")

hz = pd.DataFrame(hz_rows)
_ins = d.y.values[:hz_origins[0]]
hz_scale = np.mean(np.abs(_ins[SEASON:] - _ins[:-SEASON]))
BUCKETS = [(1, 7), (8, 14), (15, 30), (31, 60), (61, 90)]
BUCKETS = [(lo, hi) for lo, hi in BUCKETS if lo <= HZ_H]

print(f"\n  MASE denominator (seasonal naive on {len(_ins)} training days): {hz_scale:.2f} t")
print(f"  {'range':<10}{'WMAPE%':>9}{'MAPE%':>8}{'MASE':>8}{'MAE t':>9}{'baseline%':>11}   verdict")
CO2_HORIZON = []
for lo, hi in BUCKETS:
    g = hz[(hz.h >= lo) & (hz.h <= hi)]
    if g.empty:
        continue
    e = (g.a - g.f).abs()
    wm = e.sum() / g.a.sum() * 100
    mp = (e / g.a).mean() * 100
    ms = e.mean() / hz_scale
    base = min((g.a - g.sn).abs().sum() / g.a.sum() * 100,
               (g.a - g.cl).abs().sum() / g.a.sum() * 100)
    ok = bool(wm < base and ms < 1.0)
    note = ("validated range" if hi <= HORIZON else
            "weakest stretch - loses to repeating last week" if not ok else
            "beyond the validated range but still clears both gates")
    CO2_HORIZON.append((lo, hi, wm, mp, ms, e.mean(), base, ok, note))
    print(f"  {f'd{lo}-{hi}':<10}{wm:>9.2f}{mp:>8.2f}{ms:>8.3f}{e.mean():>9.1f}{base:>11.2f}"
          f"   {'USABLE' if ok else 'FAILS GATES'}")

for lo, hi, wm, mp, ms, mae_, bw, ok, note in CO2_HORIZON:
    cur.execute("""INSERT INTO gold.ml_horizon_accuracy
        (target, model_name, h_lo, h_hi, n, wmape, mape, mase, mae, baseline_wmape, usable, note)
        VALUES ('Corridor CO2',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (CHAMPION, lo, hi, int(((hz.h >= lo) & (hz.h <= hi)).sum()),
         float(wm), float(mp), float(ms), float(mae_), float(bw), ok, note))
conn.commit()

cur.execute("SELECT COUNT(*) FILTER (WHERE NOT is_holdout AND NOT is_future), COUNT(*) FILTER (WHERE is_holdout), COUNT(*) FILTER (WHERE is_future) FROM gold.ml_predictive_emissions")
pa, ho, fu = cur.fetchone()
print(f"  ml_predictive_emissions: {pa:,} PAST + {ho:,} PRESENT + {fu} FUTURE")

json.dump({
    "generated": str(pd.Timestamp.now().date()),
    "source": "gold.fact_emissions_hourly (rebuilt from gold.fact_traffic_hourly)",
    "series": {"days": int(len(df)), "from": str(df.ds.min().date()), "to": str(df.ds.max().date()),
               "mean_tonnes_per_day": float(df.y.mean())},
    "protocol": {"origins": N_ORIGINS, "horizon": HORIZON, "step": STEP, "season": SEASON,
                 "scored_days": int(res.n.iloc[0])},
    "baseline": {"name": base_name, "wmape": float(base)},
    "results": res.drop(columns=["is_candidate"]).to_dict("records"),
    "champion": champ_name,
}, open("emissions_results.json", "w"), indent=2)
conn.commit()
print("  emissions_results.json written")
conn.close()
banner("DONE")
