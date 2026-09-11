"""
Congestion state forecasting — a REAL 1-to-12-hour horizon.

WHY THIS REPLACES train_congestion_multi.py
  That script never forecast anything. It built its training frame as

      full = pd.concat([df.assign(horizon=hz) for hz in HORIZONS])

  which duplicates every row twelve times and tags each copy with a horizon,
  but never shifts the TARGET. All twelve copies carry the state at the SAME
  timestamp, so `horizon` had no relationship to the label, the models correctly
  learned to ignore it, and every horizon returned an identical answer. The
  served map showed one prediction twelve times (verified: every segment had
  exactly one distinct state/probability pair across all twelve columns).

  A second, independent bug had the same effect on serving: inside the GRU's
  horizon loop the input window `a[-SEQ_LEN:, :]` was recomputed identically on
  every pass, so it never advanced through the horizons either.

  The reported 78.1% was therefore a NOWCAST accuracy - classifying the current
  hour from lag-24/lag-48 features - mislabelled as a 12-hour forecast.

WHAT THIS DOES INSTEAD
  For each horizon h, the target is the state at ts + h hours for that exit, and
  the features are the ones knowable at ts. Accuracy is reported PER HORIZON,
  because a single number across 1-12h hides exactly the decay that matters.

LEAKAGE
  A training row is kept only if its TARGET timestamp also falls before the test
  cut. Splitting on ts alone would let a row at ts = cut - 1h carry a label from
  inside the test window.

EXPECTATION
  Accuracy will fall well below 78.1%, steeply with horizon. That is not a
  regression; it is the first honest measurement of a harder task.
"""
import json
import sys
import warnings

# --dry-run: train, score and print everything, but touch nothing in the
# warehouse. Use it to judge a feature change before the leaderboard and the
# served forecast are overwritten.
DRY_RUN = "--dry-run" in sys.argv

import numpy as np
import pandas as pd
import psycopg2
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, f1_score, log_loss, precision_recall_fscore_support
from xgboost import XGBClassifier

warnings.filterwarnings("ignore")

# Connection comes from Back-End/.env (PG_* keys), never from this file: the
# original carried the production password in plain text.
import os
from pathlib import Path
_env = {}
for _line in (Path(__file__).resolve().parents[2] / "Back-End" / ".env").read_text().splitlines():
    if "=" in _line and not _line.startswith("#"):
        _k, _v = _line.split("=", 1)
        _env[_k.strip()] = _v.strip().strip('"')
PG = (f"host={_env['PG_HOST']} port={_env.get('PG_PORT', 5432)} dbname={_env['PG_DATABASE']} "
      f"user={_env['PG_USER']} password={_env['PG_PASSWORD']} sslmode=require")
HORIZONS = list(range(1, 13))
STATES = ["Low", "Med", "High"]
SEVERE_KMH, HEAVY_KMH = 30.0, 60.0
TEST_DAYS = 7
SEQ_LEN = 24
SARIMAX_ORIGIN_STEP = 12          # refit cadence across the test window


def banner(t):
    print("\n" + "=" * 70 + f"\n  {t}\n" + "=" * 70)


# ── 1. Data ─────────────────────────────────────────────────────────────────
banner("STEP 1: Data")
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

# Trim the trailing INGESTION GAP before building the grid.
#
# The label rule treats "no jam reported" as free flow. That is right for a
# quiet road and badly wrong for an hour that was never collected: the last
# partial day of Waze data had 51 records over 4 hours against ~2,300 over 24 on
# every other day, and the grid turned the missing 20 hours into a fabricated
# empty corridor. The served forecast then read that as "all clear" while the
# preceding week ran 59% severe.
#
# Cut at the last hour whose record count reaches a fraction of the recent
# typical hour, so genuinely quiet hours survive but uncollected ones do not.
# Compared against the norm FOR THAT HOUR OF DAY, not against all hours.
# A flat threshold is dominated by daytime volume, so 3am legitimately falls
# under it and gets discarded as if ingestion had failed — which cost ~19 hours
# of freshness and left the dashboard showing a forecast for a day that had
# already finished. Quiet hours are quiet; missing hours are missing.
_ts = pd.to_datetime(jams.d.astype(str)) + pd.to_timedelta(jams.h, unit="h")
_per_hr = jams.assign(ts=_ts).groupby("ts").size().sort_index()
_recent = _per_hr.tail(24 * 14)
_by_hod = _recent.groupby(_recent.index.hour).median()
_expected = pd.Series(_per_hr.index.hour, index=_per_hr.index).map(_by_hod).fillna(_by_hod.median())
_ok = _per_hr[_per_hr >= _expected * 0.25]
if len(_ok):
    _last_good = _ok.index.max()
    _dropped = (_per_hr.index > _last_good).sum()
    if _dropped:
        print(f"  trimming {_dropped} trailing hour(s) below 25% of their "
              f"hour-of-day norm; last complete hour {_last_good}")
    jams = jams[pd.to_datetime(jams.d.astype(str)) + pd.to_timedelta(jams.h, unit="h") <= _last_good]

days = pd.date_range(jams.d.min(), jams.d.max(), freq="D").date
exits = sorted(jams.exit_name.unique())
df = (pd.MultiIndex.from_product([days, range(24), exits], names=["d", "h", "exit_name"])
      .to_frame(index=False).merge(cell, on=["d", "h", "exit_name"], how="left"))
df["y"] = np.where(df.speed.isna(), 0,
                   np.where(df.speed < SEVERE_KMH, 2, np.where(df.speed < HEAVY_KMH, 1, 0)))
df["n_jams"] = df.n_jams.fillna(0)
df["speed_filled"] = df.speed.fillna(65.0)
df["ts"] = pd.to_datetime(df.d.astype(str)) + pd.to_timedelta(df.h, unit="h")
# The MultiIndex spans whole days, so the final day's uncollected hours would
# reappear here as free flow even after trimming the raw jams above.
if len(_ok):
    df = df[df.ts <= _last_good]
df = df.sort_values(["exit_name", "ts"]).reset_index(drop=True)
df["dow"] = df.ts.dt.dayofweek
df["is_weekend"] = (df.dow >= 5).astype(int)
g = df.groupby("exit_name", sort=False)
df["lag24"] = g.y.shift(24)
df["lag48"] = g.y.shift(48)
df["lag24_jams"] = g.n_jams.shift(24)
# Recent state, not just the same hour yesterday. The original feature set
# knew only lag24/lag48, so at +1h the model could not see that the exit was
# jammed sixty minutes ago -- which is why it barely beat the exit-hour
# profile baseline. Everything here is knowable at ts (shift >= 1), so it is
# legitimate for every horizon; its value naturally fades as h grows.
for _k in (1, 2, 3, 6):
    df[f"lag{_k}"] = g.y.shift(_k)
df["roll6_y"] = g.y.transform(lambda s_: s_.shift(1).rolling(6, min_periods=1).mean())
df["roll6_jams"] = g.n_jams.transform(lambda s_: s_.shift(1).rolling(6, min_periods=1).mean())
df["roll24_y"] = g.y.transform(lambda s_: s_.shift(1).rolling(24, min_periods=1).mean())
df = df.dropna(subset=["lag24", "lag48", "lag6"]).reset_index(drop=True)
df["exit_code"] = pd.Categorical(df.exit_name, categories=exits).codes

cut = df.ts.max().normalize() - pd.Timedelta(days=TEST_DAYS - 1)
print(f"  {len(df):,} exit-hours | {len(exits)} exits | {df.ts.min()} .. {df.ts.max()}")
print(f"  test window starts {cut}")

# ── 2. Horizon-expanded frame, with the target ACTUALLY shifted ─────────────
banner("STEP 2: Building horizon targets")
gy = df.groupby("exit_name", sort=False).y
frames = []
for hz in HORIZONS:
    f = df[["ts", "exit_name", "exit_code", "h", "dow", "is_weekend",
            "lag24", "lag48", "lag24_jams",
            "lag1", "lag2", "lag3", "lag6", "roll6_y", "roll6_jams", "roll24_y", "y"]].copy()
    f["horizon"] = hz
    f["y_target"] = gy.shift(-hz).values      # state hz hours LATER — the fix
    f["target_ts"] = f.ts + pd.Timedelta(hours=hz)
    frames.append(f)
full = pd.concat(frames, ignore_index=True).dropna(subset=["y_target"])
full["y_target"] = full.y_target.astype(int)

FEATS = ["exit_code", "h", "dow", "is_weekend", "lag24", "lag48", "lag24_jams",
         "lag1", "lag2", "lag3", "lag6", "roll6_y", "roll6_jams", "roll24_y", "horizon"]
# A training row whose TARGET lands inside the test window would leak.
tr = full[full.target_ts < cut]
te = full[full.ts >= cut]
Xtr, ytr = tr[FEATS], tr.y_target.values
Xte, yte = te[FEATS], te.y_target.values
print(f"  train {len(tr):,} rows | test {len(te):,} rows")
print(f"  class balance (test): " +
      ", ".join(f"{STATES[k]} {np.mean(yte == k) * 100:.1f}%" for k in range(3)))
# Sanity: the target must actually MOVE with the horizon. Sampling one
# timestamp was too weak - the first hour of the series happened to be flat, so
# the check printed False on a run that was in fact correct. Measure the share
# of rows whose future state differs from the present one, across the series.
_drift = [(full[full.horizon == hz].y_target.values !=
           full[full.horizon == hz].y.values).mean() for hz in HORIZONS]
print("  sanity — share of rows where state(ts+h) != state(ts): " +
      ", ".join(f"+{hz}h {d * 100:.0f}%" for hz, d in zip(HORIZONS, _drift)))
assert _drift[-1] > _drift[0] > 0, "target does not move with the horizon - the shift is broken"

# ── 3. Baselines ────────────────────────────────────────────────────────────
banner("STEP 3: Baselines")
maj = int(pd.Series(ytr).mode()[0])
prof = tr.groupby(["exit_code", "h"]).y_target.agg(lambda s: s.mode().iloc[0]).rename("m").reset_index()
baselines = {
    "Majority class": np.full(len(yte), maj),
    # "Nothing changes": whatever the state is NOW, hz hours from now. The
    # honest bar for a forecaster, and it should decay with horizon.
    "Persistence (now)": te.y.astype(int).values,
    "Exit-hour profile": te[["exit_code", "h"]].merge(prof, on=["exit_code", "h"], how="left")
                           .m.fillna(maj).astype(int).values,
}
for k, v in baselines.items():
    print(f"  {k:<22} acc {accuracy_score(yte, v):.4f}   macroF1 {f1_score(yte, v, average='macro'):.4f}")
best_base_name = max(baselines, key=lambda k: accuracy_score(yte, baselines[k]))
best_base = accuracy_score(yte, baselines[best_base_name])
print(f"  -> best baseline: {best_base_name} at {best_base:.4f}")

results = {}

# ── 4. Tabular candidates ───────────────────────────────────────────────────
banner("STEP 4: XGBoost")
xgb = XGBClassifier(n_estimators=400, max_depth=6, learning_rate=0.08, subsample=0.9,
                    colsample_bytree=0.9, objective="multi:softprob", num_class=3,
                    eval_metric="mlogloss", random_state=42, n_jobs=4).fit(Xtr, ytr)
results["XGBoost"] = xgb.predict_proba(Xte)
print("  done.")

banner("STEP 5: Quantile Random Forest")
qrf = RandomForestClassifier(n_estimators=300, max_depth=14, min_samples_leaf=5,
                             random_state=42, n_jobs=4).fit(Xtr, ytr)
results["QRF"] = qrf.predict_proba(Xte)
print("  done.")

# ── 5. GRU — one pass, twelve outputs ───────────────────────────────────────
banner("STEP 6: GRU (multi-horizon head)")
gru = None
piv = df.pivot_table(index="ts", columns="exit_code", values="y").sort_index()
jm = df.pivot_table(index="ts", columns="exit_code", values="n_jams").sort_index()
try:
    import tensorflow as tf
    from tensorflow.keras import layers, Sequential

    tf.random.set_seed(42)
    arr, jarr = piv.values, jm.values
    H = len(HORIZONS)

    def seqs(keep):
        """X ends at index i-1; Y is the next H states, so the head predicts
        every horizon from one pass instead of the old loop that reused the
        same window twelve times."""
        X, Y, meta = [], [], []
        for i in range(SEQ_LEN, len(piv) - H):
            t = piv.index[i - 1]
            if not keep(t):
                continue
            for c in range(arr.shape[1]):
                X.append(np.stack([arr[i - SEQ_LEN:i, c], jarr[i - SEQ_LEN:i, c]], -1))
                Y.append(arr[i:i + H, c])
                meta.append((t, c))
        return np.array(X, "float32"), np.array(Y, "int32"), meta

    # Train only where the whole 12-step target block precedes the cut.
    Xs_tr, ys_tr, _ = seqs(lambda t: t + pd.Timedelta(hours=H) < cut)
    Xs_te, ys_te, meta_te = seqs(lambda t: t >= cut - pd.Timedelta(hours=1))
    print(f"  sequences: train {len(Xs_tr):,} | test {len(Xs_te):,} (len {SEQ_LEN}, {H} outputs)")

    gru = Sequential([
        layers.Input((SEQ_LEN, 2)), layers.GRU(48), layers.Dropout(0.2),
        layers.Dense(64, activation="relu"),
        layers.Dense(H * 3), layers.Reshape((H, 3)), layers.Softmax(axis=-1),
    ])
    gru.compile("adam", "sparse_categorical_crossentropy", metrics=["accuracy"])
    gru.fit(Xs_tr, ys_tr, epochs=25, batch_size=128, verbose=0)
    pg_ = gru.predict(Xs_te, verbose=0)                       # (n, H, 3)

    lut = {(t, c): pg_[i] for i, (t, c) in enumerate(meta_te)}
    dflt = np.full((H, 3), 1 / 3)
    # te rows are (ts, exit, horizon); the GRU keyed on the window END, which is
    # ts - 1h, and horizon hz maps to output index hz-1.
    results["GRU"] = np.array([
        lut.get((r.ts - pd.Timedelta(hours=1), r.exit_code), dflt)[int(r.horizon) - 1]
        for r in te.itertuples()])
    print("  done.")
except Exception as e:
    print(f"  SKIPPED: {str(e)[:100]}")

# ── 6. SARIMAX — refit at rolling origins ───────────────────────────────────
banner("STEP 7: SARIMAX (rolling origins, horizon-matched)")
try:
    from statsmodels.tsa.statespace.sarimax import SARIMAX

    test_ts = np.sort(te.ts.unique())
    origins = pd.to_datetime(test_ts[::SARIMAX_ORIGIN_STEP])
    print(f"  {len(origins)} origins x {len(exits)} exits, forecasting {len(HORIZONS)} steps each")
    pred_map = {}
    fits = fails = 0
    for c in range(len(exits)):
        s = df[df.exit_code == c].set_index("ts").speed_filled.sort_index()
        for o in origins:
            hist = s[s.index < o]
            if len(hist) < 48:
                continue
            try:
                m = SARIMAX(hist, order=(1, 0, 1), seasonal_order=(1, 0, 1, 24),
                            enforce_stationarity=False, enforce_invertibility=False).fit(disp=False)
                fc = np.asarray(m.forecast(len(HORIZONS)))
                fits += 1
            except Exception:
                fc = np.full(len(HORIZONS), hist.mean())
                fails += 1
            for k, hz in enumerate(HORIZONS):
                pred_map[(o - pd.Timedelta(hours=hz), c, hz)] = fc[k]
    print(f"  fitted {fits}, fell back {fails}")

    def onehot(v):
        k = 2 if v < SEVERE_KMH else (1 if v < HEAVY_KMH else 0)
        p = np.full(3, 0.05)
        p[k] = 0.90
        return p

    # Only the (ts, exit, horizon) triples an origin actually covers are scored;
    # the rest fall back to a flat prior, which cannot flatter the model.
    results["SARIMAX"] = np.array([
        onehot(pred_map[(r.ts, r.exit_code, int(r.horizon))])
        if (r.ts, r.exit_code, int(r.horizon)) in pred_map else np.full(3, 1 / 3)
        for r in te.itertuples()])
    covered = sum(1 for r in te.itertuples() if (r.ts, r.exit_code, int(r.horizon)) in pred_map)
    print(f"  horizon-matched coverage: {covered:,}/{len(te):,} test rows "
          f"({covered / len(te) * 100:.1f}%) — the rest score at chance")
except Exception as e:
    print(f"  SKIPPED: {str(e)[:100]}")

# ── 7. Overall + per-horizon comparison ─────────────────────────────────────
banner("STEP 8: Results")
rows = []
for name, proba in results.items():
    pred = proba.argmax(1)
    rows.append({
        "model": name,
        "accuracy": accuracy_score(yte, pred),
        "macro_f1": f1_score(yte, pred, average="macro"),
        "weighted_f1": f1_score(yte, pred, average="weighted"),
        "log_loss": log_loss(yte, np.clip(proba, 1e-9, 1), labels=[0, 1, 2]),
        "heavy_recall": precision_recall_fscore_support(yte, pred, labels=[1], zero_division=0)[1][0],
    })
res = pd.DataFrame(rows).sort_values("accuracy", ascending=False).reset_index(drop=True)
res["accepted"] = res.accuracy > best_base
res["rank"] = res.index + 1

print(f"  {'model':<10}{'accuracy':>10}{'macroF1':>10}{'weightF1':>10}{'logloss':>10}{'HeavyRec':>10}  verdict")
for r in res.itertuples():
    print(f"  {r.model:<10}{r.accuracy:>10.4f}{r.macro_f1:>10.4f}{r.weighted_f1:>10.4f}"
          f"{r.log_loss:>10.4f}{r.heavy_recall:>10.4f}  {'ACCEPTED' if r.accepted else 'rejected'}")
print(f"\n  baseline to beat: {best_base:.4f} ({best_base_name})")

banner("STEP 9: Accuracy BY HORIZON — the number that was missing")
hz_arr = te.horizon.values
per_h = []
print(f"  {'h':>4}" + "".join(f"{m:>12}" for m in res.model) + f"{'persist':>12}{'n':>9}")
for hz in HORIZONS:
    m = hz_arr == hz
    row = {"horizon": hz, "n": int(m.sum())}
    for name in res.model:
        row[name] = accuracy_score(yte[m], results[name].argmax(1)[m])
    row["Persistence"] = accuracy_score(yte[m], baselines["Persistence (now)"][m])
    per_h.append(row)
    print(f"  {hz:>4}" + "".join(f"{row[m_]:>12.4f}" for m_ in res.model) +
          f"{row['Persistence']:>12.4f}{row['n']:>9,}")

# ── 8. Write ────────────────────────────────────────────────────────────────
banner("STEP 10: Writing to AWS")
if DRY_RUN:
    print("  --dry-run: nothing written. Leaderboard, per-horizon accuracy and the")
    print("  served forecast are unchanged; rerun without the flag to publish.")
    conn.close()
    banner("DONE (dry run)")
    sys.exit(0)
try:
    conn.cursor().execute("SELECT 1")
except Exception:
    conn = psycopg2.connect(PG)
cur = conn.cursor()

cur.execute("DELETE FROM gold.ml_model_metrics WHERE target = 'Congestion'")
for r in res.itertuples():
    reason = None if r.accepted else (
        f"accuracy {r.accuracy:.4f} does not beat baseline {best_base:.4f} ({best_base_name})")
    cur.execute("""INSERT INTO gold.ml_model_metrics
        (model_name,target,r2,mae,rank,accepted,rejected_reason,uses_weather,diagnosis,updated_at)
        VALUES (%s,'Congestion',%s,%s,%s,%s,%s,false,%s,now())""",
        (r.model, float(r.accuracy), float(r.log_loss), int(r.rank), bool(r.accepted), reason,
         "accuracy is averaged over horizons 1-12h; see gold.ml_congestion_horizon_accuracy"))
for k, v in baselines.items():
    cur.execute("""INSERT INTO gold.ml_model_metrics
        (model_name,target,r2,rank,accepted,rejected_reason,uses_weather,updated_at)
        VALUES (%s,'Congestion',%s,NULL,false,'baseline, not a candidate',false,now())""",
        (k, float(accuracy_score(yte, v))))

cur.execute("""
  CREATE TABLE IF NOT EXISTS gold.ml_congestion_horizon_accuracy (
    id serial PRIMARY KEY, model_name text NOT NULL, horizon int NOT NULL,
    accuracy numeric(8,5), n int, persistence_accuracy numeric(8,5),
    updated_at timestamptz DEFAULT now())""")
cur.execute("""COMMENT ON TABLE gold.ml_congestion_horizon_accuracy IS
  'Congestion classification accuracy per forecast horizon (1-12h). The previous run could not produce this: its target was never shifted by the horizon, so all twelve horizons were the same prediction. A single averaged accuracy hides the decay, which is the whole point of a horizon.'""")
cur.execute("DELETE FROM gold.ml_congestion_horizon_accuracy")
for row in per_h:
    for name in res.model:
        cur.execute("""INSERT INTO gold.ml_congestion_horizon_accuracy
            (model_name, horizon, accuracy, n, persistence_accuracy) VALUES (%s,%s,%s,%s,%s)""",
            (name, row["horizon"], float(row[name]), row["n"], float(row["Persistence"])))

# Serve the champion's genuine per-horizon forecast from the newest window.
champ = res.iloc[0]
print(f"  champion: {champ.model} (acc {champ.accuracy:.4f})")
out = []
if champ.model == "GRU" and gru is not None:
    seq = np.stack([piv.values[-SEQ_LEN:, :], jm.values[-SEQ_LEN:, :]], -1)   # (SEQ, exits, 2)
    pr_ = gru.predict(np.transpose(seq, (1, 0, 2)).astype("float32"), verbose=0)  # (exits, H, 3)
    for c in range(pr_.shape[0]):
        for k, hz in enumerate(HORIZONS):
            kk = int(pr_[c, k].argmax())
            out.append((exits[c], hz, STATES[kk], float(pr_[c, k, kk])))
else:
    last = df.ts.max()
    latest = df[df.ts == last].copy()
    for hz in HORIZONS:
        q = latest.copy()
        q["horizon"] = hz
        mdl = xgb if champ.model == "XGBoost" else qrf
        pr_ = mdl.predict_proba(q[FEATS])
        for i, r in enumerate(q.itertuples()):
            kk = int(pr_[i].argmax())
            out.append((r.exit_name, hz, STATES[kk], float(pr_[i][kk])))

# WHEN the forecast is counted from. Without this "+1h" is a label with no
# referent - a reader cannot tell whether it means one hour from now, from the
# last data drop, or from midnight. It is the last COMPLETE hour of Waze
# ingestion, which is also the last hour the model actually saw.
BASE_TS = df.ts.max()
cur.execute("ALTER TABLE gold.ml_predictive_congestion ADD COLUMN IF NOT EXISTS base_ts timestamp")
cur.execute("""COMMENT ON COLUMN gold.ml_predictive_congestion.base_ts IS
  'Last complete hour of Waze ingestion; hours_ahead counts forward from here. Trailing hours with sparse ingestion are trimmed before training, so this is the last hour genuinely observed rather than the last row present.'""")
cur.execute("DELETE FROM gold.ml_predictive_congestion")
for seg, hz, st, pb in out:
    cur.execute("""INSERT INTO gold.ml_predictive_congestion
                   (segment_name, hours_ahead, congestion_state, probability, base_ts)
                   VALUES (%s,%s,%s,%s,%s)""", (seg, hz, st, pb, BASE_TS.to_pydatetime()))
print(f"  forecast base time: {BASE_TS} (+1h = {BASE_TS + pd.Timedelta(hours=1)})")
conn.commit()

cur.execute("""SELECT COUNT(*), COUNT(DISTINCT (congestion_state, probability))
               FROM gold.ml_predictive_congestion""")
n, distinct = cur.fetchone()
print(f"  ml_predictive_congestion: {n} rows, {distinct} distinct (state,probability) pairs")
print("  (the old run had exactly 20 — one per exit, repeated 12 times)")

json.dump({
    "generated": str(pd.Timestamp.now().date()),
    "fix": "target shifted by horizon; previous run trained every horizon on the same timestamp",
    "candidates": res.to_dict("records"),
    "baselines": {k: float(accuracy_score(yte, v)) for k, v in baselines.items()},
    "best_baseline": {"name": best_base_name, "accuracy": float(best_base)},
    "per_horizon": per_h,
}, open(Path(__file__).with_name("congestion_results_horizon.json"), "w"), indent=2)
print("  congestion_results_horizon.json written")
conn.close()
banner("DONE")
