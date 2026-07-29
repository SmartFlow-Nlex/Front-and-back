"""
STAGE 11 - INCIDENT MODELS (per architecture diagram), INCIDENT DATA ONLY
=========================================================================
Data      : bronze.road_crashes + motorcycle_crashes + stalled_vehicles ONLY.
            No weather, no traffic volume, no Waze.
Target    : incident_count (a count) -> count-regression family.
Validation: 3-fold expanding-window walk-forward (no future leakage).
KPIs      : MAE MSE RMSE MAPE sMAPE WMAPE Poisson_Deviance MASE RMSSE R2 Adj_R2
            + split-R2 adviser diagnostic (Train R2 / Val R2 / Gap)

PANEL A - global hourly corridor counts (57,552 rows)
    Poisson GLM  |  Negative Binomial GLM  |  Random Forest  |  XGBoost
    SARIMAX      |  LSTM                   |  GRU

PANEL B - spatial
    GWR          (daily per-segment risk surface, 13 segments)
    Spatial LSTM (hourly, all 13 segments forecast jointly)

NOT RUN: Logistic / Ordinal-logistic / Cox PH. Those are classification and
survival models; none of them produce the regression KPI set above.
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

from sklearn.ensemble import RandomForestRegressor
from sklearn.preprocessing import StandardScaler
import statsmodels.api as sm
import xgboost as xgb

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "outputs", "dataset")
OUT = os.path.join(HERE, "outputs", "models")
os.makedirs(DATA, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

SEED = 42
np.random.seed(SEED)

FEATURES = [
    "hour_sin", "hour_cos", "dow_sin", "dow_cos", "month_sin", "month_cos",
    "is_weekend", "is_rush_hour",
    "inc_lag_1h", "inc_lag_2h", "inc_lag_3h", "inc_lag_24h", "inc_lag_168h",
    "inc_roll_24h", "inc_roll_168h",
]
WARMUP = 168          # drop rows whose 1-week lag is still zero-filled
SEASONALITY = 24      # naive benchmark for MASE/RMSSE on hourly data


def wf_splits(n, n_folds=3, min_train=0.76, test_frac=0.08):
    """
    Expanding-window walk-forward. There is no fixed train/test ratio - the
    training set grows every fold (76% -> 84% -> 92%), so an "80/20 split" does
    not apply to this design.

    min_train is set so that min_train + n_folds*test_frac == 1.00, which places
    the final test fold flush against the end of the data. That matters for two
    reasons: the most recent period is the most relevant one to be judged on, and
    forecasting has to start where validation stops - otherwise the "forecast"
    covers dates that already have actuals.
    """
    out = []
    ts = int(n * test_frac)
    mt = int(n * min_train)
    for i in range(n_folds):
        tr_e = mt + i * ts
        te_e = min(tr_e + ts, n)
        if tr_e >= n or te_e <= tr_e:
            break
        out.append((0, tr_e, tr_e, te_e))
    return out


def record(name, target, folds, splits_meta, extra=None):
    res = {
        "model": name,
        "target": target,
        "task": "count regression",
        "validation": "3-fold expanding-window walk-forward",
        "metrics": average_folds([f["m"] for f in folds]),
        "split_r2_diagnostic": average_folds([f["s"] for f in folds]),
        "per_fold": [{"fold": i + 1, **f["m"], **f["s"]} for i, f in enumerate(folds)],
        "folds_meta": splits_meta,
    }
    if extra:
        res.update(extra)
    path = f"{OUT}/{name.lower().replace(' ', '_').replace('-', '_')}_results.json"
    with open(path, "w") as fh:
        json.dump(res, fh, indent=4, default=str)
    m, s = res["metrics"], res["split_r2_diagnostic"]
    print(f"    -> MAE={m['MAE']} RMSE={m['RMSE']} PoisDev={m['Poisson_Deviance']} "
          f"MASE={m['MASE']} R2={m['R2']} | TrainR2={s['Train_R2']} "
          f"ValR2={s['Val_R2']} Gap={s['Gap']}")
    return res


# ======================================================================
#  PANEL A - GLOBAL HOURLY
# ======================================================================
def panel_a():
    df = pd.read_csv(f"{DATA}/incidents_only_hourly_global.csv", parse_dates=["dt"])
    df = df.sort_values(["dt", "hour_of_day"]).reset_index(drop=True)
    df = df.iloc[WARMUP:].reset_index(drop=True)

    X_all = df[FEATURES].values.astype(float)
    y_all = df["incident_count"].values.astype(float)
    n = len(df)
    splits = wf_splits(n)
    meta = [{"fold": i + 1, "train_rows": e1 - s1, "test_rows": e2 - s2}
            for i, (s1, e1, s2, e2) in enumerate(splits)]

    print(f"\nPANEL A - global hourly | rows={n} | folds={len(splits)}")
    print(f"  mean={y_all.mean():.3f} var={y_all.var():.3f} "
          f"(var/mean={y_all.var()/y_all.mean():.3f}) zero-hours={(y_all==0).mean()*100:.1f}%")
    results = {}

    # ---------------- Poisson GLM ----------------
    print("\n  [1] Poisson GLM")
    folds = []
    for (s1, e1, s2, e2) in splits:
        Xtr, ytr = sm.add_constant(X_all[s1:e1], has_constant="add"), y_all[s1:e1]
        Xte, yte = sm.add_constant(X_all[s2:e2], has_constant="add"), y_all[s2:e2]
        mod = sm.GLM(ytr, Xtr, family=sm.families.Poisson()).fit()
        ptr, pte = mod.predict(Xtr), mod.predict(Xte)
        folds.append({"m": compute_metrics(yte, pte, ytr, len(FEATURES), SEASONALITY),
                      "s": split_r2(ytr, ptr, yte, pte)})
    results["Poisson_GLM"] = record("Poisson GLM", "incident_count", folds, meta)

    # ---------------- Negative Binomial GLM ----------------
    print("  [2] Negative Binomial GLM")
    folds = []
    for (s1, e1, s2, e2) in splits:
        Xtr, ytr = sm.add_constant(X_all[s1:e1], has_constant="add"), y_all[s1:e1]
        Xte, yte = sm.add_constant(X_all[s2:e2], has_constant="add"), y_all[s2:e2]
        # estimate dispersion alpha from the Poisson Pearson chi2, then fit NB2
        pois = sm.GLM(ytr, Xtr, family=sm.families.Poisson()).fit()
        mu = np.clip(pois.predict(Xtr), 1e-6, None)
        alpha = float(np.mean(((ytr - mu) ** 2 - mu) / mu ** 2))
        alpha = min(max(alpha, 1e-4), 10.0)
        mod = sm.GLM(ytr, Xtr,
                     family=sm.families.NegativeBinomial(alpha=alpha)).fit()
        ptr, pte = mod.predict(Xtr), mod.predict(Xte)
        folds.append({"m": compute_metrics(yte, pte, ytr, len(FEATURES), SEASONALITY),
                      "s": split_r2(ytr, ptr, yte, pte)})
    results["Negative_Binomial"] = record("Negative Binomial GLM", "incident_count",
                                          folds, meta, {"nb2_alpha_last_fold": round(alpha, 5)})

    # ---------------- Random Forest ----------------
    print("  [3] Random Forest Regressor")
    folds, imp = [], None
    for (s1, e1, s2, e2) in splits:
        Xtr, ytr = X_all[s1:e1], y_all[s1:e1]
        Xte, yte = X_all[s2:e2], y_all[s2:e2]
        mod = RandomForestRegressor(n_estimators=300, max_depth=12, min_samples_leaf=20,
                                    random_state=SEED, n_jobs=-1)
        mod.fit(Xtr, ytr)
        ptr = np.clip(mod.predict(Xtr), 0, None)
        pte = np.clip(mod.predict(Xte), 0, None)
        imp = dict(zip(FEATURES, [round(float(v), 5) for v in mod.feature_importances_]))
        folds.append({"m": compute_metrics(yte, pte, ytr, len(FEATURES), SEASONALITY),
                      "s": split_r2(ytr, ptr, yte, pte)})
    results["Random_Forest"] = record("Random Forest", "incident_count", folds, meta,
                                      {"feature_importance": imp})

    # ---------------- XGBoost (Poisson objective) ----------------
    print("  [4] XGBoost (count:poisson)")
    folds, imp = [], None
    for (s1, e1, s2, e2) in splits:
        Xtr, ytr = X_all[s1:e1], y_all[s1:e1]
        Xte, yte = X_all[s2:e2], y_all[s2:e2]
        mod = xgb.XGBRegressor(objective="count:poisson", n_estimators=400,
                               max_depth=5, learning_rate=0.05, subsample=0.8,
                               colsample_bytree=0.8, min_child_weight=5,
                               reg_lambda=1.0, random_state=SEED, n_jobs=-1)
        mod.fit(Xtr, ytr)
        ptr = np.clip(mod.predict(Xtr), 0, None)
        pte = np.clip(mod.predict(Xte), 0, None)
        imp = dict(zip(FEATURES, [round(float(v), 5) for v in mod.feature_importances_]))
        folds.append({"m": compute_metrics(yte, pte, ytr, len(FEATURES), SEASONALITY),
                      "s": split_r2(ytr, ptr, yte, pte)})
    results["XGBoost"] = record("XGBoost", "incident_count", folds, meta,
                                {"feature_importance": imp})

    # ---------------- SARIMAX ----------------
    # Hourly seasonal ARIMA on 34k+ points is intractable; the standard substitute
    # is ARIMA errors + Fourier/calendar exogenous terms for the 24h + weekly cycle.
    print("  [5] SARIMAX (ARIMA errors + calendar exog)")
    exog_cols = ["hour_sin", "hour_cos", "dow_sin", "dow_cos",
                 "month_sin", "month_cos", "is_weekend", "is_rush_hour"]
    E_all = df[exog_cols].values.astype(float)
    TAIL = 5000     # trailing training window keeps the MLE tractable
    folds = []
    for (s1, e1, s2, e2) in splits:
        tr_s = max(s1, e1 - TAIL)
        ytr, Etr = y_all[tr_s:e1], E_all[tr_s:e1]
        yte, Ete = y_all[s2:e2], E_all[s2:e2]
        mod = sm.tsa.SARIMAX(ytr, exog=Etr, order=(2, 0, 2),
                             enforce_stationarity=False, enforce_invertibility=False
                             ).fit(disp=False, maxiter=60)
        ptr = np.clip(mod.fittedvalues, 0, None)
        pte = np.clip(mod.forecast(steps=len(yte), exog=Ete), 0, None)
        folds.append({"m": compute_metrics(yte, pte, ytr, len(exog_cols), SEASONALITY),
                      "s": split_r2(ytr, ptr, yte, pte)})
    results["SARIMAX"] = record("SARIMAX", "incident_count", folds, meta,
                                {"note": f"ARIMA(2,0,2)+exog, trailing {TAIL}h train window"})

    # ---------------- LSTM / GRU ----------------
    from tensorflow import keras
    from tensorflow.keras import layers

    def seq_model(kind, splits):
        LOOK = 48
        folds = []
        for (s1, e1, s2, e2) in splits:
            sc = StandardScaler()
            Xtr_s = sc.fit_transform(X_all[s1:e1])
            Xte_s = sc.transform(X_all[s2:e2])

            def windows(Xs, ys):
                a = np.stack([Xs[i - LOOK:i] for i in range(LOOK, len(Xs))])
                return a, ys[LOOK:]

            Wtr, ttr = windows(Xtr_s, y_all[s1:e1])
            # prepend the tail of train so the test set gets full look-back context
            joint = np.vstack([Xtr_s[-LOOK:], Xte_s])
            yj = np.concatenate([y_all[e1 - LOOK:e1], y_all[s2:e2]])
            Wte, tte = windows(joint, yj)

            keras.utils.set_random_seed(SEED)
            cell = layers.LSTM if kind == "LSTM" else layers.GRU
            net = keras.Sequential([
                keras.Input(shape=(LOOK, Wtr.shape[2])),
                cell(64, return_sequences=True),
                layers.Dropout(0.2),
                cell(32),
                layers.Dropout(0.2),
                layers.Dense(16, activation="relu"),
                layers.Dense(1, activation="softplus"),   # counts are non-negative
            ])
            net.compile(optimizer=keras.optimizers.Adam(1e-3), loss="poisson")
            net.fit(Wtr, ttr, epochs=18, batch_size=256, verbose=0,
                    validation_split=0.1,
                    callbacks=[keras.callbacks.EarlyStopping(patience=4,
                                                            restore_best_weights=True)])
            ptr = np.clip(net.predict(Wtr, verbose=0).ravel(), 0, None)
            pte = np.clip(net.predict(Wte, verbose=0).ravel(), 0, None)
            folds.append({"m": compute_metrics(tte, pte, ttr, len(FEATURES), SEASONALITY),
                          "s": split_r2(ttr, ptr, tte, pte)})
        return folds

    print("  [6] LSTM")
    results["LSTM"] = record("LSTM", "incident_count", seq_model("LSTM", splits), meta)
    print("  [7] GRU")
    results["GRU"] = record("GRU", "incident_count", seq_model("GRU", splits), meta)

    return results


# ======================================================================
#  PANEL B - SPATIAL
# ======================================================================
def panel_b():
    results = {}

    # ---------------- GWR : daily per-segment risk surface ----------------
    print("\nPANEL B - spatial")
    print("\n  [8] GWR (Geographically Weighted Regression)")
    from mgwr.gwr import GWR
    from mgwr.sel_bw import Sel_BW

    d = pd.read_csv(f"{DATA}/incidents_only_daily_segment.csv", parse_dates=["dt"])
    d = d.sort_values(["dt", "nearest_exit"]).reset_index(drop=True)
    days = np.sort(d["dt"].unique())
    dsplits = wf_splits(len(days))
    meta = [{"fold": i + 1, "train_days": e1 - s1, "test_days": e2 - s2}
            for i, (s1, e1, s2, e2) in enumerate(dsplits)]

    folds, coef_map = [], None
    for (s1, e1, s2, e2) in dsplits:
        tr = d[d["dt"].isin(days[s1:e1])]
        te = d[d["dt"].isin(days[s2:e2])]

        # cross-section: one row per segment = mean daily incidents over the window
        cs = (tr.groupby(["nearest_exit", "latitude", "longitude", "exit_km"],
                         as_index=False)["incident_count"].mean())
        coords = np.column_stack([cs["longitude"].values, cs["latitude"].values])
        y = cs["incident_count"].values.reshape(-1, 1)
        X = cs[["exit_km"]].values.astype(float)

        bw = Sel_BW(coords, y, X, fixed=False).search(criterion="AICc")
        g = GWR(coords, y, X, bw, fixed=False)
        gres = g.fit()

        # per-segment fitted rate -> broadcast onto every day of the window
        rate = dict(zip(cs["nearest_exit"], np.clip(gres.predy.ravel(), 0, None)))
        ptr = tr["nearest_exit"].map(rate).values
        pte = te["nearest_exit"].map(rate).values
        ytr = tr["incident_count"].values.astype(float)
        yte = te["incident_count"].values.astype(float)

        coef_map = {
            "bandwidth_nearest_neighbours": int(bw),
            "local_R2_mean": round(float(np.mean(gres.localR2)), 4),
            "per_segment": {
                seg: {"intercept": round(float(gres.params[i, 0]), 5),
                      "beta_exit_km": round(float(gres.params[i, 1]), 5),
                      "local_R2": round(float(gres.localR2[i]), 4),
                      "fitted_daily_rate": round(float(gres.predy[i, 0]), 4)}
                for i, seg in enumerate(cs["nearest_exit"])
            },
        }
        folds.append({"m": compute_metrics(yte, pte, ytr, 1, 1),
                      "s": split_r2(ytr, ptr, yte, pte)})

    results["GWR"] = record("GWR", "incident_count_daily_per_segment", folds, meta,
                            {"gwr_surface_last_fold": coef_map,
                             "note": "spatial risk surface: 13-segment cross-section, "
                                     "predicts each segment's expected daily count"})

    # ---------------- Spatial LSTM : all segments forecast jointly ----------------
    print("  [9] Spatial LSTM (13 segments jointly)")
    from tensorflow import keras
    from tensorflow.keras import layers

    s = pd.read_csv(f"{DATA}/incidents_only_hourly_segment.csv", parse_dates=["dt"])
    s["ts"] = s["dt"] + pd.to_timedelta(s["hour_of_day"], unit="h")
    mat = s.pivot_table(index="ts", columns="nearest_exit",
                        values="incident_count", aggfunc="sum").fillna(0)
    segs = list(mat.columns)
    M = mat.values.astype(float)                       # (T, n_segments)

    cal = (s.drop_duplicates("ts").set_index("ts")
             .loc[mat.index, ["hour_sin", "hour_cos", "dow_sin", "dow_cos",
                              "is_weekend", "is_rush_hour"]].values.astype(float))
    T = len(M)
    ssplits = wf_splits(T)
    smeta = [{"fold": i + 1, "train_steps": e1 - s1, "test_steps": e2 - s2}
             for i, (s1, e1, s2, e2) in enumerate(ssplits)]

    LOOK = 48
    folds = []
    for (a1, b1, a2, b2) in ssplits:
        sc = StandardScaler()
        Mtr_s = sc.fit_transform(M[a1:b1])
        Mte_s = sc.transform(M[a2:b2])
        Ftr = np.hstack([Mtr_s, cal[a1:b1]])
        Fte = np.hstack([Mte_s, cal[a2:b2]])

        def win(F, Y):
            return (np.stack([F[i - LOOK:i] for i in range(LOOK, len(F))]), Y[LOOK:])

        Wtr, Ytr = win(Ftr, M[a1:b1])
        joint_F = np.vstack([Ftr[-LOOK:], Fte])
        joint_Y = np.vstack([M[b1 - LOOK:b1], M[a2:b2]])
        Wte, Yte = win(joint_F, joint_Y)

        keras.utils.set_random_seed(SEED)
        net = keras.Sequential([
            keras.Input(shape=(LOOK, Wtr.shape[2])),
            layers.LSTM(96, return_sequences=True),
            layers.Dropout(0.2),
            layers.LSTM(48),
            layers.Dropout(0.2),
            layers.Dense(len(segs), activation="softplus"),   # all segments at once
        ])
        net.compile(optimizer=keras.optimizers.Adam(1e-3), loss="poisson")
        net.fit(Wtr, Ytr, epochs=15, batch_size=128, verbose=0, validation_split=0.1,
                callbacks=[keras.callbacks.EarlyStopping(patience=4,
                                                         restore_best_weights=True)])
        ptr = np.clip(net.predict(Wtr, verbose=0), 0, None).ravel()
        pte = np.clip(net.predict(Wte, verbose=0), 0, None).ravel()
        folds.append({"m": compute_metrics(Yte.ravel(), pte, Ytr.ravel(),
                                           len(segs) + 6, SEASONALITY),
                      "s": split_r2(Ytr.ravel(), ptr, Yte.ravel(), pte)})

    results["Spatial_LSTM"] = record("Spatial LSTM", "incident_count_hourly_per_segment",
                                     folds, smeta,
                                     {"segments": segs,
                                      "note": "multivariate LSTM, 13 segments forecast jointly"})
    return results


def main():
    print("=" * 78)
    print("  STAGE 13 - PANEL A INCIDENT MODELS | AWS incident tables only | no weather")
    print("=" * 78)
    panel_a()
    # Panel B is NOT run here. 14_spatial_models.py owns the spatial models and
    # builds its own 2 km corridor panel; the panel_b() below is the superseded
    # 13-exit version, kept only for reference. 14_spatial_models.py is also what
    # merges Panel A + Panel B into all_incident_models.json and the metrics CSV,
    # so run it next.
    print(f"\nPanel A saved -> {OUT}")
    print("Next: python 14_spatial_models.py   (adds GWR + Spatial LSTM, "
          "writes all_incident_models.json)")


if __name__ == "__main__":
    main()
