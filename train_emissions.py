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

banner(f"STEP 3: Rolling-origin evaluation ({N_ORIGINS} origins, h={HORIZON}d)")
preds = {k: {} for k in MODELS}
preds["SeasonalNaive"] = {}
preds["Climatology"] = {}
fails = {k: 0 for k in MODELS}

for oi, cut in enumerate(origins, 1):
    tr, fut = d.iloc[:cut], d.iloc[cut:cut + HORIZON]
    if len(fut) < HORIZON:
        break
    for name, fn in MODELS.items():
        try:
            yh = fn(tr, fut)
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

print("\n  VERDICT")
for r in res[res.is_candidate].itertuples():
    why = []
    if not r.wmape < base: why.append(f"WMAPE {r.wmape:.2f}% does not beat baseline {base:.2f}%")
    if not r.mase < 1.0: why.append(f"MASE {r.mase:.3f} >= 1.0")
    print(f"    {r.model:<12} MAPE {r.mape:6.2f}%  WMAPE {r.wmape:6.2f}%  MASE {r.mase:5.3f}  "
          + ("accepted" if r.accepted else "rejected - " + "; ".join(why)))
if fails: print(f"\n  failed origins: {fails}")

banner("STEP 5: Writing to AWS")
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
          (model_name,target,rmse,mae,wmape,r2,mase,mape,rank,accepted,rejected_reason,uses_weather,updated_at)
        VALUES (%s,'Corridor CO2',%s,%s,%s,%s,%s,%s,%s,%s,%s,true,now())""",
        (r.model, r.rmse, r.mae, r.wmape, r.r2, r.mase, r.mape,
         int(r.rank) if r.is_candidate else None, bool(r.accepted), reason))

champ = res[res.accepted]
champ_name = champ.model.iloc[0] if len(champ) else None
print(f"  ml_model_metrics: {len(res)} rows under target='Corridor CO2'")
print(f"  champion: {champ_name or 'none accepted'}")

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
