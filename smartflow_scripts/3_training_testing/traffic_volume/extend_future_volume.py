"""
Extend the traffic FUTURE window from 28 days to 90.

WHY THIS IS SAFE TO DO WITHOUT RE-EVALUATING
  The FUTURE block is produced by fitting each model on the ENTIRE series and
  projecting forward. It does not depend on the split arm, the origins, or any
  holdout - those only decide what gets SCORED. So lengthening the projection
  changes no metric, moves no ranking, and cannot invalidate the 80/20 result.
  The rolling-origin evaluation is left exactly as it is.

WHY 90 DAYS IS DEFENSIBLE
  Measured, not assumed - and measured HERE, in this script, every time it runs.
  A rolling-origin study at h=90 scores the accepted model by how far ahead each
  day was, and the resulting curve is written to gold.ml_horizon_accuracy for
  the dashboard to quote.

  An earlier version pasted that curve in as a list of constants copied from a
  separate script. The numbers were real but frozen, so after any retrain the
  dashboard could have shown a horizon curve belonging to a model that was no
  longer being served. Nothing in the source is a transcribed figure now.

  The expectation, from the structure of the model rather than from a stored
  number: Prophet is STRUCTURAL - trend plus weekly and yearly seasonality,
  evaluated directly at any date - so it never consumes its own output and its
  error should rise then flatten rather than compound. That is a claim about
  Prophet only; LSTM forecasts recursively and does compound over 90 steps.
  Whether it holds is decided by the run, not by this comment.
"""
import io
from pathlib import Path
import numpy as np
import pandas as pd
import psycopg2

SRC = str(Path(__file__).with_name("retrain_honest.py"))
FUTURE_DAYS = 90

src = io.open(SRC, encoding="utf-8").read()
head = src.split('banner(f"STEP 2: Rolling-origin evaluation')[0]
ns = {"__name__": "prep", "__file__": SRC}
exec(compile(head, "prep", "exec"), ns)

df, MODELS = ns["df"], ns["MODELS"]
WEATHER_COLS, HIST_BY_DOY = ns["WEATHER_COLS"], ns["HIST_BY_DOY"]
PG = ns["POSTGRES_URL"]

print(f"\nseries: {len(df):,} days, last actual {df.ds.max().date()}")

future_dates = pd.date_range(df.ds.max() + pd.Timedelta(days=1), periods=FUTURE_DAYS, freq="D")
future_df = pd.DataFrame({"ds": future_dates})
for c in WEATHER_COLS:
    future_df[c] = [float(HIST_BY_DOY[c].get(d.dayofyear, df[c].mean())) for d in future_dates]

print(f"projecting {FUTURE_DAYS} days: {future_dates[0].date()} -> {future_dates[-1].date()}")
print("weather over this window is day-of-year climatology, not observation\n")

preds = {}
for name, fn in MODELS.items():
    if name in ("SeasonalNaive", "Climatology"):
        continue                       # baselines are not served to the chart
    try:
        y = np.asarray(fn(df, FUTURE_DAYS, future_df), dtype=float)
        if y.shape != (FUTURE_DAYS,) or not np.isfinite(y).all():
            raise ValueError(f"bad output shape/values {y.shape}")
        preds[name] = y
        print(f"  {name:<14} ok    mean {y.mean():>9,.0f}   "
              f"range {y.min():,.0f} .. {y.max():,.0f}")
    except Exception as exc:
        preds[name] = np.full(FUTURE_DAYS, np.nan)
        print(f"  {name:<14} FAILED: {str(exc)[:70]}")

conn = psycopg2.connect(PG)
cur = conn.cursor()

cur.execute("SELECT DISTINCT split_label FROM gold.ml_predictive_volume WHERE split_label IS NOT NULL")
arms = [r[0] for r in cur.fetchall()]
print(f"\nsplit arms present: {arms}")

cur.execute("SELECT COUNT(*) FROM gold.ml_predictive_volume WHERE is_future")
print(f"existing future rows (all arms): {cur.fetchone()[0]}")


def val(name, i):
    v = preds.get(name, [np.nan] * FUTURE_DAYS)[i]
    return None if not np.isfinite(v) else int(round(v))


# The projection is identical for every arm - same fit on the same full series -
# so each arm gets the same 90 rows, differing only in the label.
cur.execute("DELETE FROM gold.ml_predictive_volume WHERE is_future")
for arm in arms:
    for i, ds in enumerate(future_dates):
        cur.execute("""
            INSERT INTO gold.ml_predictive_volume
              (forecast_date, actual_volume, pred_lstm, pred_prophet, pred_holtwinters,
               pred_sarimax, pred_holts_linear, is_holdout, is_future,
               weather_rainfall, weather_temp,
               pred_prophet_nw, pred_sarimax_nw, pred_lstm_nw, split_label)
            VALUES (%s,NULL,%s,%s,%s,%s,%s,false,true,%s,%s,%s,%s,%s,%s)""",
            (ds.date(), val("LSTM", i), val("Prophet", i), val("HoltWinters", i),
             val("SARIMAX", i), val("Holts_Linear", i),
             float(future_df.total_rain.iloc[i]), float(future_df.avg_temp.iloc[i]),
             val("Prophet_nw", i), val("SARIMAX_nw", i), val("LSTM_nw", i), arm))
    print(f"  wrote {FUTURE_DAYS} future rows for split_label={arm}")

# Per-horizon accuracy, so the dashboard can say what each stretch is worth
# instead of implying the h=14 figure applies to day 90.
cur.execute("""
  CREATE TABLE IF NOT EXISTS gold.ml_horizon_accuracy (
    id serial PRIMARY KEY,
    target text NOT NULL, model_name text NOT NULL,
    h_lo int NOT NULL, h_hi int NOT NULL,
    n int, wmape numeric(10,4), mape numeric(10,4), mase numeric(10,4), mae numeric(14,2),
    baseline_wmape numeric(10,4), usable boolean, note text,
    updated_at timestamptz DEFAULT now())""")
cur.execute("""COMMENT ON TABLE gold.ml_horizon_accuracy IS
  'How forecast error grows with how far ahead the day was. Measured by a rolling-origin study run inline by extend_future_volume.py against whichever model the leaderboard accepted, NOT transcribed and NOT extrapolated from the h=14 run. Lets the dashboard label a 90-day projection with the accuracy that actually applies to each stretch instead of quoting the 14-day figure everywhere.'""")
cur.execute("DELETE FROM gold.ml_horizon_accuracy WHERE target='Total Traffic'")

# MEASURED HERE, not transcribed. This block previously held a STUDY = [...]
# list of numbers copied by hand out of a separate script. They were real
# measurements, but frozen: after any retrain the dashboard could have shown a
# horizon curve belonging to a model no longer being served, with nothing to
# flag the mismatch. It now runs the study inline against whichever model the
# leaderboard actually accepted.
cur.execute("""SELECT model_name FROM gold.ml_model_metrics
               WHERE target = 'Total Traffic' AND accepted IS TRUE
               ORDER BY rank NULLS LAST LIMIT 1""")
row = cur.fetchone()
CHAMP = row[0] if row else "Prophet"
print(f"\nhorizon study: champion = {CHAMP}")

HZ_H, HZ_STEP, HZ_N, SEASON = 90, 30, 9, 7
hz_origins = [len(df) - (HZ_N - i) * HZ_STEP - HZ_H for i in range(HZ_N)]
hz_origins = [o for o in hz_origins if o > 400]
print(f"  {len(hz_origins)} origins, h={HZ_H}d, step={HZ_STEP}d")

hz = []
for oi, cut in enumerate(hz_origins, 1):
    tr_o, fut_o = df.iloc[:cut], df.iloc[cut:cut + HZ_H]
    if len(fut_o) < HZ_H:
        continue
    # Climatology from the TRAINING slice only — a 90-day weather observation
    # does not exist at forecast time, so using the real one would leak.
    clim_o = tr_o.assign(k=tr_o.ds.dt.dayofyear).groupby("k")[WEATHER_COLS].mean()
    fdf_o = fut_o[["ds"]].copy()
    for c in WEATHER_COLS:
        fb = float(tr_o[c].mean())
        fdf_o[c] = [float(clim_o[c].loc[k]) if k in clim_o.index else fb
                    for k in fut_o.ds.dt.dayofyear]

    yh = np.asarray(MODELS[CHAMP](tr_o, HZ_H, fdf_o), dtype=float)
    lw = tr_o.y.values[-SEASON:]
    doy_o = tr_o.assign(k=tr_o.ds.dt.dayofyear).groupby("k").y.mean()
    for i in range(HZ_H):
        hz.append({
            "h": i + 1, "a": float(fut_o.y.iloc[i]), "f": float(yh[i]),
            "sn": float(lw[i % SEASON]),
            "cl": float(doy_o.get(fut_o.ds.iloc[i].dayofyear, tr_o.y.mean())),
        })
    print(f"    origin {oi}/{len(hz_origins)}  {fut_o.ds.iloc[0].date()} -> {fut_o.ds.iloc[-1].date()}")

hzdf = pd.DataFrame(hz)
_ins = df.y.values[:hz_origins[0]]
hz_scale = np.mean(np.abs(_ins[SEASON:] - _ins[:-SEASON]))
BUCKETS = [(1, 7), (8, 14), (15, 30), (31, 60), (61, 90)]

print(f"\n  MASE denominator (seasonal naive, {len(_ins)} training days): {hz_scale:,.0f} veh")
print(f"  {'range':<10}{'WMAPE%':>9}{'MAPE%':>8}{'MASE':>8}{'MAE veh':>11}{'baseline%':>11}   verdict")
STUDY = []
for lo, hi in BUCKETS:
    g = hzdf[(hzdf.h >= lo) & (hzdf.h <= hi)]
    if g.empty:
        continue
    e = (g.a - g.f).abs()
    wm = e.sum() / g.a.sum() * 100
    mp = (e / g.a).mean() * 100
    ms = e.mean() / hz_scale
    base = min((g.a - g.sn).abs().sum() / g.a.sum() * 100,
               (g.a - g.cl).abs().sum() / g.a.sum() * 100)
    ok = bool(wm < base and ms < 1.0)
    note = ("validated operating range" if hi <= 14 else
            "beyond the 14d validation, still clears both gates" if ok else
            "beyond the 14d validation and FAILS the gates")
    if ok and ms > 0.95:
        note += " - marginal, MASE %.3f" % ms
    STUDY.append((lo, hi, int(len(g)), wm, mp, ms, e.mean(), base, ok, note))
    print(f"  {f'd{lo}-{hi}':<10}{wm:>9.2f}{mp:>8.2f}{ms:>8.3f}{e.mean():>11,.0f}{base:>11.2f}"
          f"   {'USABLE' if ok else 'FAILS GATES'}")

for lo, hi, n, wm, mp, ms, mae, bw, ok, note in STUDY:
    cur.execute("""INSERT INTO gold.ml_horizon_accuracy
        (target, model_name, h_lo, h_hi, n, wmape, mape, mase, mae, baseline_wmape, usable, note)
        VALUES ('Total Traffic',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (CHAMP, lo, hi, n, float(wm), float(mp), float(ms), float(mae), float(bw), ok, note))

conn.commit()
cur.execute("""SELECT MIN(forecast_date)::text, MAX(forecast_date)::text, COUNT(*)
               FROM gold.ml_predictive_volume WHERE is_future AND split_label='80_20'""")
lo, hi, n = cur.fetchone()
print(f"\n80_20 future window now: {lo} -> {hi}  ({n} days)")
cur.execute("SELECT COUNT(*) FROM gold.ml_horizon_accuracy WHERE target='Total Traffic'")
print(f"gold.ml_horizon_accuracy: {cur.fetchone()[0]} buckets stored")
conn.close()
