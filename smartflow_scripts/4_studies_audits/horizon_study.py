"""
Is a 2-3 month traffic forecast worth anything?

The dashboard validates at 14 days and draws 28. Extending the drawn line to 60
or 90 days is trivial - Prophet will happily extrapolate. The real question is
whether the result carries any skill at that range, and the only way to know is
to score it at that range.

PROTOCOL - identical in spirit to retrain_honest.py, just with a longer horizon:
  rolling origin, refit at every origin, forecast H days blind, never look past
  the origin. Weather over the forecast window is day-of-year CLIMATOLOGY built
  from the training slice only, because a 90-day weather observation does not
  exist at forecast time. (retrain_honest.py currently feeds OBSERVED weather to
  Prophet/SARIMAX inside the scored window - the same leak just fixed in the
  emissions module. Using climatology here keeps this study honest and makes the
  comparison against the seasonal-naive baseline fair.)

VERDICT RULE - the same two gates the project uses everywhere:
  a horizon is usable if WMAPE beats the seasonal-naive baseline AND MASE < 1.
"""
import warnings
import numpy as np
import pandas as pd
import psycopg2

warnings.filterwarnings("ignore")
import logging
logging.getLogger("prophet").setLevel(logging.ERROR)
logging.getLogger("cmdstanpy").setLevel(logging.ERROR)

# Connection settings live in smartflow_scripts/config/.env, read by config/db.py.
# They used to be hardcoded in this file and in ~80 others.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "config"))
from db import PG, POSTGRES_URL, WORK, setting  # noqa: E402,F401

H = 90                 # the horizon under test - 3 months
STEP = 30              # non-overlapping-ish origins, one per month
N_ORIGINS = 9
SEASON = 7
WEATHER = ["avg_temp", "total_rain", "avg_wind", "avg_humidity"]
BUCKETS = [(1, 7), (8, 14), (15, 30), (31, 60), (61, 90)]

conn = psycopg2.connect(PG)
df = pd.read_sql_query(
    "SELECT date AS ds, total_volume AS y FROM gold.daily_traffic_volume_corrected "
    "WHERE total_volume > 0 ORDER BY 1", conn)
wx = pd.read_sql_query("""
    WITH hourly AS (
      SELECT (timestamp_utc + interval '8 hours')::date ds, timestamp_utc hr,
             AVG(temperature) temperature, AVG(rainfall) rainfall,
             AVG(wind_speed) wind_speed, AVG(humidity) humidity
      FROM public.hourly_weather GROUP BY 1,2)
    SELECT ds, AVG(temperature) avg_temp, SUM(rainfall) total_rain,
           AVG(wind_speed) avg_wind, AVG(humidity) avg_humidity
    FROM hourly GROUP BY ds ORDER BY ds""", conn)
for d in (df, wx):
    d["ds"] = pd.to_datetime(d["ds"])
df = df.merge(wx, on="ds", how="left")
df[WEATHER] = df[WEATHER].ffill().bfill()
df = df.reset_index(drop=True)
print(f"series: {len(df):,} days  {df.ds.min().date()} -> {df.ds.max().date()}")

origins = [len(df) - (N_ORIGINS - i) * STEP - H for i in range(N_ORIGINS)]
origins = [o for o in origins if o > 400]
print(f"{len(origins)} origins, H={H}d, step={STEP}d")
print(f"first origin {df.ds.iloc[origins[0]].date()}, last {df.ds.iloc[origins[-1]].date()}\n")

rows = []          # (model, steps_ahead, actual, forecast)

for oi, cut in enumerate(origins, 1):
    tr = df.iloc[:cut]
    fut = df.iloc[cut:cut + H]
    if len(fut) < H:
        continue

    # Climatology for the forecast window, from the training slice only.
    clim = tr.assign(k=tr.ds.dt.dayofyear).groupby("k")[WEATHER].mean()
    fdf = fut[["ds"]].copy()
    for c in WEATHER:
        fallback = float(tr[c].mean())
        fdf[c] = [float(clim[c].loc[k]) if k in clim.index else fallback
                  for k in fut.ds.dt.dayofyear]

    from prophet import Prophet
    m = Prophet(weekly_seasonality=True, yearly_seasonality=True, daily_seasonality=False)
    for c in WEATHER:
        m.add_regressor(c)
    m.fit(tr[["ds", "y"] + WEATHER])
    yhat = m.predict(fdf)["yhat"].values

    # Baselines the forecast has to beat.
    last_week = tr.y.values[-SEASON:]
    snaive = np.array([last_week[i % SEASON] for i in range(H)])
    doy = tr.assign(k=tr.ds.dt.dayofyear).groupby("k").y.mean()
    climo = np.array([float(doy.get(k, tr.y.mean())) for k in fut.ds.dt.dayofyear])

    for i in range(H):
        a = float(fut.y.iloc[i])
        rows.append(("Prophet", i + 1, a, float(yhat[i])))
        rows.append(("SeasonalNaive", i + 1, a, float(snaive[i])))
        rows.append(("Climatology", i + 1, a, float(climo[i])))
    print(f"  origin {oi}/{len(origins)}  train={cut}d  "
          f"{fut.ds.iloc[0].date()} -> {fut.ds.iloc[-1].date()}")

r = pd.DataFrame(rows, columns=["model", "h", "a", "f"])
r["e"] = (r.a - r.f).abs()

# MASE scale: seasonal-naive MAE on the pre-first-origin window.
ins = df.y.values[:origins[0]]
scale = np.mean(np.abs(ins[SEASON:] - ins[:-SEASON]))
print(f"\nMASE denominator (seasonal-naive lag-7 MAE, {len(ins)} training days): {scale:,.0f} veh\n")


def stats(g):
    return pd.Series({
        "n": len(g),
        "WMAPE": g.e.sum() / g.a.sum() * 100,
        "MAPE": (g.e / g.a).mean() * 100,
        "MASE": g.e.mean() / scale,
        "MAE": g.e.mean(),
    })


print("ERROR BY HOW FAR AHEAD THE DAY WAS")
print(f"  {'horizon':<12}{'model':<15}{'n':>6}{'WMAPE%':>9}{'MAPE%':>8}{'MASE':>8}{'MAE veh':>11}   verdict")
for lo, hi in BUCKETS:
    sub = r[(r.h >= lo) & (r.h <= hi)]
    base = min(stats(sub[sub.model == m_])["WMAPE"] for m_ in ("SeasonalNaive", "Climatology"))
    for m_ in ("Prophet", "SeasonalNaive", "Climatology"):
        s = stats(sub[sub.model == m_])
        if m_ == "Prophet":
            ok = s.WMAPE < base and s.MASE < 1.0
            v = "USABLE" if ok else "FAILS GATES"
        else:
            v = "baseline"
        print(f"  {f'd{lo}-{hi}':<12}{m_:<15}{int(s.n):>6}{s.WMAPE:>9.2f}{s.MAPE:>8.2f}"
              f"{s.MASE:>8.3f}{s.MAE:>11,.0f}   {v}")
    print()

print("CUMULATIVE - what a forecast of length L is worth end to end")
print(f"  {'length':<12}{'WMAPE%':>9}{'MASE':>8}   verdict")
for L in (14, 28, 30, 60, 90):
    sub = r[r.h <= L]
    p = stats(sub[sub.model == "Prophet"])
    base = min(stats(sub[sub.model == m_])["WMAPE"] for m_ in ("SeasonalNaive", "Climatology"))
    ok = p.WMAPE < base and p.MASE < 1.0
    print(f"  {f'{L}d':<12}{p.WMAPE:>9.2f}{p.MASE:>8.3f}   "
          f"{'USABLE' if ok else 'FAILS GATES'}  (baseline {base:.2f}%)")
