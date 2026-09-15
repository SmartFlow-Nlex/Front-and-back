raise SystemExit(
    "ARCHIVED - do not run. Edits the dashboard source in place; its change is already applied. Kept only as a record; see smartflow_scripts/README.md.")

import io

p = (r"C:\Users\Hans\.gemini\antigravity\scratch\Front-and-back-Ver1-Merged-BE-FE"
     r"\Front-and-back-Ver1-Merged-BE-FE\train_emissions.py")
s = io.open(p, encoding="utf-8").read()

pairs = [

# ── 1. The fix itself ────────────────────────────────────────────────────────
('MODELS = {"GBR": fit_gbr, "Polynomial": fit_poly, "LSTM": fit_lstm}',
 '''MODELS = {"GBR": fit_gbr, "Polynomial": fit_poly, "LSTM": fit_lstm}

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
    return out'''),

('''    for name, fn in MODELS.items():
        try:
            yh = fn(tr, fut)''',
 '''    fut_known = climatize(tr, fut)      # never observed future weather
    for name, fn in MODELS.items():
        try:
            yh = fn(tr, fut_known)'''),

# The cache must not serve predictions built under the old, leaky protocol.
('CACHE_KEY = (len(d), str(d.ds.max().date()), N_ORIGINS, HORIZON, tuple(MODELS))',
 'CACHE_KEY = ("climatology-weather-v2", len(d), str(d.ds.max().date()), N_ORIGINS, HORIZON, tuple(MODELS))'),

# ── 2. Report ties rather than ranking on noise ──────────────────────────────
('res["rank"] = np.where(res.is_candidate, res.groupby("is_candidate").cumcount() + 1, None)',
 '''res["rank"] = np.where(res.is_candidate, res.groupby("is_candidate").cumcount() + 1, None)

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
    print(f"\\n  TIE ({detail}) - within {TIE_MARGIN_WMAPE}pp WMAPE.")
    print("  Ordering between these is not meaningful; they are co-champions.")'''),

# ── 3. Persist the two new columns ───────────────────────────────────────────
('''          (model_name,target,rmse,mae,wmape,r2,mase,mape,rank,accepted,rejected_reason,uses_weather,updated_at)
        VALUES (%s,'Corridor CO2',%s,%s,%s,%s,%s,%s,%s,%s,%s,true,now())""",
        (r.model, r.rmse, r.mae, r.wmape, r.r2, r.mase, r.mape,
         int(r.rank) if r.is_candidate else None, bool(r.accepted), reason))''',
 '''          (model_name,target,rmse,mae,wmape,r2,mase,mape,rank,accepted,rejected_reason,uses_weather,diagnosis,updated_at)
        VALUES (%s,'Corridor CO2',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())""",
        (r.model, r.rmse, r.mae, r.wmape, r.r2, r.mase, r.mape,
         int(r.rank) if r.is_candidate else None, bool(r.accepted), reason,
         USES_WEATHER.get(r.model, False), r.diagnosis))'''),
]

for a, b in pairs:
    assert a in s, "MISSING: " + a[:80]
    s = s.replace(a, b, 1)

io.open(p, "w", encoding="utf-8").write(s)
print("patched train_emissions.py")
