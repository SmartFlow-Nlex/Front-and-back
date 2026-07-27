"""
STAGE 13 - PANEL B: SPATIAL INCIDENT MODELS
===========================================
Rebuilds the spatial panel on 2 km corridor segments instead of the 13 exit
catchments. Reasons:
  * mgwr's bandwidth search needs more spatial units than 13 (it overran n).
  * The diagram's deliverable is a "Top-10 highest-risk segments" list -
    10-of-13 is not a ranking.
  * 279 distinct km posts are present in the data, so 2 km resolution is real,
    not interpolated detail.

Segment coordinates are interpolated along the corridor from bronze.exits
(km -> lat/lon), used only as GWR/Spatial-LSTM coordinates, not as predictors.

Models:  GWR (daily risk surface)  |  Spatial LSTM (next-day vector forecast)
Target:  incident_count per segment per day
"""
import os
import sys
import json
import warnings
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
os.environ["TF_ENABLE_ONEDNN_OPTS"] = "0"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from incident_metrics import compute_metrics, split_r2, average_folds

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "outputs", "dataset")
OUT = os.path.join(HERE, "outputs", "models")
os.makedirs(DATA, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

SEED = 42
BIN_KM = 2.0
SEASONALITY_D = 7          # weekly naive benchmark for daily data
np.random.seed(SEED)

EXIT_KM = {
    "Balintawak": 5.0, "NLEX Harbor Link": 8.0, "Paso De Blas Valenzuela": 11.0,
    "Meycauayan": 18.0, "Marilao": 21.0, "Bocaue Interchange": 26.0,
    "Bocaue Barrier": 28.0, "Cdv/Ph Arena": 29.0, "Tambubong": 31.0,
    "Balagtas": 33.0, "Tabang Guiguinto": 39.0, "Sta. Rita Guiguinto": 42.0,
    "Pulilan": 50.0, "San Simon": 62.0, "San Fernando": 72.0,
    "Mexico": 79.0, "Angeles": 88.0, "Dau": 93.0, "Sctex": 96.0, "Sta. Ines": 99.0,
}


def wf_splits(n, n_folds=3, min_train=0.76, test_frac=0.08):
    # Same placement as 13_train_incident_models.py: the final fold ends flush
    # against the data edge so the most recent period is actually evaluated.
    out, ts, mt = [], int(n * test_frac), int(n * min_train)
    for i in range(n_folds):
        tr_e = mt + i * ts
        te_e = min(tr_e + ts, n)
        if tr_e >= n or te_e <= tr_e:
            break
        out.append((0, tr_e, tr_e, te_e))
    return out


def record(name, target, folds, meta, extra=None):
    res = {
        "model": name, "target": target, "task": "count regression",
        "validation": "3-fold expanding-window walk-forward",
        "metrics": average_folds([f["m"] for f in folds]),
        "split_r2_diagnostic": average_folds([f["s"] for f in folds]),
        "per_fold": [{"fold": i + 1, **f["m"], **f["s"]} for i, f in enumerate(folds)],
        "folds_meta": meta,
    }
    if extra:
        res.update(extra)
    path = f"{OUT}/{name.lower().replace(' ', '_')}_results.json"
    with open(path, "w") as fh:
        json.dump(res, fh, indent=4, default=str)
    m, s = res["metrics"], res["split_r2_diagnostic"]
    print(f"    -> MAE={m['MAE']} RMSE={m['RMSE']} PoisDev={m['Poisson_Deviance']} "
          f"MASE={m['MASE']} R2={m['R2']} | TrainR2={s['Train_R2']} "
          f"ValR2={s['Val_R2']} Gap={s['Gap']}")
    return res


def build_panel():
    """Daily counts per 2 km corridor segment, dense (zero days included)."""
    import psycopg2
    inc = pd.read_csv(f"{DATA}/incidents_raw_unified.csv", parse_dates=["dt"])
    inc = inc.dropna(subset=["km_value"])
    inc["seg_km"] = (np.floor(inc["km_value"] / BIN_KM) * BIN_KM).astype(float)

    # keep segments with enough history to model at all
    counts = inc["seg_km"].value_counts()
    keep = sorted(counts[counts >= 100].index)
    inc = inc[inc["seg_km"].isin(keep)]
    print(f"  segments: {len(keep)} x {BIN_KM}km "
          f"(km {min(keep):.0f}-{max(keep) + BIN_KM:.0f}), "
          f"{len(inc)} incidents retained")

    # interpolate lat/lon along the corridor from the 20 known exits
    with psycopg2.connect(os.environ["PGURL"]) as conn:
        ex = pd.read_sql("SELECT name, latitude, longitude FROM bronze.exits", conn)
    ex["km"] = ex["name"].map(EXIT_KM)
    ex = ex.dropna(subset=["km"]).sort_values("km")
    seg_lat = np.interp(keep, ex["km"], ex["latitude"])
    seg_lon = np.interp(keep, ex["km"], ex["longitude"])
    geo = pd.DataFrame({"seg_km": keep, "latitude": seg_lat, "longitude": seg_lon})

    days = pd.date_range(inc["dt"].min(), inc["dt"].max(), freq="D")
    idx = pd.MultiIndex.from_product([days, keep], names=["dt", "seg_km"])
    panel = pd.DataFrame(index=idx).reset_index()
    agg = inc.groupby(["dt", "seg_km"]).size().reset_index(name="incident_count")
    panel = panel.merge(agg, on=["dt", "seg_km"], how="left")
    panel["incident_count"] = panel["incident_count"].fillna(0).astype(int)
    panel = panel.merge(geo, on="seg_km", how="left")

    panel["day_of_week"] = panel["dt"].dt.dayofweek
    panel["month"] = panel["dt"].dt.month
    panel["is_weekend"] = (panel["day_of_week"] >= 5).astype(int)
    panel["dow_sin"] = np.sin(2 * np.pi * panel["day_of_week"] / 7)
    panel["dow_cos"] = np.cos(2 * np.pi * panel["day_of_week"] / 7)
    panel["month_sin"] = np.sin(2 * np.pi * panel["month"] / 12)
    panel["month_cos"] = np.cos(2 * np.pi * panel["month"] / 12)

    panel = panel.sort_values(["seg_km", "dt"]).reset_index(drop=True)
    g = panel.groupby("seg_km")["incident_count"]
    panel["lag_1d"] = g.shift(1).fillna(0)
    panel["lag_7d"] = g.shift(7).fillna(0)
    panel["roll_7d"] = g.transform(lambda x: x.shift(1).rolling(7, min_periods=1).mean()).fillna(0)
    panel["roll_30d"] = g.transform(lambda x: x.shift(1).rolling(30, min_periods=1).mean()).fillna(0)

    panel.to_csv(f"{DATA}/incidents_daily_segment_2km.csv", index=False)
    print(f"  panel: {len(panel)} rows, {len(days)} days x {len(keep)} segments")
    print(f"  mean={panel['incident_count'].mean():.3f} "
          f"var={panel['incident_count'].var():.3f} "
          f"zero-days={(panel['incident_count'] == 0).mean() * 100:.1f}%")
    return panel, keep


def run_gwr(panel, segs):
    from mgwr.gwr import GWR
    from mgwr.sel_bw import Sel_BW

    print("\n  [8] GWR (Geographically Weighted Regression)")
    days = np.sort(panel["dt"].unique())
    splits = wf_splits(len(days))
    meta = [{"fold": i + 1, "train_days": e1 - s1, "test_days": e2 - s2}
            for i, (s1, e1, s2, e2) in enumerate(splits)]

    folds, surface = [], None
    for (s1, e1, s2, e2) in splits:
        tr = panel[panel["dt"].isin(days[s1:e1])]
        te = panel[panel["dt"].isin(days[s2:e2])]

        # cross-section: one row per segment = mean daily incidents in the window
        cs = (tr.groupby(["seg_km", "latitude", "longitude"], as_index=False)
                ["incident_count"].mean())
        coords = np.column_stack([cs["longitude"].values, cs["latitude"].values])
        y = cs["incident_count"].values.reshape(-1, 1)
        X = cs[["seg_km"]].values.astype(float)
        n = len(cs)

        # bound the adaptive bandwidth inside n - mgwr's default upper bound
        # overshoots on small cross-sections
        bw = Sel_BW(coords, y, X, fixed=False).search(
            criterion="AICc", bw_min=max(5, int(0.2 * n)), bw_max=n - 1)
        g = GWR(coords, y, X, bw, fixed=False)
        gr = g.fit()

        rate = dict(zip(cs["seg_km"], np.clip(gr.predy.ravel(), 0, None)))
        ptr = tr["seg_km"].map(rate).values
        pte = te["seg_km"].map(rate).values
        ytr = tr["incident_count"].values.astype(float)
        yte = te["incident_count"].values.astype(float)

        surface = {
            "bandwidth_nearest_neighbours": int(bw),
            "n_segments": int(n),
            "local_R2_mean": round(float(np.mean(gr.localR2)), 4),
            "per_segment": {
                f"km {int(k)}-{int(k + BIN_KM)}": {
                    "fitted_daily_rate": round(float(gr.predy[i, 0]), 4),
                    "intercept": round(float(gr.params[i, 0]), 5),
                    "beta_seg_km": round(float(gr.params[i, 1]), 5),
                    "local_R2": round(float(gr.localR2[i]), 4),
                } for i, k in enumerate(cs["seg_km"])
            },
        }
        folds.append({"m": compute_metrics(yte, pte, ytr, 1, SEASONALITY_D),
                      "s": split_r2(ytr, ptr, yte, pte)})

    return record("GWR", "incident_count_daily_per_2km_segment", folds, meta,
                  {"gwr_surface_last_fold": surface,
                   "note": "spatial risk surface; per-segment expected daily count"})


def run_spatial_lstm(panel, segs):
    from tensorflow import keras
    from tensorflow.keras import layers
    from sklearn.preprocessing import StandardScaler

    print("  [9] Spatial LSTM (all segments forecast jointly, next-day)")
    mat = panel.pivot_table(index="dt", columns="seg_km",
                            values="incident_count", aggfunc="sum").fillna(0)
    M = mat.values.astype(float)                      # (days, n_segments)
    cal = (panel.drop_duplicates("dt").set_index("dt")
                .loc[mat.index, ["dow_sin", "dow_cos", "month_sin",
                                 "month_cos", "is_weekend"]].values.astype(float))
    T, S = M.shape
    splits = wf_splits(T)
    meta = [{"fold": i + 1, "train_days": e1 - s1, "test_days": e2 - s2}
            for i, (s1, e1, s2, e2) in enumerate(splits)]

    LOOK = 30
    folds = []
    for (a1, b1, a2, b2) in splits:
        sc = StandardScaler()
        Ftr = np.hstack([sc.fit_transform(M[a1:b1]), cal[a1:b1]])
        Fte = np.hstack([sc.transform(M[a2:b2]), cal[a2:b2]])

        def win(F, Y):
            return np.stack([F[i - LOOK:i] for i in range(LOOK, len(F))]), Y[LOOK:]

        Wtr, Ytr = win(Ftr, M[a1:b1])
        Wte, Yte = win(np.vstack([Ftr[-LOOK:], Fte]),
                       np.vstack([M[b1 - LOOK:b1], M[a2:b2]]))

        keras.utils.set_random_seed(SEED)
        net = keras.Sequential([
            keras.Input(shape=(LOOK, Wtr.shape[2])),
            layers.LSTM(96, return_sequences=True),
            layers.Dropout(0.2),
            layers.LSTM(48),
            layers.Dropout(0.2),
            layers.Dense(S, activation="softplus"),
        ])
        net.compile(optimizer=keras.optimizers.Adam(1e-3), loss="poisson")
        net.fit(Wtr, Ytr, epochs=80, batch_size=32, verbose=0, validation_split=0.1,
                callbacks=[keras.callbacks.EarlyStopping(patience=10,
                                                         restore_best_weights=True)])
        ptr = np.clip(net.predict(Wtr, verbose=0), 0, None).ravel()
        pte = np.clip(net.predict(Wte, verbose=0), 0, None).ravel()
        folds.append({"m": compute_metrics(Yte.ravel(), pte, Ytr.ravel(),
                                           S + 5, SEASONALITY_D),
                      "s": split_r2(Ytr.ravel(), ptr, Yte.ravel(), pte)})

    return record("Spatial LSTM", "incident_count_daily_per_2km_segment", folds, meta,
                  {"n_segments": int(S),
                   "note": "multivariate LSTM; forecasts all segments jointly 1 day ahead"})


def main():
    print("=" * 78)
    print("  STAGE 13 - PANEL B SPATIAL MODELS (2km corridor segments)")
    print("=" * 78)
    panel, segs = build_panel()
    res = {}
    res["GWR"] = run_gwr(panel, segs)
    res["Spatial_LSTM"] = run_spatial_lstm(panel, segs)

    # merge with Panel A results already on disk
    allr = {}
    for key, fname in [("Poisson_GLM", "poisson_glm"),
                       ("Negative_Binomial", "negative_binomial_glm"),
                       ("Random_Forest", "random_forest"),
                       ("XGBoost", "xgboost"),
                       ("SARIMAX", "sarimax"),
                       ("LSTM", "lstm"), ("GRU", "gru")]:
        p = f"{OUT}/{fname}_results.json"
        if os.path.exists(p):
            allr[key] = json.load(open(p))
    allr.update(res)

    with open(f"{OUT}/all_incident_models.json", "w") as fh:
        json.dump(allr, fh, indent=4, default=str)

    rows = []
    for v in allr.values():
        m, s = v["metrics"], v["split_r2_diagnostic"]
        rows.append({"Model": v["model"], "Target": v["target"], **m,
                     "Train_R2": s["Train_R2"], "Val_R2": s["Val_R2"], "Gap": s["Gap"]})
    pd.DataFrame(rows).to_csv(f"{OUT}/incident_models_metrics.csv", index=False)
    print(f"\n  {len(allr)} models saved -> {OUT}")


if __name__ == "__main__":
    main()
