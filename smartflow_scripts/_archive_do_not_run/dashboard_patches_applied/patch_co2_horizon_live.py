raise SystemExit(
    "ARCHIVED - do not run. Edits the dashboard source in place; its change is already applied. Kept only as a record; see smartflow_scripts/README.md.")

import io

p = (r"C:\Users\Hans\.gemini\antigravity\scratch\Front-and-back-Ver1-Merged-BE-FE"
     r"\Front-and-back-Ver1-Merged-BE-FE\train_emissions.py")
s = io.open(p, encoding="utf-8").read()

# 1. Generalise the rollout so the horizon study and the served projection use
#    the SAME code path. Two implementations would be two chances to diverge.
old_sig = '''def project(mname, mfn):
    """Roll one model forward FUT days past the end of the data.'''
assert old_sig in s
new_sig = '''def project(mname, mfn, hist0=None, horizon_ds=None, clim_tbl=None):
    """Roll one model forward past the end of `hist0` (default: all data).

    Also used by the horizon study below, so the accuracy that gets published is
    measured on the exact procedure that produces the served line.'''
s = s.replace(old_sig, new_sig, 1)

s = s.replace('''    if mname == "LSTM":
        frame = pd.DataFrame({"ds": fut_ds})
        return [float(v) for v in mfn(d, frame)]

    hist, out = d.copy(), []
    for ds in fut_ds:
        k = ds.dayofyear
        r = clim.loc[k] if k in clim.index else d[["rain", "temp"]].mean()''',
'''    base = d if hist0 is None else hist0
    window = fut_ds if horizon_ds is None else horizon_ds
    ctab = clim if clim_tbl is None else clim_tbl

    if mname == "LSTM":
        return [float(v) for v in mfn(base, pd.DataFrame({"ds": list(window)}))]

    hist, out = base.copy(), []
    for ds in window:
        k = ds.dayofyear
        r = ctab.loc[k] if k in ctab.index else base[["rain", "temp"]].mean()''', 1)

# 2. Replace the transcribed constants with a live measurement.
start = s.index("CO2_HORIZON = [")
end = s.index("for lo, hi, wm, mp, ms, mae_, bw, ok, note in CO2_HORIZON:")
end = s.index("\n", s.index("(CHAMPION, lo, hi, wm, mp, ms, mae_, bw, ok, note))", end)) + 1

live = '''# MEASURED HERE, not transcribed. An earlier version pasted the numbers from a
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

print(f"\\n  MASE denominator (seasonal naive on {len(_ins)} training days): {hz_scale:.2f} t")
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
'''
s = s[:start] + live + s[end:]

io.open(p, "w", encoding="utf-8").write(s)
print("horizon accuracy now computed, not transcribed")
