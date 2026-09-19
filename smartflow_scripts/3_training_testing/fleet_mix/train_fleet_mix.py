"""
7-day fleet-mix forecast — training and evaluation.

Candidates follow the modelling diagram's second Emission Forecasting box:
Dirichlet regression, XGBoost, multivariate LSTM and Prophet, scored on
Aitchison distance. Protocol matches train_emissions.py so the two are
comparable: rolling-origin walk-forward, and acceptance only by beating BOTH
trivial baselines (Aitchison below the better of persistence/climatology, AND a
skill ratio < 1 against persistence).

WHY COMPOSITIONAL METHODS AND NOT THREE SEPARATE REGRESSIONS

  The target is a composition: three class shares that must be non-negative and
  sum to 1. Forecasting each share with its own regression ignores that — the
  three predictions are free to sum to 0.97 or 1.04, which is not a fleet mix.
  Every candidate here therefore predicts in CLR (centred log-ratio) space and
  maps back through the inverse CLR, so a prediction is a valid composition by
  construction rather than by rounding afterwards.

  Dirichlet regression is the exception that needs no transform: its likelihood
  is defined on the simplex, so it models the mix directly.

WHY AITCHISON DISTANCE IS THE HEADLINE METRIC, NOT MAPE

  The diagram lists "Fleet mix MAPE". MAPE divides by the actual value, and on
  this corridor Class 3 sits near 7-8% while Class 1 sits near 78%. The same
  one-point miss scores ~13% on Class 3 and ~1.3% on Class 1, so a MAPE average
  is dominated by the smallest part and reports a model as bad for being wrong
  about the rarest class by an amount it got right about the commonest one.

  Aitchison distance is the standard metric for compositional data: it is the
  Euclidean distance between CLR coordinates, so it treats a proportional error
  in a small part the same as the same proportional error in a large one. Both
  are recorded — Aitchison decides acceptance, MAPE is reported alongside
  because the diagram asks for it.

  Total variation distance is also reported, because it is the one number a
  reader without a compositional-statistics background can interpret directly:
  it is the fraction of the fleet assigned to the wrong class.

SOURCE
  gold.fact_traffic_hourly (class_1/class_2/class_3 counts per exit-hour),
  aggregated to corridor totals per day. 1,461 days, 2022-01-01 to 2025-12-31.

HORIZON
  7 days, per the diagram ("7-day fleet mix forecast").
"""
import json
import warnings
import numpy as np
import pandas as pd
import psycopg2
from scipy.optimize import minimize
from scipy.special import gammaln

warnings.filterwarnings("ignore")

import sys as _sys
from pathlib import Path as _Path

# Connection comes from Back-End/.env (PG_* keys), never from this file —
# the same convention train_congestion_horizon.py uses, so both scripts read
# one set of credentials and there is nothing to keep in sync.
_env = {}
for _line in (_Path(__file__).resolve().parents[2] / "Back-End" / ".env").read_text().splitlines():
    if "=" in _line and not _line.startswith("#"):
        _k, _v = _line.split("=", 1)
        _env[_k.strip()] = _v.strip().strip('"')
PG = (f"host={_env['PG_HOST']} port={_env.get('PG_PORT', 5432)} dbname={_env['PG_DATABASE']} "
      f"user={_env['PG_USER']} password={_env['PG_PASSWORD']} sslmode=require")

HORIZON, STEP, N_ORIGINS, SEASON = 7, 7, 42, 7
FUTURE_DAYS = 30
PARTS = ["c1", "c2", "c3"]

# Aitchison gap below which two candidates are not meaningfully separated.
# Same idea as TIE_MARGIN_WMAPE in train_emissions.py: without it the table
# implies an ordering that re-running the script would reshuffle.
TIE_MARGIN_AITCH = 0.004

# A day is flagged as a heavy-vehicle surge when the Class 2+3 share exceeds the
# training mean by this many standard deviations. Reported as the diagram's
# "heavy vehicle surge prediction" output.
SURGE_SIGMA = 1.5

DRY_RUN = "--dry-run" in _sys.argv


def banner(t):
    print("\n" + "=" * 70 + f"\n  {t}\n" + "=" * 70)


# ─────────────────────────────────────────────────────────── compositional ──
def _closure(P):
    """Force rows onto the simplex, and keep them off its boundary.

    A zero part makes log(0) and takes the whole CLR transform with it. Zeros
    here are missing observations rather than genuine absences — a day with no
    Class 3 traffic on a national freight corridor is a reporting gap — so they
    are replaced with a value an order of magnitude below the smallest real
    share rather than dropped, which would silently shorten the series.
    """
    P = np.asarray(P, dtype=float)
    P = np.where(P <= 0, 1e-6, P)
    return P / P.sum(axis=1, keepdims=True)


def clr(P):
    """Centred log-ratio. Maps the simplex to a plane where ordinary
    regression is meaningful, because differences become log-ratios."""
    L = np.log(_closure(P))
    return L - L.mean(axis=1, keepdims=True)


def inv_clr(Z):
    """Back to the simplex. This is a softmax, so the result always sums to 1
    and is always positive — the property that makes every candidate produce a
    valid composition without post-hoc normalisation."""
    Z = np.asarray(Z, dtype=float)
    E = np.exp(Z - Z.max(axis=1, keepdims=True))
    return E / E.sum(axis=1, keepdims=True)


def aitchison(P, Q):
    """Per-row Aitchison distance: Euclidean distance between CLR coordinates."""
    return np.sqrt(((clr(P) - clr(Q)) ** 2).sum(axis=1))


def tvd(P, Q):
    """Total variation distance: the share of the fleet placed in the wrong
    class. Reported because it is directly interpretable."""
    return 0.5 * np.abs(_closure(P) - _closure(Q)).sum(axis=1)


# ────────────────────────────────────────────────────────────────── features ──
def design(ds, t0):
    """Deterministic features only: trend plus day-of-week.

    No lags, deliberately. A lagged model has to be rolled forward one day at a
    time to reach day 7, and each step feeds its own error into the next; over
    a 7-day horizon that compounds into drift that has nothing to do with the
    model's grasp of the mix. Trend and weekday can be evaluated directly at any
    future date, so day 7 is predicted as honestly as day 1.
    """
    ds = pd.to_datetime(pd.Series(ds).values)
    trend = ((ds - t0).days.values / 365.25).reshape(-1, 1)
    dow = pd.get_dummies(pd.Series(ds).dt.dayofweek, prefix="d").reindex(
        columns=[f"d_{i}" for i in range(7)], fill_value=0).values.astype(float)
    # Drop one weekday to keep the design matrix full rank.
    return np.hstack([np.ones((len(ds), 1)), trend, dow[:, 1:]])


# ───────────────────────────────────────────────────────────────── candidates ──
def fit_dirichlet(tr, fut):
    """Dirichlet regression by maximum likelihood.

    alpha_k(x) = exp(x @ B_k), and the mean composition is alpha / sum(alpha).
    Because the Dirichlet is defined on the simplex, this is the only candidate
    that needs no transform — the constraint is in the likelihood rather than
    bolted on afterwards.
    """
    t0 = tr.ds.min()
    X, Y = design(tr.ds, t0), _closure(tr[PARTS].values)
    p = X.shape[1]

    logY = np.log(Y)

    def nll(b):
        A = np.exp(np.clip(X @ b.reshape(p, 3), -6, 6))
        a0 = A.sum(axis=1)
        ll = gammaln(a0).sum() - gammaln(A).sum() + ((A - 1.0) * logY).sum()
        return -ll / len(Y)

    # Start from a fit that already knows the average mix, so the optimiser is
    # refining a sensible composition rather than searching from nothing.
    b0 = np.zeros((p, 3))
    b0[0] = np.log(np.clip(Y.mean(axis=0) * 40, 1e-3, None))
    r = minimize(nll, b0.ravel(), method="L-BFGS-B",
                 options={"maxiter": 500, "maxfun": 5000})

    A = np.exp(np.clip(design(fut.ds, t0) @ r.x.reshape(p, 3), -6, 6))
    return A / A.sum(axis=1, keepdims=True)


def fit_xgboost(tr, fut):
    """One regressor per CLR coordinate, mapped back through the inverse CLR."""
    from xgboost import XGBRegressor
    t0 = tr.ds.min()
    X, Z = design(tr.ds, t0), clr(tr[PARTS].values)
    Xf = design(fut.ds, t0)
    out = np.column_stack([
        XGBRegressor(n_estimators=300, max_depth=3, learning_rate=0.05,
                     subsample=0.9, random_state=42, verbosity=0)
        .fit(X, Z[:, k]).predict(Xf)
        for k in range(3)
    ])
    return inv_clr(out)


def fit_lstm(tr, fut):
    """Multivariate LSTM over the three CLR series jointly.

    Multivariate rather than three univariate runs because the parts move
    against each other by definition — a point gained by Class 1 is a point
    lost by 2 or 3 — so the series carry information about one another that
    separate models cannot use.
    """
    import tensorflow as tf
    from tensorflow.keras import layers, Sequential
    tf.random.set_seed(42)
    SEQ = 28
    Z = clr(tr[PARTS].values).astype("float32")
    mu, sd = Z.mean(axis=0), np.where(Z.std(axis=0) == 0, 1.0, Z.std(axis=0))
    z = (Z - mu) / sd
    X = np.array([z[i - SEQ:i] for i in range(SEQ, len(z))])
    Y = np.array([z[i] for i in range(SEQ, len(z))])
    m = Sequential([layers.Input((SEQ, 3)), layers.LSTM(32), layers.Dense(3)])
    m.compile("adam", "mse")
    m.fit(X, Y, epochs=30, batch_size=32, verbose=0)
    win, out = list(z[-SEQ:]), []
    for _ in range(len(fut)):
        p = m.predict(np.array(win[-SEQ:])[None, ...], verbose=0)[0]
        out.append(p)
        win.append(p)
    return inv_clr(np.array(out) * sd + mu)


def fit_prophet(tr, fut):
    """Prophet on each CLR coordinate, recombined through the inverse CLR."""
    from prophet import Prophet
    t_end = tr.ds.max()
    Z = clr(tr[PARTS].values)
    cols = []
    for k in range(3):
        m = Prophet(weekly_seasonality=True, yearly_seasonality=True,
                    daily_seasonality=False)
        m.fit(pd.DataFrame({"ds": tr.ds, "y": Z[:, k]}))
        fc = m.predict(pd.DataFrame({"ds": fut.ds}))
        cols.append(fc.yhat.values)
    _ = t_end
    return inv_clr(np.column_stack(cols))


MODELS = {
    "Dirichlet": fit_dirichlet,
    "XGBoost": fit_xgboost,
    "LSTM": fit_lstm,
    "Prophet": fit_prophet,
}

# ──────────────────────────────────────────────────────────────────── load ──
banner("STEP 1: Loading the corridor fleet-mix series")
conn = psycopg2.connect(PG)
d = pd.read_sql_query("""
    SELECT date::date        AS ds,
           SUM(class_1)::float AS c1,
           SUM(class_2)::float AS c2,
           SUM(class_3)::float AS c3
    FROM gold.fact_traffic_hourly
    GROUP BY 1
    HAVING SUM(class_1 + class_2 + class_3) > 0
    ORDER BY 1
""", conn)
d["ds"] = pd.to_datetime(d.ds)
tot = d[PARTS].sum(axis=1)
for c in PARTS:
    d[c] = d[c] / tot
d["heavy"] = d.c2 + d.c3

print(f"  {len(d):,} days | {d.ds.min().date()} -> {d.ds.max().date()}")
print(f"  mean mix  C1 {d.c1.mean()*100:.2f}%  C2 {d.c2.mean()*100:.2f}%  C3 {d.c3.mean()*100:.2f}%")
print(f"  heavy share (C2+C3)  mean {d.heavy.mean()*100:.2f}%  sd {d.heavy.std()*100:.2f}pp")

origins = [len(d) - HORIZON - i * STEP for i in range(N_ORIGINS)][::-1]
origins = [o for o in origins if o > 120]
print(f"  {len(origins)} rolling origins, horizon {HORIZON}d")

# ───────────────────────────────────────────────────────────────── evaluate ──
banner(f"STEP 2: Rolling-origin evaluation ({len(origins)} origins, h={HORIZON}d)")

# Prediction cache, same device train_emissions.py uses and for the same
# reason: 42 origins x (an LSTM trained for 30 epochs + three Prophet fits) is
# tens of minutes, and nothing about it changes while the series and the
# protocol are unchanged. The key covers both, so extending the data or editing
# the protocol invalidates it automatically rather than silently serving stale
# predictions.
import os as _os
import pickle as _pickle
CACHE = str(_Path(__file__).with_name("fleet_mix_preds.pkl"))
CACHE_KEY = ("clr-deterministic-v1", len(d), str(d.ds.max().date()),
             len(origins), HORIZON, tuple(sorted(MODELS)))
_cached = None
if _os.path.exists(CACHE):
    try:
        with open(CACHE, "rb") as fh:
            k, v = _pickle.load(fh)
        if k == CACHE_KEY:
            _cached = v
            print(f"  reusing cached predictions ({CACHE}) - series and protocol unchanged")
    except Exception:
        _cached = None

preds = {k: {} for k in MODELS}
preds["Persistence"] = {}
preds["Climatology"] = {}
fails = {k: 0 for k in MODELS}
errors = {}

if _cached is not None:
    preds, fails, errors = _cached

for oi, cut in enumerate([] if _cached is not None else origins, 1):
    tr, fut = d.iloc[:cut], d.iloc[cut:cut + HORIZON]
    if len(fut) < HORIZON:
        break
    for name, fn in MODELS.items():
        try:
            P = fn(tr, fut)
            for ds, row in zip(fut.ds, P):
                preds[name][ds] = row
        except Exception as e:
            fails[name] += 1
            errors.setdefault(name, str(e)[:90])

    # Baselines. Persistence is a hard one here on purpose: the mix is sticky,
    # so "assume tomorrow looks like today" is genuinely difficult to beat, and
    # a candidate that cannot is not adding anything.
    last = tr[PARTS].values[-1]
    dow_mean = tr.assign(k=tr.ds.dt.dayofweek).groupby("k")[PARTS].mean()
    for ds in fut.ds:
        preds["Persistence"][ds] = last
        preds["Climatology"][ds] = dow_mean.loc[ds.dayofweek].values
    if oi % 10 == 0 or oi == 1:
        print(f"  origin {oi}/{len(origins)}  train={cut}d  "
              f"predict {fut.ds.iloc[0].date()} -> {fut.ds.iloc[-1].date()}")

if _cached is None:
    _os.makedirs(_os.path.dirname(CACHE), exist_ok=True)
    with open(CACHE, "wb") as fh:
        _pickle.dump((CACHE_KEY, (preds, fails, errors)), fh)

for name, n in fails.items():
    if n:
        print(f"  {name}: {n}/{len(origins)} origins failed — {errors.get(name,'')}")

# ────────────────────────────────────────────────────────────────── results ──
banner("STEP 3: Results")
truth = d.set_index("ds")[PARTS]
rows = []
for name, pm in preds.items():
    idx = sorted(pm)
    if not idx:
        continue
    A = truth.loc[idx].values
    F = np.array([pm[i] for i in idx])
    ad = aitchison(A, F)
    tv = tvd(A, F)
    err_pp = np.abs(A - F) * 100
    heavy_a, heavy_f = A[:, 1] + A[:, 2], F[:, 1] + F[:, 2]
    rows.append({
        "model": name, "n": len(idx),
        "aitchison": float(ad.mean()),
        "tvd_pct": float(tv.mean() * 100),
        "mae_pp": float(err_pp.mean()),
        "rmse_pp": float(np.sqrt(((A - F) ** 2 * 1e4).mean())),
        "mape": float(np.mean(np.abs(A - F) / np.abs(A)) * 100),
        "heavy_wmape": float(np.abs(heavy_a - heavy_f).sum() / heavy_a.sum() * 100),
        "heavy_r2": float(1 - ((heavy_a - heavy_f) ** 2).sum()
                          / ((heavy_a - heavy_a.mean()) ** 2).sum()),
    })

res = pd.DataFrame(rows).sort_values("aitchison").reset_index(drop=True)
print(f"\n  Evaluated on {res.n.iloc[0]:,} forecast-days\n")
print(res[["model", "aitchison", "tvd_pct", "mae_pp", "mape", "heavy_wmape", "heavy_r2"]]
      .to_string(index=False, float_format=lambda v: f"{v:,.4f}"))

BASE_NAMES = ["Persistence", "Climatology"]
bmask = res.model.isin(BASE_NAMES)
base = res[bmask].aitchison.min()
base_name = res.loc[res[bmask].aitchison.idxmin(), "model"]
pers = float(res.loc[res.model == "Persistence", "aitchison"].iloc[0])
print(f"\n  Baseline to beat: {base:.4f} Aitchison ({base_name})")

res["is_candidate"] = res.model.isin(MODELS)
# Skill ratio against persistence — the compositional analogue of MASE. Below 1
# means the model is worth running instead of assuming nothing changes.
res["skill"] = res.aitchison / pers
res["accepted"] = res.is_candidate & (res.aitchison < base) & (res.skill < 1.0)
res["rank"] = np.where(res.is_candidate, res.groupby("is_candidate").cumcount() + 1, None)

_best = res[res.is_candidate].aitchison.min() if res.is_candidate.any() else np.nan
res["tied"] = res.is_candidate & ((res.aitchison - _best).abs() <= TIE_MARGIN_AITCH)
TIED = list(res[res.tied].model)


def _diagnosis(r):
    if not r.is_candidate:
        return "baseline, not a candidate"
    if len(TIED) > 1 and r.tied:
        others = [m for m in TIED if m != r.model]
        return (f"tied with {', '.join(others)} - within {TIE_MARGIN_AITCH} Aitchison, "
                "so the ordering between them is not meaningful")
    return None


res["diagnosis"] = res.apply(_diagnosis, axis=1)
if len(TIED) > 1:
    print(f"\n  TIE: {', '.join(TIED)} - within {TIE_MARGIN_AITCH} Aitchison. Co-champions.")

print("\n  VERDICT")
for r in res[res.is_candidate].itertuples():
    why = []
    if not r.aitchison < base:
        why.append(f"Aitchison {r.aitchison:.4f} does not beat baseline {base:.4f}")
    if not r.skill < 1.0:
        why.append(f"skill {r.skill:.3f} >= 1.0 (no better than persistence)")
    print(f"    {r.model:<12} Aitchison {r.aitchison:7.4f}  TVD {r.tvd_pct:5.2f}%  "
          f"skill {r.skill:5.3f}  "
          + ("accepted" if r.accepted else "rejected - " + "; ".join(why)))

champ = res[res.accepted]
champ_name = champ.model.iloc[0] if len(champ) else None
print(f"\n  champion: {champ_name or 'none accepted'}")

if DRY_RUN:
    banner("DONE (dry run) — nothing written")
    conn.close()
    _sys.exit(0)

# ──────────────────────────────────────────────────────────────────── write ──
banner("STEP 4: Writing to AWS")
try:
    conn.cursor().execute("SELECT 1")
except Exception:
    print("  connection went idle during training - reconnecting")
    conn = psycopg2.connect(PG)
cur = conn.cursor()

cur.execute("DELETE FROM gold.ml_model_metrics WHERE target = 'Fleet Mix'")
for r in res.itertuples():
    reason = None
    if r.is_candidate and not r.accepted:
        w = []
        if not r.aitchison < base:
            w.append(f"Aitchison {r.aitchison:.4f} does not beat baseline {base:.4f}")
        if not r.skill < 1.0:
            w.append(f"skill {r.skill:.3f} >= 1.0 (no better than persistence)")
        reason = "; ".join(w)
    elif not r.is_candidate:
        reason = "baseline, not a candidate"
    cur.execute("""
        INSERT INTO gold.ml_model_metrics
          (model_name,target,rmse,mae,wmape,r2,mase,mape,rank,accepted,
           rejected_reason,uses_weather,diagnosis,split_label,updated_at)
        VALUES (%s,'Fleet Mix',%s,%s,%s,%s,%s,%s,%s,%s,%s,false,%s,%s,now())""",
        (r.model, r.rmse_pp, r.mae_pp, r.heavy_wmape, r.heavy_r2, r.skill, r.mape,
         int(r.rank) if r.is_candidate else None, bool(r.accepted), reason,
         r.diagnosis, f"rolling-origin {HORIZON}d x {len(origins)}"))
print(f"  ml_model_metrics: {len(res)} rows under target='Fleet Mix'")

cur.execute("""
CREATE TABLE IF NOT EXISTS gold.ml_predictive_fleet_mix (
    id              serial PRIMARY KEY,
    forecast_date   date NOT NULL,
    actual_c1       numeric(7,5),
    actual_c2       numeric(7,5),
    actual_c3       numeric(7,5),
    pred_c1         numeric(7,5),
    pred_c2         numeric(7,5),
    pred_c3         numeric(7,5),
    heavy_pred      numeric(7,5),
    heavy_surge     boolean,
    champion_model  text,
    is_holdout      boolean,
    is_future       boolean,
    updated_at      timestamptz DEFAULT now()
)""")
cur.execute("""COMMENT ON TABLE gold.ml_predictive_fleet_mix IS
  'Daily Class 1/2/3 share forecast. Shares are fractions summing to 1, not
   percentages. is_holdout marks days scored in rolling-origin evaluation;
   is_future marks unscored projection beyond the last observation.'""")
cur.execute("DELETE FROM gold.ml_predictive_fleet_mix")

if champ_name is None:
    print("  no model accepted — writing history only, no forecast")
    served = {}
    future = pd.DataFrame(columns=["ds"])
else:
    served = preds[champ_name]
    last_ds = d.ds.max()
    future = pd.DataFrame({"ds": pd.date_range(last_ds + pd.Timedelta(days=1),
                                               periods=FUTURE_DAYS, freq="D")})
    P = MODELS[champ_name](d, future)
    for ds, row in zip(future.ds, P):
        served[ds] = row

hmu, hsd = d.heavy.mean(), d.heavy.std()
surge_at = hmu + SURGE_SIGMA * hsd
CONTEXT_DAYS = 120
ctx_from = d.ds.max() - pd.Timedelta(days=CONTEXT_DAYS)

n_rows = n_surge = 0
for ds in sorted(set(d[d.ds >= ctx_from].ds) | set(served)):
    act = d.loc[d.ds == ds, PARTS]
    a = act.values[0] if len(act) else [None, None, None]
    p = served.get(ds)
    hp = float(p[1] + p[2]) if p is not None else None
    surge = bool(hp is not None and hp > surge_at)
    n_surge += surge
    cur.execute("""
        INSERT INTO gold.ml_predictive_fleet_mix
          (forecast_date,actual_c1,actual_c2,actual_c3,pred_c1,pred_c2,pred_c3,
           heavy_pred,heavy_surge,champion_model,is_holdout,is_future)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (ds.date(),
         None if a[0] is None else float(a[0]),
         None if a[1] is None else float(a[1]),
         None if a[2] is None else float(a[2]),
         None if p is None else float(p[0]),
         None if p is None else float(p[1]),
         None if p is None else float(p[2]),
         hp, surge, champ_name,
         bool(p is not None and len(act) > 0),
         bool(len(act) == 0)))
    n_rows += 1

conn.commit()
print(f"  ml_predictive_fleet_mix: {n_rows} rows "
      f"({CONTEXT_DAYS}d context + holdout + {FUTURE_DAYS}d projection)")
print(f"  heavy-vehicle surge threshold: {surge_at*100:.2f}% "
      f"(mean {hmu*100:.2f}% + {SURGE_SIGMA}sd), {n_surge} day(s) flagged")

out = _Path(__file__).with_name("fleet_mix_results.json")
out.write_text(json.dumps({
    "champion": champ_name,
    "baseline": {"name": base_name, "aitchison": base},
    "tied": TIED,
    "models": res.drop(columns=["tied"]).to_dict("records"),
    "surge_threshold": float(surge_at),
}, indent=2, default=str))
print(f"  {out.name} written")

conn.close()
banner("DONE")
