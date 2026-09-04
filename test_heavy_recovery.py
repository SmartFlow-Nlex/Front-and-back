"""
Can the Heavy class be recovered?

GRU won on accuracy while predicting Heavy exactly zero times. That is the
rational move when a class is 4.5% of the data and poorly separated: ignoring it
costs little accuracy. The question is whether Heavy is genuinely unlearnable
here, or merely unrewarded by an accuracy objective.

Three interventions, same data, same split, same test set:
  1. class weights   - make Heavy errors expensive
  2. oversampling    - rebalance the training distribution
  3. threshold shift - keep the model, lower the bar for calling Heavy

Reported as an accuracy / Heavy-recall trade-off, so the cost of each is visible.
"""
import warnings
import numpy as np
import pandas as pd
import psycopg2
from sklearn.metrics import accuracy_score, f1_score, precision_recall_fscore_support
from sklearn.utils.class_weight import compute_class_weight

warnings.filterwarnings("ignore")
PG = ("host=smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com port=5432 "
      "dbname=nlex_capstone user=postgres password=Hanszy123! sslmode=require")
STATES = ["Free flow", "Heavy", "Severe"]
SEVERE, HEAVY = 30.0, 60.0
TEST_DAYS, SEQ_LEN = 7, 24


def banner(t):
    print("\n" + "=" * 68 + f"\n  {t}\n" + "=" * 68)


conn = psycopg2.connect(PG)
jams = pd.read_sql_query("""
    SELECT j.date_day::date AS d, j.hour_of_day::int AS h,
           COALESCE(e.exit_name,'id_'||j.nlex_exit_id::text) AS exit_name,
           j.speed_kmh::float AS speed, j.length_meters::float AS len
    FROM silver.fact_waze_jams j
    LEFT JOIN bronze.nlex_exits e ON e.id = j.nlex_exit_id
    WHERE j.speed_kmh IS NOT NULL""", conn)
jams["w"] = jams["len"].clip(lower=1.0)
cell = (jams.assign(sw=jams.speed * jams.w).groupby(["d", "h", "exit_name"])
        .agg(sw=("sw", "sum"), w=("w", "sum"), n=("speed", "size")).reset_index())
cell["speed"] = cell.sw / cell.w

days = pd.date_range(jams.d.min(), jams.d.max(), freq="D").date
exits = sorted(jams.exit_name.unique())
df = (pd.MultiIndex.from_product([days, range(24), exits], names=["d", "h", "exit_name"])
      .to_frame(index=False).merge(cell[["d", "h", "exit_name", "speed", "n"]],
                                   on=["d", "h", "exit_name"], how="left"))
df["y"] = np.where(df.speed.isna(), 0, np.where(df.speed < SEVERE, 2, np.where(df.speed < HEAVY, 1, 0)))
df["n"] = df.n.fillna(0)
df["ts"] = pd.to_datetime(df.d.astype(str)) + pd.to_timedelta(df.h, unit="h")
df = df.sort_values(["exit_name", "ts"]).reset_index(drop=True)
df["exit_code"] = pd.Categorical(df.exit_name, categories=exits).codes
cut = df.ts.max().normalize() - pd.Timedelta(days=TEST_DAYS - 1)

piv = df.pivot_table(index="ts", columns="exit_code", values="y").sort_index()
jm = df.pivot_table(index="ts", columns="exit_code", values="n").sort_index()


def seqs(keep):
    X, Y = [], []
    a, j = piv.values, jm.values
    for i in range(SEQ_LEN, len(piv)):
        if not keep(piv.index[i]):
            continue
        for c in range(a.shape[1]):
            X.append(np.stack([a[i - SEQ_LEN:i, c], j[i - SEQ_LEN:i, c]], -1))
            Y.append(a[i, c])
    return np.array(X, "float32"), np.array(Y, "int32")


Xtr, ytr = seqs(lambda t: t < cut)
Xte, yte = seqs(lambda t: t >= cut)
print(f"  train {len(Xtr):,} sequences | test {len(Xte):,}")
d = pd.Series(ytr).value_counts(normalize=True).sort_index()
print("  train class mix: " + "  ".join(f"{STATES[i]} {d.get(i,0)*100:.1f}%" for i in range(3)))

import tensorflow as tf
from tensorflow.keras import layers, Sequential


def build():
    tf.random.set_seed(42)
    m = Sequential([layers.Input((SEQ_LEN, 2)), layers.GRU(48), layers.Dropout(0.2),
                    layers.Dense(32, activation="relu"), layers.Dense(3, activation="softmax")])
    m.compile("adam", "sparse_categorical_crossentropy", metrics=["accuracy"])
    return m


def report(name, proba, note=""):
    pred = proba.argmax(1)
    acc = accuracy_score(yte, pred)
    mf1 = f1_score(yte, pred, average="macro")
    pr, rc, f1s, _ = precision_recall_fscore_support(yte, pred, labels=[0, 1, 2], zero_division=0)
    nheavy = int((pred == 1).sum())
    print(f"  {name:<26} acc {acc:.4f}  macroF1 {mf1:.4f}  HeavyRec {rc[1]:.4f}  "
          f"HeavyPrec {pr[1]:.4f}  predicted-Heavy {nheavy:,}  {note}")
    return {"name": name, "acc": acc, "macro_f1": mf1, "heavy_recall": rc[1],
            "heavy_prec": pr[1], "n_heavy": nheavy}


banner("Baseline GRU (what was accepted)")
m0 = build(); m0.fit(Xtr, ytr, epochs=25, batch_size=128, verbose=0)
p0 = m0.predict(Xte, verbose=0)
rows = [report("GRU (as accepted)", p0)]

banner("1. Class weights")
cw = compute_class_weight("balanced", classes=np.array([0, 1, 2]), y=ytr)
print(f"  weights: Free {cw[0]:.2f}  Heavy {cw[1]:.2f}  Severe {cw[2]:.2f}")
m1 = build(); m1.fit(Xtr, ytr, epochs=25, batch_size=128, verbose=0,
                     class_weight={i: float(cw[i]) for i in range(3)})
rows.append(report("GRU + class weights", m1.predict(Xte, verbose=0)))

banner("2. Oversampling Heavy")
idx = np.arange(len(ytr))
hv = idx[ytr == 1]
extra = np.random.RandomState(42).choice(hv, size=len(hv) * 5, replace=True)
bal = np.concatenate([idx, extra])
print(f"  Heavy rows {len(hv):,} -> {len(hv)*6:,} (6x)")
m2 = build(); m2.fit(Xtr[bal], ytr[bal], epochs=25, batch_size=128, verbose=0)
rows.append(report("GRU + oversampling", m2.predict(Xte, verbose=0)))

banner("3. Threshold shift on the accepted model")
print("  Same GRU, no retraining — call Heavy whenever P(Heavy) exceeds a lower bar.")
for t in [0.30, 0.20, 0.15, 0.10, 0.05]:
    p = p0.copy()
    pred = np.where(p[:, 1] >= t, 1, np.where(p[:, 2] >= p[:, 0], 2, 0))
    acc = accuracy_score(yte, pred)
    pr, rc, _, _ = precision_recall_fscore_support(yte, pred, labels=[0, 1, 2], zero_division=0)
    print(f"    P(Heavy) >= {t:.2f}   acc {acc:.4f}   HeavyRec {rc[1]:.4f}   "
          f"HeavyPrec {pr[1]:.4f}   predicted-Heavy {(pred==1).sum():,}")

banner("How separable is Heavy at all?")
print("  Max P(Heavy) the accepted model ever assigns: "
      f"{p0[:,1].max():.4f}   (mean {p0[:,1].mean():.4f})")
act_heavy = p0[yte == 1, 1]
print(f"  On rows that ARE Heavy: mean P(Heavy) {act_heavy.mean():.4f}, max {act_heavy.max():.4f}")
print(f"  On rows that are NOT  : mean P(Heavy) {p0[yte!=1,1].mean():.4f}")

banner("Trade-off summary")
print(f"  {'variant':<26}{'acc':>8}{'macroF1':>10}{'HeavyRec':>10}{'HeavyPrec':>11}")
for r in rows:
    print(f"  {r['name']:<26}{r['acc']:>8.4f}{r['macro_f1']:>10.4f}{r['heavy_recall']:>10.4f}{r['heavy_prec']:>11.4f}")
print(f"\n  baseline to beat (exit-hour profile): 0.7488")
conn.close()
