"""
How far ahead can the corridor CO2 forecast actually see?

The panel projects 7 days because the modelling diagram says "7-day CO2 corridor
forecast". That is a specification, not a measurement - nothing tested whether 7
is where the skill runs out.

WHY THIS MIGHT NOT BEHAVE LIKE THE TRAFFIC FORECAST
  Prophet held out to 90 days because it is STRUCTURAL: trend plus weekly and
  yearly seasonality, evaluated directly at any date, so it never consumes its
  own output. The CO2 models are LAG-BASED (lag1..lag28, roll7, roll28). Beyond
  one step they must be rolled forward recursively, feeding predictions back in
  as inputs, so error compounds. The honest expectation is that CO2 degrades
  much faster than volume did.

PROTOCOL
  Rolling origin. Fit once per origin on data up to that point - as in
  deployment, where you do not refit mid-forecast - then roll 90 days forward,
  each day's prediction becoming the next day's lag. Weather over the whole
  window is day-of-year climatology from the training slice only.

GATES (the project's usual pair)
  A horizon is usable if WMAPE beats the better trivial baseline AND MASE < 1.
"""
import io
_EMIS = str(__import__("pathlib").Path(__file__).resolve().parents[1] / "3_training_testing" / "emissions" / "train_emissions.py")
import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

H = 90
STEP = 30
N_ORIGINS = 9
SEASON = 7
BUCKETS = [(1, 7), (8, 14), (15, 30), (31, 60), (61, 90)]

src = io.open(_EMIS, encoding="utf-8").read().split('banner(f"STEP 3')[0]
ns = {"__name__": "prep", "__file__": _EMIS}
exec(compile(src, "prep", "exec"), ns)
d, FEATS, LAGS = ns["d"], ns["FEATS"], ns["LAGS"]
fit_poly, fit_gbr = ns["fit_poly"], ns["fit_gbr"]

print(f"\nseries {len(d):,} days  {d.ds.min().date()} -> {d.ds.max().date()}")

origins = [len(d) - (N_ORIGINS - i) * STEP - H for i in range(N_ORIGINS)]
origins = [o for o in origins if o > 400]
print(f"{len(origins)} origins, H={H}d, step={STEP}d")
print(f"first {d.ds.iloc[origins[0]].date()}  last {d.ds.iloc[origins[-1]].date()}\n")


def roll(fn, tr, fut_ds, clim):
    """Recursive multi-step: each prediction becomes the next day's lag."""
    hist = tr.copy()
    out = []
    for ds in fut_ds:
        k = ds.dayofyear
        r = clim.loc[k] if k in clim.index else tr[["rain", "temp"]].mean()
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
        yhat = float(fn(hist, pd.DataFrame([row]))[0])
        out.append(yhat)
        row["y"] = yhat
        hist = pd.concat([hist, pd.DataFrame([{**row, "veh": hist.veh.iloc[-1],
                                               "heavy": hist.heavy.iloc[-1]}])],
                         ignore_index=True)
    return np.array(out)


rows = []
for oi, cut in enumerate(origins, 1):
    tr, fut = d.iloc[:cut], d.iloc[cut:cut + H]
    if len(fut) < H:
        continue
    clim = tr.assign(k=tr.ds.dt.dayofyear).groupby("k")[["rain", "temp"]].mean()
    yh = roll(fit_poly, tr, list(fut.ds), clim)

    last_week = tr.y.values[-SEASON:]
    snaive = np.array([last_week[i % SEASON] for i in range(H)])
    doy = tr.assign(k=tr.ds.dt.dayofyear).groupby("k").y.mean()
    climo = np.array([float(doy.get(k, tr.y.mean())) for k in fut.ds.dt.dayofyear])

    for i in range(H):
        a = float(fut.y.iloc[i])
        rows.append(("Polynomial", i + 1, a, float(yh[i])))
        rows.append(("SeasonalNaive", i + 1, a, float(snaive[i])))
        rows.append(("Climatology", i + 1, a, float(climo[i])))
    print(f"  origin {oi}/{len(origins)}  {fut.ds.iloc[0].date()} -> {fut.ds.iloc[-1].date()}")

r = pd.DataFrame(rows, columns=["model", "h", "a", "f"])
r["e"] = (r.a - r.f).abs()
ins = d.y.values[:origins[0]]
scale = np.mean(np.abs(ins[SEASON:] - ins[:-SEASON]))
print(f"\nMASE denominator (seasonal-naive lag-7 MAE, {len(ins)} days): {scale:.2f} t\n")


def stat(g):
    return {"n": len(g), "WMAPE": g.e.sum() / g.a.sum() * 100,
            "MAPE": (g.e / g.a).mean() * 100, "MASE": g.e.mean() / scale,
            "MAE": g.e.mean()}


print("ERROR BY HOW FAR AHEAD THE DAY WAS")
print(f"  {'horizon':<10}{'model':<16}{'WMAPE%':>9}{'MAPE%':>8}{'MASE':>8}{'MAE t':>9}   verdict")
for lo, hi in BUCKETS:
    sub = r[(r.h >= lo) & (r.h <= hi)]
    base = min(stat(sub[sub.model == m])["WMAPE"] for m in ("SeasonalNaive", "Climatology"))
    for m in ("Polynomial", "SeasonalNaive", "Climatology"):
        s = stat(sub[sub.model == m])
        v = ("USABLE" if (s["WMAPE"] < base and s["MASE"] < 1.0) else "FAILS GATES") \
            if m == "Polynomial" else "baseline"
        print(f"  {f'd{lo}-{hi}':<10}{m:<16}{s['WMAPE']:>9.2f}{s['MAPE']:>8.2f}"
              f"{s['MASE']:>8.3f}{s['MAE']:>9.1f}   {v}")
    print()

print("CUMULATIVE — what a projection of length L is worth end to end")
print(f"  {'length':<10}{'WMAPE%':>9}{'MASE':>8}   verdict")
for L in (7, 14, 30, 60, 90):
    sub = r[r.h <= L]
    p = stat(sub[sub.model == "Polynomial"])
    base = min(stat(sub[sub.model == m])["WMAPE"] for m in ("SeasonalNaive", "Climatology"))
    ok = p["WMAPE"] < base and p["MASE"] < 1.0
    print(f"  {f'{L}d':<10}{p['WMAPE']:>9.2f}{p['MASE']:>8.3f}   "
          f"{'USABLE' if ok else 'FAILS GATES'}  (baseline {base:.2f}%)")
