raise SystemExit(
    "ARCHIVED - do not run. Edits the dashboard source in place; its change is already applied. Kept only as a record; see smartflow_scripts/README.md.")

import io, re

p = (r"C:\Users\Hans\.gemini\antigravity\scratch\Front-and-back-Ver1-Merged-BE-FE"
     r"\Front-and-back-Ver1-Merged-BE-FE\train_emissions.py")
s = io.open(p, encoding="utf-8").read()

# Replace the whole single-champion future block with one that projects EVERY
# candidate. Bounded by the two markers so the surrounding code is untouched.
start = s.index("clim = d.assign(k=d.ds.dt.dayofyear)")
end = s.index('cur.execute("""\n  CREATE TABLE IF NOT EXISTS gold.ml_predictive_emissions')
old = s[start:end]

new = '''# Future weather is day-of-year climatology, not observation - the same
# assumption the scored window now uses, and stated on the panel.
clim = d.assign(k=d.ds.dt.dayofyear).groupby("k")[["rain", "temp"]].mean()


def project(mname, mfn):
    """Roll one model forward FUT days past the end of the data.

    Every candidate is projected, not just the leader. Storing a future for the
    champion alone left the panel with no forecast line whenever the reader
    selected another model - and with Polynomial and GBR tied, "the champion"
    is not even a well-defined single model any more.

    LSTM is recursive by construction (it feeds its own output back inside
    fit_lstm), so it is called once for the whole window. The feature-based
    models need the loop: day 2's lag-1 IS day 1's prediction.
    """
    if mname == "LSTM":
        frame = pd.DataFrame({"ds": fut_ds})
        return [float(v) for v in mfn(d, frame)]

    hist, out = d.copy(), []
    for ds in fut_ds:
        k = ds.dayofyear
        r = clim.loc[k] if k in clim.index else d[["rain", "temp"]].mean()
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

'''

s = s[:start] + new + s[end:]

# Persist all three future columns instead of only the champion's.
old_ins = s[s.index('CH_COL = {"GBR"'):s.index('conn.commit()')]
new_ins = '''for i, ds in enumerate(fut_ds):
    cur.execute("""INSERT INTO gold.ml_predictive_emissions
        (forecast_date, actual_co2, pred_gbr, pred_polynomial, pred_lstm,
         champion_model, is_holdout, is_future)
        VALUES (%s,NULL,%s,%s,%s,%s,false,true)""",
        (ds.date(), fut_pred["GBR"][i], fut_pred["Polynomial"][i],
         fut_pred["LSTM"][i], CHAMPION))
'''
s = s.replace(old_ins, new_ins)

io.open(p, "w", encoding="utf-8").write(s)
print("patched: all candidates projected into the future window")
