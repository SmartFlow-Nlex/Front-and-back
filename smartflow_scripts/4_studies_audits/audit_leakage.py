"""
Does the CO2 forecast lean on weather it could not know?

FEATS includes `rain` and `temp` UNLAGGED, so when scoring day t+3 the model is
handed day t+3's OBSERVED rainfall. In deployment that value does not exist yet.
Every other feature is correctly shifted (lags, roll7/roll28, heavy_share) or is
calendar (dow, month, t), which is knowable in advance.

This re-runs the identical rolling-origin protocol with the forecast window's
weather replaced by day-of-year CLIMATOLOGY computed from the TRAINING data only
— i.e. what a forecaster would actually have. The gap between the two is the
size of the optimism in the published metrics.

LSTM is univariate (it reads only y), so it is unaffected and acts as a control.
"""
import io, warnings
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

src = io.open(_EMIS, encoding="utf-8").read().split('banner(f"STEP 3')[0]
ns = {"__name__": "prep", "__file__": _EMIS}
exec(compile(src, "prep", "exec"), ns)
d, origins, HORIZON, SEASON = ns["d"], ns["origins"], ns["HORIZON"], ns["SEASON"]
fit_gbr, fit_poly, FEATS = ns["fit_gbr"], ns["fit_poly"], ns["FEATS"]

print(f"\nfeatures: {FEATS}")
print("unlagged weather in features:", [f for f in FEATS if f in ("rain", "temp")])

MODELS = {"Polynomial": fit_poly, "GBR": fit_gbr}
preds = {m: {k: {} for k in ("observed", "climatology")} for m in MODELS}

for cut in origins:
    tr, fut = d.iloc[:cut], d.iloc[cut:cut + HORIZON]
    if len(fut) < HORIZON:
        break

    # Climatology from TRAINING data only — no peeking past the origin.
    clim = tr.assign(k=tr.ds.dt.dayofyear).groupby("k")[["rain", "temp"]].mean()
    fut_clim = fut.copy()
    for col in ("rain", "temp"):
        fut_clim[col] = [
            float(clim[col].loc[k]) if k in clim.index else float(tr[col].mean())
            for k in fut.ds.dt.dayofyear
        ]

    for name, fn in MODELS.items():
        for tag, frame in (("observed", fut), ("climatology", fut_clim)):
            for ds, v in zip(fut.ds, fn(tr, frame)):
                preds[name][tag][ds] = float(v)

truth = d.set_index("ds").y
ins = d.y.values[:origins[0]]
scale = np.mean(np.abs(ins[SEASON:] - ins[:-SEASON]))


def score(pm):
    idx = sorted(pm)
    a = truth.loc[idx].values
    f = np.array([pm[i] for i in idx])
    e = np.abs(a - f)
    return {
        "MAPE": np.mean(e / np.abs(a)) * 100,
        "WMAPE": e.sum() / np.abs(a).sum() * 100,
        "MAE": e.mean(),
        "MASE": e.mean() / scale,
        "R2": 1 - ((a - f) ** 2).sum() / ((a - a.mean()) ** 2).sum(),
    }


print(f"\nscored days: {len(preds['Polynomial']['observed'])}\n")
print(f"{'model':<12}{'weather input':<16}{'MAPE%':>9}{'WMAPE%':>9}{'MAE t':>9}{'MASE':>8}{'R2':>9}")
for name in MODELS:
    got = {}
    for tag in ("observed", "climatology"):
        s = score(preds[name][tag])
        got[tag] = s
        lbl = "OBSERVED (leak)" if tag == "observed" else "climatology"
        print(f"{name:<12}{lbl:<16}{s['MAPE']:>9.2f}{s["WMAPE"]:>11.4f}"
              f"{s["MAE"]:>12.5f}{s['MASE']:>8.3f}{s['R2']:>9.4f}")
    dw = got["climatology"]["WMAPE"] - got["observed"]["WMAPE"]
    dm = got["climatology"]["MASE"] - got["observed"]["MASE"]
    print(f"{'':<12}{'-> optimism':<16}{'':>9}{dw:>+9.2f}{'':>9}{dm:>+8.3f}")
    still = got["climatology"]["MASE"] < 1.0 and got["climatology"]["WMAPE"] < 16.00
    print(f"{'':<12}still passes both gates without the leak: {still}\n")
