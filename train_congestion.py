"""
Congestion state classifier — honest training and evaluation.

Replaces gold.ml_predictive_congestion, which held 108 static rows labelled
"XGBoost" with no model behind them: no training record, no metrics, no
timestamps, and probabilities drawn uniformly from [0.75, 0.95] with the same
distribution for every class. That table was a mockup presented as a model.

WHAT THIS USES
  silver.fact_waze_jams — Waze Partner Hub jams, the only source with usable
  exit attribution (20 canonical exits, 2026-08-04..2026-09-01).

  bronze.waze_hourly_jams has 4 years but its "nlex_exit_id" holds 289,787
  distinct values with 289,709 appearing exactly once — a jam UUID, not an exit
  reference. It cannot be attributed to segments, so it is not used.

  bronze.nlex_traffic_volume.avg_speed_kmh is NOT used: 429,049 of 2,086,512
  values are negative (20.6%), unchanged in the silver "clean" layer.

LABEL
  Free flow / Heavy / Severe, per the dashboard's own legend.

  Waze reports jams, so free flow is never observed directly — zero rows exceed
  60 km/h in the 4-year table, 90 of 59,587 in the recent one. Absence of a jam
  in a segment-hour is therefore taken as free flow. That is an INFERENCE, not a
  measurement, and it is stated on the panel and in the report.

HONEST LIMITS
  28 days only. No seasonality, no holiday coverage, and traffic volume cannot
  be a feature because gold.fact_traffic_hourly (2022-2025) does not overlap the
  jam window at all. Reported as-is rather than papered over.
"""
import json
import numpy as np
import pandas as pd
import psycopg2
from sklearn.metrics import (accuracy_score, f1_score, precision_recall_fscore_support,
                             confusion_matrix, log_loss)
from xgboost import XGBClassifier

PG = ("host=smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com port=5432 "
      "dbname=nlex_capstone user=postgres password=Hanszy123! sslmode=require")

HORIZONS = list(range(1, 13))          # dashboard shows +1h .. +12h
# Wire values the dashboard expects; display labels live in the frontend.
STATES = ["Low", "Med", "High"]
SEVERE_KMH, HEAVY_KMH = 30.0, 60.0
TEST_DAYS = 7                           # final 7 days held out, temporal split


def banner(t):
    print("\n" + "=" * 68 + f"\n  {t}\n" + "=" * 68)


# ── 1. LOAD ───────────────────────────────────────────────────────────────────
banner("STEP 1: Loading Waze jams")
conn = psycopg2.connect(PG)

jams = pd.read_sql_query("""
    SELECT j.date_day::date AS d, j.hour_of_day::int AS h,
           COALESCE(e.exit_name, 'id_' || j.nlex_exit_id::text) AS exit_name,
           j.speed_kmh::float AS speed, j.length_meters::float AS len
    FROM silver.fact_waze_jams j
    LEFT JOIN bronze.nlex_exits e ON e.id = j.nlex_exit_id
    WHERE j.speed_kmh IS NOT NULL
""", conn)
print(f"  jam records : {len(jams):,}")
print(f"  window      : {jams.d.min()} .. {jams.d.max()}  ({jams.d.nunique()} days)")
print(f"  exits       : {jams.exit_name.nunique()}")

# Length-weighted mean speed per cell: a 3 km crawl should outweigh a 50 m one.
jams["wlen"] = jams["len"].clip(lower=1.0)
jams["sp_w"] = jams["speed"] * jams["wlen"]
cell = (jams.groupby(["d", "h", "exit_name"])
             .agg(sp_w=("sp_w", "sum"), wlen=("wlen", "sum"), n_jams=("speed", "size"))
             .reset_index())
cell["speed"] = cell["sp_w"] / cell["wlen"]
cell = cell[["d", "h", "exit_name", "speed", "n_jams"]]
print(f"  cells with a jam: {len(cell):,}")

# ── 2. COMPLETE GRID + LABEL ──────────────────────────────────────────────────
banner("STEP 2: Building the complete segment-hour grid")
days = pd.date_range(jams.d.min(), jams.d.max(), freq="D").date
exits = sorted(jams.exit_name.unique())
grid = pd.MultiIndex.from_product([days, range(24), exits],
                                  names=["d", "h", "exit_name"]).to_frame(index=False)
df = grid.merge(cell, on=["d", "h", "exit_name"], how="left")

def label(r):
    if pd.isna(r.speed):
        return 0                                   # no jam reported -> free flow
    return 2 if r.speed < SEVERE_KMH else (1 if r.speed < HEAVY_KMH else 0)

df["y"] = df.apply(label, axis=1)
df["n_jams"] = df["n_jams"].fillna(0)
print(f"  grid: {len(df):,} cells  ({len(days)} days x 24h x {len(exits)} exits)")
dist = df.y.value_counts().sort_index()
for i, s in enumerate(STATES):
    n = int(dist.get(i, 0))
    print(f"    {s:<10} {n:>7,}  {n/len(df)*100:5.1f}%")

# ── 3. FEATURES ───────────────────────────────────────────────────────────────
banner("STEP 3: Feature engineering")
df["ts"] = pd.to_datetime(df.d.astype(str)) + pd.to_timedelta(df.h, unit="h")
df = df.sort_values(["exit_name", "ts"]).reset_index(drop=True)
df["dow"] = df.ts.dt.dayofweek
df["is_weekend"] = (df.dow >= 5).astype(int)

# Lag-24h and lag-48h are legitimate at every horizon <= 12: standing at
# t-h with h <= 12, the value at t-24 is already in the past.
g = df.groupby("exit_name", sort=False)
df["lag24"] = g["y"].shift(24)
df["lag48"] = g["y"].shift(48)
df["lag24_jams"] = g["n_jams"].shift(24)
df = df.dropna(subset=["lag24", "lag48"]).reset_index(drop=True)

df["exit_code"] = pd.Categorical(df.exit_name, categories=exits).codes
FEATS = ["exit_code", "h", "dow", "is_weekend", "lag24", "lag48", "lag24_jams", "horizon"]
print(f"  usable rows after lags: {len(df):,}")

# ── 4. TEMPORAL SPLIT ─────────────────────────────────────────────────────────
banner("STEP 4: Temporal split")
cut = df.ts.max().normalize() - pd.Timedelta(days=TEST_DAYS - 1)
print(f"  train : {df.ts.min().date()} .. {(cut - pd.Timedelta(hours=1)).date()}")
print(f"  test  : {cut.date()} .. {df.ts.max().date()}   ({TEST_DAYS} days held out)")

# One row per (cell, horizon): the model is asked "state at t, standing h hours before".
rows = []
for hz in HORIZONS:
    t = df.copy()
    t["horizon"] = hz
    rows.append(t)
full = pd.concat(rows, ignore_index=True)

tr = full[full.ts < cut]
te = full[full.ts >= cut]
print(f"  train rows {len(tr):,}   test rows {len(te):,}")

Xtr, ytr = tr[FEATS], tr.y.values
Xte, yte = te[FEATS], te.y.values

# ── 5. BASELINES ──────────────────────────────────────────────────────────────
banner("STEP 5: Baselines (what the model must beat)")
maj = int(pd.Series(ytr).mode()[0])
base_majority = np.full(len(yte), maj)
base_persist = te["lag24"].astype(int).values          # same exit, same hour, yesterday

prof = (tr.groupby(["exit_code", "h"])["y"]
          .agg(lambda s: s.mode().iloc[0]).rename("mode_y").reset_index())
base_profile = (te[["exit_code", "h"]].merge(prof, on=["exit_code", "h"], how="left")
                  ["mode_y"].fillna(maj).astype(int).values)

baselines = {
    "Majority class": base_majority,
    "Persistence (t-24h)": base_persist,
    "Exit-hour profile": base_profile,
}
for name, pred in baselines.items():
    print(f"  {name:<22} accuracy {accuracy_score(yte, pred):.4f}   macro-F1 {f1_score(yte, pred, average='macro'):.4f}")

# ── 6. TRAIN ──────────────────────────────────────────────────────────────────
banner("STEP 6: Training XGBoost")
clf = XGBClassifier(
    n_estimators=400, max_depth=6, learning_rate=0.08,
    subsample=0.9, colsample_bytree=0.9,
    objective="multi:softprob", num_class=3,
    eval_metric="mlogloss", random_state=42, n_jobs=4,
)
clf.fit(Xtr, ytr)
proba = clf.predict_proba(Xte)
pred = proba.argmax(axis=1)
print("  trained.")

# ── 7. EVALUATE ───────────────────────────────────────────────────────────────
banner("STEP 7: Results on the held-out 7 days")
acc = accuracy_score(yte, pred)
mf1 = f1_score(yte, pred, average="macro")
wf1 = f1_score(yte, pred, average="weighted")
ll = log_loss(yte, proba, labels=[0, 1, 2])
print(f"  accuracy    {acc:.4f}")
print(f"  macro F1    {mf1:.4f}")
print(f"  weighted F1 {wf1:.4f}")
print(f"  log loss    {ll:.4f}")

pr, rc, f1s, sup = precision_recall_fscore_support(yte, pred, labels=[0, 1, 2], zero_division=0)
print("\n  per class:")
print("    state       precision  recall      F1   support")
for i, s in enumerate(STATES):
    print(f"    {s:<10} {pr[i]:9.4f} {rc[i]:7.4f} {f1s[i]:7.4f} {sup[i]:9,}")

cm = confusion_matrix(yte, pred, labels=[0, 1, 2])
print("\n  confusion matrix (rows = actual, cols = predicted):")
print("               " + "".join(f"{s:>12}" for s in STATES))
for i, s in enumerate(STATES):
    print(f"    {s:<10} " + "".join(f"{v:>12,}" for v in cm[i]))

best_base = max(accuracy_score(yte, p) for p in baselines.values())
print(f"\n  best baseline accuracy {best_base:.4f}   model {acc:.4f}   "
      f"{'BEATS baseline' if acc > best_base else 'DOES NOT beat baseline'}")

print("\n  accuracy by horizon:")
te2 = te.copy(); te2["pred"] = pred
for hz in HORIZONS:
    m = te2.horizon == hz
    print(f"    +{hz:>2}h  {accuracy_score(te2.y[m], te2.pred[m]):.4f}   n={int(m.sum()):,}")

imp = sorted(zip(FEATS, clf.feature_importances_), key=lambda x: -x[1])
print("\n  feature importance:")
for k, v in imp:
    print(f"    {k:<12} {v:.4f}")

accepted = bool(acc > best_base)

# ── 8. WRITE ──────────────────────────────────────────────────────────────────
banner("STEP 8: Writing to AWS")
cur = conn.cursor()
cur.execute("DELETE FROM gold.ml_model_metrics WHERE target = 'Congestion'")
reason = None if accepted else f"accuracy {acc:.4f} does not beat best baseline {best_base:.4f}"
cur.execute("""
    INSERT INTO gold.ml_model_metrics
      (model_name, target, rmse, mae, mse, wmape, r2, mase, mape, smape, rmsse,
       rank, accepted, rejected_reason, uses_weather, aic, bic, updated_at)
    VALUES ('XGBoost','Congestion',NULL,NULL,NULL,NULL,%s,NULL,NULL,NULL,NULL,
            1,%s,%s,false,NULL,NULL,now())
""", (float(acc), accepted, reason))

for name, p_ in baselines.items():
    a = accuracy_score(yte, p_)
    cur.execute("""
        INSERT INTO gold.ml_model_metrics
          (model_name, target, r2, rank, accepted, rejected_reason, uses_weather, updated_at)
        VALUES (%s,'Congestion',%s,NULL,false,'baseline, not a candidate',false,now())
    """, (name, float(a)))

# Forecast grid for the dashboard: last observed hour, +1h..+12h.
last_ts = df.ts.max()
latest = df[df.ts == last_ts][["exit_name", "exit_code", "y", "n_jams"]]
out = []
for hz in HORIZONS:
    t = (last_ts + pd.Timedelta(hours=hz))
    q = latest.copy()
    q["h"] = t.hour; q["dow"] = t.dayofweek
    q["is_weekend"] = int(t.dayofweek >= 5)
    q["lag24"] = q["y"]; q["lag48"] = q["y"]; q["lag24_jams"] = q["n_jams"]
    q["horizon"] = hz
    pr_ = clf.predict_proba(q[FEATS])
    for i, r in enumerate(q.itertuples()):
        k = int(pr_[i].argmax())
        out.append((r.exit_name, hz, STATES[k], float(pr_[i][k])))

cur.execute("DELETE FROM gold.ml_predictive_congestion")
for seg, hz, st, pb in out:
    cur.execute("""INSERT INTO gold.ml_predictive_congestion
                   (segment_name, hours_ahead, congestion_state, probability)
                   VALUES (%s,%s,%s,%s)""", (seg, hz, st, pb))
conn.commit()
print(f"  ml_model_metrics       : XGBoost + {len(baselines)} baselines under target='Congestion'")
print(f"  ml_predictive_congestion: {len(out)} rows ({len(exits)} exits x {len(HORIZONS)} horizons)")

json.dump({
    "generated": str(pd.Timestamp.now().date()),
    "source": "silver.fact_waze_jams (Waze Partner Hub)",
    "window": {"from": str(jams.d.min()), "to": str(jams.d.max()), "days": int(jams.d.nunique())},
    "grid_cells": int(len(df)), "train_rows": int(len(tr)), "test_rows": int(len(te)),
    "test_days": TEST_DAYS,
    "label_rule": {"free_flow": "no jam reported (inferred)", "heavy": "30-60 km/h", "severe": "<30 km/h"},
    "metrics": {"accuracy": acc, "macro_f1": mf1, "weighted_f1": wf1, "log_loss": ll},
    "per_class": {s: {"precision": float(pr[i]), "recall": float(rc[i]),
                      "f1": float(f1s[i]), "support": int(sup[i])} for i, s in enumerate(STATES)},
    "confusion_matrix": cm.tolist(),
    "baselines": {k: float(accuracy_score(yte, v)) for k, v in baselines.items()},
    "accepted": accepted, "rejected_reason": reason,
    "feature_importance": {k: float(v) for k, v in imp},
}, open("congestion_results.json", "w"), indent=2)
print("  congestion_results.json written")
conn.close()
banner("DONE")
