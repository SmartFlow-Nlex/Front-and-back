#!/usr/bin/env python3
"""
Is the corridor's CO2 better forecast by its own model (the GBR in
train_emissions.py) or DERIVED from the volume forecast?

WHY ASK
  CO2 here is exactly vehicles x segment km x a fixed factor per class
  (gold.fact_emissions_hourly). A separate CO2 model can therefore disagree with
  the volume panel about the same days, and the GBR fails its horizon gates at
  every range (gold.ml_horizon_accuracy, target 'Corridor CO2'), while the
  volume champion is usable for 1-14 days.

THE DERIVED FORECAST
  CO2(d) = V(d) x c(dow(d))
    V    the volume champion's forecast (Prophet, from retrain_honest.py), fitted
         only on days before the origin
    c    CO2 per vehicle for that weekday, averaged over the 8 weeks before the
         origin: it carries the fleet mix (heavy share differs by weekday) and the
         exit/segment mix, and uses nothing after the origin

PROTOCOL
  The same as the volume and CO2 horizon studies: 9 rolling origins, 30 days
  apart, each forecasting 90 days, scored by horizon bucket against the actual
  CO2. MASE uses a weekly seasonal-naive denominator over the training days
  before the first origin, as the other studies do. Read-only: writes a JSON
  report to _work/outputs and nothing to the database.
"""
import io
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2

HERE = Path(__file__).resolve().parent
TT = HERE.parent / "3_training_testing"
sys.path.insert(0, str(HERE.parent / "config"))
from db import PG, WORK  # noqa: E402

# The volume models and series exactly as the volume trainer builds them (same trick as extend_future_volume.py).
SRC = TT / "traffic_volume" / "retrain_honest.py"
src = io.open(SRC, encoding="utf-8").read()
head = src.split('banner(f"STEP 2: Rolling-origin evaluation')[0]
ns = {"__name__": "prep", "__file__": str(SRC)}
exec(compile(head, "prep", "exec"), ns)
df, MODELS, HIST_BY_DOY, WEATHER_COLS = ns["df"], ns["MODELS"], ns["HIST_BY_DOY"], ns["WEATHER_COLS"]
CHAMP = "Prophet"


def forecast_of(out):
    return out[0] if isinstance(out, tuple) else out


conn = psycopg2.connect(PG)
co2 = pd.read_sql("""
    SELECT date AS ds, SUM(co2_tonnes)::float AS co2, SUM(total)::float AS vehicles
      FROM gold.fact_emissions_hourly GROUP BY 1 ORDER BY 1""", conn, parse_dates=["ds"])
gbr = pd.read_sql("""
    SELECT h_lo, h_hi, wmape::float, mape::float, mase::float, baseline_wmape::float, usable
      FROM gold.ml_horizon_accuracy WHERE target = 'Corridor CO2' ORDER BY h_lo""", conn)
hold = pd.read_sql("""
    SELECT e.forecast_date AS ds, e.actual_co2::float AS actual, e.pred_gbr::float AS gbr, v.pred_prophet::float AS vol
      FROM gold.ml_predictive_emissions e
      JOIN gold.ml_predictive_volume v ON v.forecast_date = e.forecast_date AND v.split_label = '80_20' AND v.is_holdout
     WHERE e.is_holdout AND e.actual_co2 IS NOT NULL ORDER BY 1""", conn, parse_dates=["ds"])
conn.close()

s = df[["ds", "y"]].merge(co2, on="ds", how="inner").reset_index(drop=True)
print(f"series: {len(s):,} days with both volume and CO2, {s.ds.min().date()} -> {s.ds.max().date()}")


def per_vehicle_by_dow(hist: pd.DataFrame) -> dict:
    """CO2 per vehicle for each weekday over the last 8 weeks of `hist`."""
    last = hist.tail(56)
    g = last.assign(dow=last.ds.dt.dayofweek).groupby("dow")
    return (g.co2.sum() / g.vehicles.sum()).to_dict()


HZ_H, HZ_STEP, HZ_N, SEASON = 90, 30, 9, 7
idx = {d: i for i, d in enumerate(df.ds)}
origins = [len(df) - (HZ_N - i) * HZ_STEP - HZ_H for i in range(HZ_N)]
origins = [o for o in origins if o > 400]
print(f"horizon study: {len(origins)} origins, h={HZ_H}d, step={HZ_STEP}d, volume model {CHAMP}")

rows = []
for oi, cut in enumerate(origins, 1):
    tr, fut = df.iloc[:cut], df.iloc[cut:cut + HZ_H]
    fdf = fut[["ds"] + list(WEATHER_COLS)].copy()
    for c in WEATHER_COLS:  # no future weather: day-of-year climatology, as the served forecast uses
        fdf[c] = [float(HIST_BY_DOY[c].get(d.dayofyear, tr[c].mean())) for d in fdf.ds]
    vol = np.asarray(forecast_of(MODELS[CHAMP](tr, HZ_H, fdf)), dtype=float)
    hist = s[s.ds < fut.ds.iloc[0]]
    cpv = per_vehicle_by_dow(hist)
    for i, d in enumerate(fut.ds):
        actual = s.loc[s.ds == d, "co2"]
        if actual.empty:
            continue
        rows.append({"h": i + 1, "ds": d, "actual": float(actual.iloc[0]), "pred": vol[i] * cpv[d.dayofweek]})
    print(f"  origin {oi}/{len(origins)}  {fut.ds.iloc[0].date()} -> {fut.ds.iloc[-1].date()}")

r = pd.DataFrame(rows)
ins = s[s.ds < df.ds.iloc[origins[0]]].co2.values
mase_den = np.mean(np.abs(ins[SEASON:] - ins[:-SEASON]))
buckets = [(1, 7), (8, 14), (15, 30), (31, 60), (61, 90)]
report = {"protocol": {"origins": len(origins), "horizon": HZ_H, "step": HZ_STEP, "volume_model": CHAMP,
                       "mase_denominator_t": mase_den}, "horizon": []}
print(f"\n  MASE denominator (seasonal naive, {len(ins)} training days): {mase_den:.1f} t")
print(f"  {'range':<8} {'derived WMAPE':>14} {'MASE':>6}   {'GBR WMAPE':>10} {'MASE':>6}   {'naive':>6}")
for lo_h, hi_h in buckets:
    b = r[(r.h >= lo_h) & (r.h <= hi_h)]
    err = np.abs(b.pred - b.actual)
    wmape = err.sum() / b.actual.sum() * 100
    mase = err.mean() / mase_den
    g = gbr[(gbr.h_lo == lo_h) & (gbr.h_hi == hi_h)]
    gw = float(g.wmape.iloc[0]) if len(g) else float("nan")
    gm = float(g.mase.iloc[0]) if len(g) else float("nan")
    gb = float(g.baseline_wmape.iloc[0]) if len(g) else float("nan")
    print(f"  d{lo_h}-{hi_h:<5} {wmape:>13.2f}% {mase:>6.3f}   {gw:>9.2f}% {gm:>6.3f}   {gb:>5.2f}%")
    report["horizon"].append({"h_lo": lo_h, "h_hi": hi_h, "n": int(len(b)), "derived_wmape": wmape, "derived_mase": mase,
                              "gbr_wmape": gw, "gbr_mase": gm, "baseline_wmape": gb})

# The 80/20 holdout the dashboard scores both on: the volume champion's holdout forecast x CO2 per
# vehicle by weekday from the 8 weeks before the holdout starts.
if len(hold):
    cpv = per_vehicle_by_dow(s[s.ds < hold.ds.min()])
    hold["derived"] = hold.vol * hold.ds.dt.dayofweek.map(cpv)
    w = lambda p: float(np.abs(hold[p] - hold.actual).sum() / hold.actual.sum() * 100)
    report["holdout"] = {"days": int(len(hold)), "from": str(hold.ds.min().date()), "to": str(hold.ds.max().date()),
                         "derived_wmape": w("derived"), "gbr_wmape": w("gbr")}
    print(f"\n  80/20 holdout, {len(hold)} days {hold.ds.min().date()} -> {hold.ds.max().date()}: "
          f"derived WMAPE {w('derived'):.2f}%   GBR {w('gbr'):.2f}%")

out = WORK / "outputs" / "co2_derived_forecast_study.json"
out.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
print(f"\nreport: {out}")
