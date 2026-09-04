"""
Congestion state classifier — four candidates, one protocol.

The first pass trained only XGBoost, which is not the standard applied to the
volume forecast (six candidates, ranked, evidence-based selection). The modelling
diagram specifies FOUR for congestion: XGBoost, GRU, Quantile Random Forest and
SARIMAX. All four are scored here on the same split, against the same baselines.

Data, label rule and limits are unchanged from train_congestion.py:
  source  silver.fact_waze_jams (Waze Partner Hub), 20 canonical exits
  label   Free flow / Heavy / Severe; absence of a jam INFERRED as free flow
  window  2026-08-04..2026-09-01, 28 days, last 7 held out
  note    gold.fact_traffic_hourly (2022-2025) does not overlap the jam window,
          so traffic volume cannot be a feature.

Adaptations, stated rather than hidden:
  QRF     Quantile regression forests are a regression method. The classification
          analogue is the forest's vote distribution over classes, which serves
          the same purpose as the diagram's "congestion probability score".
  SARIMAX A continuous time-series model, not a classifier. Fitted per exit on
          the SPEED series, forecast over the test window, then thresholded with
          the same 30/60 km/h cuts. Fitted once per exit rather than refitted at
          every origin - a simplification that favours SARIMAX if anything.
"""
import json
import warnings
import numpy as np
import pandas as pd
import psycopg2
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (accuracy_score, f1_score, precision_recall_fscore_support,
                             confusion_matrix, log_loss)
from xgboost import XGBClassifier

warnings.filterwarnings("ignore")

PG = ("host=smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com port=5432 "
      "dbname=nlex_capstone user=postgres password=Hanszy123! sslmode=require")
HORIZONS = list(range(1, 13))
# Wire values the dashboard expects; display labels live in the frontend.
STATES = ["Low", "Med", "High"]
SEVERE_KMH, HEAVY_KMH = 30.0, 60.0
TEST_DAYS = 7
SEQ_LEN = 24


def banner(t):
    print("\n" + "=" * 68 + f"\n  {t}\n" + "=" * 68)


banner("STEP 1: Data (identical to the single-model run)")
conn = psycopg2.connect(PG)
jams = pd.read_sql_query("""
    SELECT j.date_day::date AS d, j.hour_of_day::int AS h,
           COALESCE(e.exit_name,'id_'||j.nlex_exit_id::text) AS exit_name,
           j.speed_kmh::float AS speed, j.length_meters::float AS len
    FROM silver.fact_waze_jams j
    LEFT JOIN bronze.nlex_exits e ON e.id = j.nlex_exit_id
    WHERE j.speed_kmh IS NOT NULL
""", conn)
jams["wlen"] = jams["len"].clip(lower=1.0)
jams["sp_w"] = jams["speed"] * jams["wlen"]
cell = (jams.groupby(["d", "h", "exit_name"])
        .agg(sp_w=("sp_w", "sum"), wlen=("wlen", "sum"), n_jams=("speed", "size")).reset_index())
cell["speed"] = cell.sp_w / cell.wlen
cell = cell[["d", "h", "exit_name", "speed", "n_jams"]]

days = pd.date_range(jams.d.min(), jams.d.max(), freq="D").date
exits = sorted(jams.exit_name.unique())
df = (pd.MultiIndex.from_product([days, range(24), exits], names=["d", "h", "exit_name"])
      .to_frame(index=False).merge(cell, on=["d", "h", "exit_name"], how="left"))
df["y"] = np.where(df.speed.isna(), 0, np.where(df.speed < SEVERE_KMH, 2,
                                                np.where(df.speed < HEAVY_KMH, 1, 0)))
df["n_jams"] = df.n_jams.fillna(0)
# Free-flow cells have no observed speed; 65 km/h stands in for the SARIMAX
# series only, above the heavy threshold so it re-labels back to free flow.
df["speed_filled"] = df.speed.fillna(65.0)
df["ts"] = pd.to_datetime(df.d.astype(str)) + pd.to_timedelta(df.h, unit="h")
df = df.sort_values(["exit_name", "ts"]).reset_index(drop=True)
df["dow"] = df.ts.dt.dayofweek
df["is_weekend"] = (df.dow >= 5).astype(int)
g = df.groupby("exit_name", sort=False)
df["lag24"] = g.y.shift(24); df["lag48"] = g.y.shift(48); df["lag24_jams"] = g.n_jams.shift(24)
df = df.dropna(subset=["lag24", "lag48"]).reset_index(drop=True)
df["exit_code"] = pd.Categorical(df.exit_name, categories=exits).codes

FEATS = ["exit_code", "h", "dow", "is_weekend", "lag24", "lag48", "lag24_jams", "horizon"]
cut = df.ts.max().normalize() - pd.Timedelta(days=TEST_DAYS - 1)
full = pd.concat([df.assign(horizon=hz) for hz in HORIZONS], ignore_index=True)
tr, te = full[full.ts < cut], full[full.ts >= cut]
Xtr, ytr, Xte, yte = tr[FEATS], tr.y.values, te[FEATS], te.y.values
print(f"  grid {len(df):,} cells | train {len(tr):,} | test {len(te):,} | {len(exits)} exits")
print(f"  test window {cut.date()} .. {df.ts.max().date()}")

banner("STEP 2: Baselines")
maj = int(pd.Series(ytr).mode()[0])
prof = tr.groupby(["exit_code", "h"]).y.agg(lambda s: s.mode().iloc[0]).rename("m").reset_index()
baselines = {
    "Majority class": np.full(len(yte), maj),
    "Persistence (t-24h)": te.lag24.astype(int).values,
    "Exit-hour profile": te[["exit_code", "h"]].merge(prof, on=["exit_code", "h"], how="left")
                           .m.fillna(maj).astype(int).values,
}
for k, v in baselines.items():
    print(f"  {k:<22} acc {accuracy_score(yte, v):.4f}   macroF1 {f1_score(yte, v, average='macro'):.4f}")
best_base = max(accuracy_score(yte, v) for v in baselines.values())
best_base_name = max(baselines, key=lambda k: accuracy_score(yte, baselines[k]))
print(f"  -> best baseline: {best_base_name} at {best_base:.4f}")

results = {}

banner("STEP 3: XGBoost")
xgb = XGBClassifier(n_estimators=400, max_depth=6, learning_rate=0.08, subsample=0.9,
                    colsample_bytree=0.9, objective="multi:softprob", num_class=3,
                    eval_metric="mlogloss", random_state=42, n_jobs=4).fit(Xtr, ytr)
results["XGBoost"] = xgb.predict_proba(Xte)
print("  done.")

banner("STEP 4: Quantile Random Forest")
print("  Vote distribution over classes = the diagram's 'congestion probability score'.")
qrf = RandomForestClassifier(n_estimators=300, max_depth=14, min_samples_leaf=5,
                             random_state=42, n_jobs=4).fit(Xtr, ytr)
results["QRF"] = qrf.predict_proba(Xte)
print("  done.")

banner("STEP 5: GRU")
try:
    import tensorflow as tf
    from tensorflow.keras import layers, Sequential

    tf.random.set_seed(42)
    piv = df.pivot_table(index="ts", columns="exit_code", values="y").sort_index()
    jm = df.pivot_table(index="ts", columns="exit_code", values="n_jams").sort_index()

    def seqs(idx):
        X, Y, meta = [], [], []
        arr, jarr = piv.values, jm.values
        for i in range(SEQ_LEN, len(piv)):
            t = piv.index[i]
            if not idx(t):
                continue
            for c in range(arr.shape[1]):
                X.append(np.stack([arr[i - SEQ_LEN:i, c], jarr[i - SEQ_LEN:i, c]], axis=-1))
                Y.append(arr[i, c]); meta.append((t, c))
        return np.array(X, "float32"), np.array(Y, "int32"), meta

    Xs_tr, ys_tr, _ = seqs(lambda t: t < cut)
    Xs_te, ys_te, meta_te = seqs(lambda t: t >= cut)
    print(f"  sequences: train {len(Xs_tr):,} | test {len(Xs_te):,} (len {SEQ_LEN})")

    gru = Sequential([layers.Input((SEQ_LEN, 2)), layers.GRU(48), layers.Dropout(0.2),
                      layers.Dense(32, activation="relu"), layers.Dense(3, activation="softmax")])
    gru.compile("adam", "sparse_categorical_crossentropy", metrics=["accuracy"])
    gru.fit(Xs_tr, ys_tr, epochs=25, batch_size=128, verbose=0)
    pg_ = gru.predict(Xs_te, verbose=0)
    # Map per-cell predictions onto the horizon-expanded test frame.
    lut = {(t, c): pg_[i] for i, (t, c) in enumerate(meta_te)}
    dflt = np.array([1 / 3, 1 / 3, 1 / 3])
    results["GRU"] = np.array([lut.get((r.ts, r.exit_code), dflt) for r in te.itertuples()])
    print("  done.")
except Exception as e:
    print(f"  SKIPPED: {str(e)[:90]}")

banner("STEP 6: SARIMAX")
print("  Fitted per exit on the SPEED series, forecast, then thresholded at 30/60 km/h.")
try:
    from statsmodels.tsa.statespace.sarimax import SARIMAX

    n_te_ts = te.ts.nunique()
    preds = {}
    ok = 0
    for c in range(len(exits)):
        s = df[df.exit_code == c].set_index("ts").speed_filled.sort_index()
        s_tr, s_te = s[s.index < cut], s[s.index >= cut]
        try:
            m = SARIMAX(s_tr, order=(1, 0, 1), seasonal_order=(1, 0, 1, 24),
                        enforce_stationarity=False, enforce_invertibility=False).fit(disp=False)
            fc = np.asarray(m.forecast(len(s_te)))
            ok += 1
        except Exception:
            fc = np.full(len(s_te), s_tr.mean())
        for t, v in zip(s_te.index, fc):
            preds[(t, c)] = v
    print(f"  fitted {ok}/{len(exits)} exits (fallback = train mean elsewhere)")

    def onehot(v):
        k = 2 if v < SEVERE_KMH else (1 if v < HEAVY_KMH else 0)
        p = np.full(3, 0.05); p[k] = 0.90
        return p

    results["SARIMAX"] = np.array([onehot(preds.get((r.ts, r.exit_code), 65.0)) for r in te.itertuples()])
    print("  done.")
except Exception as e:
    print(f"  SKIPPED: {str(e)[:90]}")

banner("STEP 7: Comparison on the held-out 7 days")
rows = []
for name, proba in results.items():
    pred = proba.argmax(1)
    acc = accuracy_score(yte, pred)
    rows.append({
        "model": name, "accuracy": acc,
        "macro_f1": f1_score(yte, pred, average="macro"),
        "weighted_f1": f1_score(yte, pred, average="weighted"),
        "log_loss": log_loss(yte, np.clip(proba, 1e-9, 1), labels=[0, 1, 2]),
        "heavy_recall": precision_recall_fscore_support(yte, pred, labels=[1], zero_division=0)[1][0],
        "accepted": bool(acc > best_base),
    })
res = pd.DataFrame(rows).sort_values("accuracy", ascending=False).reset_index(drop=True)
res["rank"] = res.index + 1

print(f"  {'model':<10}{'accuracy':>10}{'macroF1':>10}{'weightF1':>10}{'logloss':>10}{'HeavyRec':>10}  verdict")
for r in res.itertuples():
    print(f"  {r.model:<10}{r.accuracy:>10.4f}{r.macro_f1:>10.4f}{r.weighted_f1:>10.4f}"
          f"{r.log_loss:>10.4f}{r.heavy_recall:>10.4f}  {'ACCEPTED' if r.accepted else 'rejected'}")
print(f"\n  baseline to beat: {best_base:.4f} ({best_base_name})")

best = res.iloc[0]
print(f"\n  confusion matrix — {best.model} (rows actual, cols predicted):")
cm = confusion_matrix(yte, results[best.model].argmax(1), labels=[0, 1, 2])
print("               " + "".join(f"{s:>12}" for s in STATES))
for i, s in enumerate(STATES):
    print(f"    {s:<10} " + "".join(f"{v:>12,}" for v in cm[i]))

banner("STEP 8: Writing to AWS")
cur = conn.cursor()
cur.execute("DELETE FROM gold.ml_model_metrics WHERE target = 'Congestion'")
for r in res.itertuples():
    reason = None if r.accepted else f"accuracy {r.accuracy:.4f} does not beat baseline {best_base:.4f} ({best_base_name})"
    cur.execute("""INSERT INTO gold.ml_model_metrics
        (model_name,target,r2,mae,rank,accepted,rejected_reason,uses_weather,updated_at)
        VALUES (%s,'Congestion',%s,%s,%s,%s,%s,false,now())""",
        (r.model, float(r.accuracy), float(r.log_loss), int(r.rank), bool(r.accepted), reason))
for k, v in baselines.items():
    cur.execute("""INSERT INTO gold.ml_model_metrics
        (model_name,target,r2,rank,accepted,rejected_reason,uses_weather,updated_at)
        VALUES (%s,'Congestion',%s,NULL,false,'baseline, not a candidate',false,now())""",
        (k, float(accuracy_score(yte, v))))

# Serve the CHAMPION's forecast, not whichever model happened to run last. The
# first pass left XGBoost's predictions in the table while GRU held rank 1, so
# the metrics and the map described different models.
champ = res.iloc[0]
print(f"  champion for the served map: {champ.model} (acc {champ.accuracy:.4f})")
if champ.model == "GRU" and "GRU" in results:
    last = piv.index[-1]
    a, jn = piv.values, jm.values
    out = []
    for hz in HORIZONS:
        seq = np.stack([a[-SEQ_LEN:, :], jn[-SEQ_LEN:, :]], -1)      # (SEQ, exits, 2)
        pr_ = gru.predict(np.transpose(seq, (1, 0, 2)).astype("float32"), verbose=0)
        for c in range(pr_.shape[0]):
            k = int(pr_[c].argmax())
            out.append((exits[c], hz, STATES[k], float(pr_[c][k])))
else:
    proba = results[champ.model]
    te2 = te.copy(); te2["k"] = proba.argmax(1); te2["p"] = proba.max(1)
    last_ts = te2.ts.max()
    out = [(r.exit_name, int(r.horizon), STATES[int(r.k)], float(r.p))
           for r in te2[te2.ts == last_ts].itertuples()]

cur.execute("DELETE FROM gold.ml_predictive_congestion")
for seg, hz, st, pb in out:
    cur.execute("""INSERT INTO gold.ml_predictive_congestion
                   (segment_name, hours_ahead, congestion_state, probability)
                   VALUES (%s,%s,%s,%s)""", (seg, hz, st, pb))
conn.commit()
print(f"  ml_predictive_congestion: {len(out)} rows from {champ.model}")
print(f"  ml_model_metrics: {len(res)} candidates + {len(baselines)} baselines")

json.dump({
    "generated": str(pd.Timestamp.now().date()),
    "source": "silver.fact_waze_jams (Waze Partner Hub)",
    "candidates": res.to_dict("records"),
    "baselines": {k: float(accuracy_score(yte, v)) for k, v in baselines.items()},
    "best_baseline": {"name": best_base_name, "accuracy": float(best_base)},
    "any_accepted": bool(res.accepted.any()),
    "confusion_best": cm.tolist(),
    "limits": ["28 days only", "no traffic-volume feature (no date overlap)",
               "Heavy is 4.5% of cells", "free flow inferred from absence of a jam"],
}, open("congestion_results_multi.json", "w"), indent=2)
print("  congestion_results_multi.json written")
conn.close()
banner("DONE")
