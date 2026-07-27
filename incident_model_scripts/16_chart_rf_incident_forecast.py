"""
STAGE 16 - Random Forest incident forecast chart (PAST / PRESENT / FUTURE)
=========================================================================
Panel A champion. The chart mirrors the evaluation in the report EXACTLY:

  PAST    - the walk-forward initial training base (first 60% of the panel)
  PRESENT - the walk-forward validation region (the 3 expanding-window test
            folds). Every metric shown on the chart is measured here.
  FUTURE  - recursive multi-step forecast beyond the walk-forward window

Metrics are COMPUTED from the fold predictions this script produces - training and
testing is the point, so the numbers have to be derived, not copied. Because the
fold placement, model config and seed match 13_train_incident_models.py, they
reproduce the report's values rather than transcribe them. The script then
cross-checks itself against random_forest_results.json and warns loudly if the
two disagree, which is exactly the signal you want if the pipeline drifts.

There is no 80/20 split here. The window expands (76% -> 84% -> 92%) and the final
fold ends flush against the data edge, so the forecast starts where validation
stops instead of covering dates that already have actuals.

Fold predictions are genuinely out-of-sample: fold i trains on [0, tr_end) and
predicts [tr_end, te_end). No fitted-on-training line is drawn - in-sample fit is
not what the model is being judged on.

Counts are plotted as DAILY totals; raw hourly counts (0-5) are unreadable over a
6-year span. The model itself remains hourly.
"""
import os
import sys
import json
import warnings
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from matplotlib.lines import Line2D

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from incident_metrics import compute_metrics, split_r2, average_folds

from sklearn.ensemble import RandomForestRegressor

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "outputs", "dataset")
OUT = os.path.join(HERE, "outputs", "models")
os.makedirs(DATA, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

SEED = 42
WARMUP = 168
FUTURE_HOURS = 24 * 30
# must match wf_splits() in 13_train_incident_models.py exactly
N_FOLDS, MIN_TRAIN, TEST_FRAC = 3, 0.76, 0.08
SEASONALITY = 24                 # seasonal-naive benchmark for MASE/RMSSE

# validated 2-series palette (six-checks PASS, light surface)
C_ACTUAL = "#1F5FA8"
C_MODEL = "#D9722B"
Z_PAST, Z_PRESENT, Z_FUTURE = "#4A90D9", "#E8945A", "#5CB85C"
INK, MUTED = "#1F2328", "#6B7280"

FEATURES = [
    "hour_sin", "hour_cos", "dow_sin", "dow_cos", "month_sin", "month_cos",
    "is_weekend", "is_rush_hour",
    "inc_lag_1h", "inc_lag_2h", "inc_lag_3h", "inc_lag_24h", "inc_lag_168h",
    "inc_roll_24h", "inc_roll_168h",
]


def wf_splits(n, n_folds=N_FOLDS, min_train=MIN_TRAIN, test_frac=TEST_FRAC):
    out, ts, mt = [], int(n * test_frac), int(n * min_train)
    for i in range(n_folds):
        tr_e = mt + i * ts
        te_e = min(tr_e + ts, n)
        if tr_e >= n or te_e <= tr_e:
            break
        out.append((0, tr_e, tr_e, te_e))
    return out


def calendar_row(ts):
    h, dow, mth = ts.hour, ts.dayofweek, ts.month
    return {
        "hour_sin": np.sin(2 * np.pi * h / 24), "hour_cos": np.cos(2 * np.pi * h / 24),
        "dow_sin": np.sin(2 * np.pi * dow / 7), "dow_cos": np.cos(2 * np.pi * dow / 7),
        "month_sin": np.sin(2 * np.pi * mth / 12), "month_cos": np.cos(2 * np.pi * mth / 12),
        "is_weekend": 1.0 if dow >= 5 else 0.0,
        "is_rush_hour": 1.0 if h in (6, 7, 8, 9, 16, 17, 18, 19) else 0.0,
    }


def recursive_forecast(model, history, start_ts, n_hours):
    buf = list(history[-336:])
    preds, stamps = [], []
    for i in range(n_hours):
        ts = start_ts + pd.Timedelta(hours=i)
        r = calendar_row(ts)
        r["inc_lag_1h"], r["inc_lag_2h"], r["inc_lag_3h"] = buf[-1], buf[-2], buf[-3]
        r["inc_lag_24h"], r["inc_lag_168h"] = buf[-24], buf[-168]
        r["inc_roll_24h"] = float(np.mean(buf[-24:]))
        r["inc_roll_168h"] = float(np.mean(buf[-168:]))
        p = float(max(model.predict(np.array([[r[f] for f in FEATURES]]))[0], 0.0))
        preds.append(p)
        stamps.append(ts)
        buf.append(p)
    return pd.Series(preds, index=pd.DatetimeIndex(stamps))


def main():
    print("Loading hourly incident panel ...")
    df = pd.read_csv(f"{DATA}/incidents_only_hourly_global.csv", parse_dates=["dt"])
    df = df.sort_values(["dt", "hour_of_day"]).reset_index(drop=True)
    df["ts"] = df["dt"] + pd.to_timedelta(df["hour_of_day"], unit="h")
    df = df.iloc[WARMUP:].reset_index(drop=True)

    X = df[FEATURES].values.astype(float)
    y = df["incident_count"].values.astype(float)
    ts = pd.DatetimeIndex(df["ts"])
    n = len(df)

    splits = wf_splits(n)
    pres_start = splits[0][2]          # first fold's test start = end of PAST
    pres_end = splits[-1][3]           # last fold's test end = forecast origin
    print(f"  panel {n} hours  {ts[0].date()} -> {ts[-1].date()}")
    print(f"  PAST    {ts[0].date()} -> {ts[pres_start].date()}  ({pres_start} h)")
    print(f"  PRESENT {ts[pres_start].date()} -> {ts[pres_end - 1].date()}  "
          f"({pres_end - pres_start} h, {len(splits)} folds)")

    # ---- walk-forward out-of-sample predictions + metrics, fold by fold ----
    pred = np.full(n, np.nan)
    fold_m, fold_s = [], []
    for i, (s1, e1, s2, e2) in enumerate(splits):
        m = RandomForestRegressor(n_estimators=300, max_depth=12, min_samples_leaf=20,
                                  random_state=SEED, n_jobs=-1)
        m.fit(X[s1:e1], y[s1:e1])
        p_tr = np.clip(m.predict(X[s1:e1]), 0, None)
        p_te = np.clip(m.predict(X[s2:e2]), 0, None)
        pred[s2:e2] = p_te
        fold_m.append(compute_metrics(y[s2:e2], p_te, y_train=y[s1:e1],
                                      n_features=len(FEATURES),
                                      seasonality=SEASONALITY))
        fold_s.append(split_r2(y[s1:e1], p_tr, y[s2:e2], p_te))
        print(f"    fold {i+1}: train {e1-s1:6d}h  test {e2-s2:5d}h  "
              f"{ts[s2].date()} -> {ts[e2-1].date()}  "
              f"MAE={fold_m[-1]['MAE']} MASE={fold_m[-1]['MASE']}")

    # ---- forecast recursively from the end of the walk-forward window ----
    print(f"  forecasting {FUTURE_HOURS}h from {ts[pres_end - 1].date()} ...")
    rf_fc = RandomForestRegressor(n_estimators=300, max_depth=12, min_samples_leaf=20,
                                  random_state=SEED, n_jobs=-1)
    rf_fc.fit(X[:pres_end], y[:pres_end])
    fut = recursive_forecast(rf_fc, y[:pres_end],
                             ts[pres_end - 1] + pd.Timedelta(hours=1), FUTURE_HOURS)

    # ---- metrics: computed from the fold predictions above ----
    M, S = average_folds(fold_m), average_folds(fold_s)
    print(f"  computed: MAE {M['MAE']}  RMSE {M['RMSE']}  PoisDev {M['Poisson_Deviance']}  "
          f"MASE {M['MASE']}  R2 {M['R2']}  Gap {S['Gap']}")

    # ---- self-check against the report; loud if they diverge ----
    rp = f"{OUT}/random_forest_results.json"
    if os.path.exists(rp):
        with open(rp) as fh:
            ref = json.load(fh)
        rM, rS = ref["metrics"], ref["split_r2_diagnostic"]
        diffs = [(k, M.get(k), rM.get(k)) for k in ("MAE", "RMSE", "Poisson_Deviance",
                                                    "MASE", "R2")
                 if isinstance(M.get(k), (int, float))
                 and isinstance(rM.get(k), (int, float))
                 and abs(M[k] - rM[k]) > 1e-4]
        if isinstance(S.get("Gap"), (int, float)) and isinstance(rS.get("Gap"), (int, float)) \
                and abs(S["Gap"] - rS["Gap"]) > 1e-4:
            diffs.append(("Gap", S["Gap"], rS["Gap"]))
        if diffs:
            print("  !! MISMATCH vs random_forest_results.json - the chart and the "
                  "report disagree. Re-run 13_train_incident_models.py.")
            for k, a, b in diffs:
                print(f"       {k:18s} chart={a}  report={b}")
        else:
            print("  [OK] matches random_forest_results.json exactly")

    # ---- daily rollups ----
    d_act = pd.Series(y[:pres_end], index=ts[:pres_end]).resample("D").sum()
    d_pred = pd.Series(pred[pres_start:pres_end],
                       index=ts[pres_start:pres_end]).resample("D").sum()
    d_fut = fut.resample("D").sum()

    # accuracy of the forecast against the actuals that exist beyond the
    # walk-forward window (measured, not drawn - blue stops at PRESENT)
    tail = pd.Series(y[pres_end:], index=ts[pres_end:]).resample("D").sum()
    ov = d_fut.index.intersection(tail.index)
    fc_mae = (float(np.mean(np.abs(d_fut[ov].values - tail[ov].values)))
              if len(ov) else None)
    if fc_mae is not None:
        print(f"  forecast vs held-back actuals: {len(ov)} days, daily MAE {fc_mae:.2f}")

    split_ts, end_ts = ts[pres_start], ts[pres_end - 1]

    # ================= PLOT =================
    roll_act = d_act.rolling(7, min_periods=1).mean()
    roll_pred = d_pred.rolling(7, min_periods=1).mean()

    fig, (ax1, ax2) = plt.subplots(
        2, 1, figsize=(16, 10),
        gridspec_kw={"height_ratios": [1.35, 1], "hspace": 0.55})
    fig.patch.set_facecolor("white")

    def style(ax):
        ax.set_facecolor("white")
        ax.grid(True, alpha=0.22, ls="-", lw=0.7)
        ax.set_axisbelow(True)
        for sp in ("top", "right"):
            ax.spines[sp].set_visible(False)
        for sp in ("left", "bottom"):
            ax.spines[sp].set_color("#D0D3D8")
        ax.tick_params(colors=MUTED, labelsize=9)

    # ---------- PANEL 1: full walk-forward span ----------
    style(ax1)
    ax1.axvspan(d_act.index[0], split_ts, alpha=0.10, color=Z_PAST, lw=0)
    ax1.axvspan(split_ts, end_ts, alpha=0.13, color=Z_PRESENT, lw=0)
    ax1.axvspan(end_ts, d_fut.index[-1], alpha=0.16, color=Z_FUTURE, lw=0)
    for x in (split_ts, end_ts):
        ax1.axvline(x, color="#444444", ls="--", lw=1.1, alpha=0.75, zorder=2)

    ax1.plot(d_act.index, d_act.values, color=C_ACTUAL, lw=0.5, alpha=0.28, zorder=3)
    ax1.plot(roll_act.index, roll_act.values, color=C_ACTUAL, lw=1.9, zorder=5)
    ax1.plot(roll_pred.index, roll_pred.values, color=C_MODEL, lw=1.7, zorder=6)
    ax1.plot(d_fut.index, d_fut.values, color=C_MODEL, lw=2.0, ls="--", zorder=7)

    ymax1 = float(d_act.max()) * 1.20
    ax1.set_ylim(0, ymax1)
    span = (d_fut.index[-1] - d_act.index[0]).days
    for x0, x1, txt in [(d_act.index[0], split_ts, "PAST  (training)"),
                        (split_ts, end_ts, "PRESENT  (walk-forward validation)")]:
        if (x1 - x0).days / span > 0.10:
            ax1.text(x0 + (x1 - x0) / 2, ymax1 * 0.96, txt, ha="center", va="top",
                     fontsize=10, fontweight="bold", color=MUTED)
    ax1.annotate("FUTURE\n(30 days)", xy=(end_ts, ymax1 * 0.52), xytext=(-96, 26),
                 textcoords="offset points", ha="center", fontsize=9,
                 fontweight="bold", color="#2F7D32",
                 arrowprops=dict(arrowstyle="->", color="#2F7D32", lw=1.3))

    ax1.set_title("Random Forest - NLEX Incident Count Forecast\n"
                  "SmartFlow | daily totals | 3-fold walk-forward | "
                  "incident tables only (no weather)",
                  fontsize=13, fontweight="bold", color=INK, pad=14)
    ax1.set_ylabel("Incidents per day", fontsize=10, color=MUTED)
    ax1.legend(handles=[
        Line2D([0], [0], color=C_ACTUAL, lw=2, label="Actual (7-day mean)"),
        Line2D([0], [0], color=C_MODEL, lw=2, label="RF predicted (out-of-sample)"),
        Line2D([0], [0], color=C_MODEL, lw=2, ls="--", label="RF forecast (recursive)"),
        Patch(facecolor=Z_PAST, alpha=0.30, label="PAST (train)"),
        Patch(facecolor=Z_PRESENT, alpha=0.30, label="PRESENT (validation)"),
        Patch(facecolor=Z_FUTURE, alpha=0.40, label="FUTURE (30 days)"),
    ], loc="upper center", bbox_to_anchor=(0.5, -0.09), ncol=6,
        frameon=False, fontsize=9)
    for lb in ax1.get_xticklabels():
        lb.set_rotation(0)
        lb.set_ha("center")

    # ---------- PANEL 2: zoom on validation tail + forecast ----------
    style(ax2)
    zoom_start = end_ts - pd.Timedelta(days=75)
    za = d_act[d_act.index >= zoom_start]
    zp = d_pred[d_pred.index >= zoom_start]

    ax2.axvspan(zoom_start, end_ts, alpha=0.13, color=Z_PRESENT, lw=0)
    ax2.axvspan(end_ts, d_fut.index[-1], alpha=0.16, color=Z_FUTURE, lw=0)
    ax2.axvline(end_ts, color="#444444", ls="--", lw=1.2, alpha=0.85, zorder=2)

    ax2.plot(za.index, za.values, color=C_ACTUAL, lw=1.8, marker="o", ms=3.2,
             label="Actual incidents", zorder=4)
    ax2.plot(zp.index, zp.values, color=C_MODEL, lw=1.8, marker="o", ms=3.2,
             label="RF predicted", zorder=5)
    ax2.plot(d_fut.index, d_fut.values, color=C_MODEL, lw=2.2, ls="--",
             marker="o", ms=3.2, label="RF forecast", zorder=6)

    ymax2 = max(float(za.max()), float(d_fut.max())) * 1.26
    ax2.set_ylim(0, ymax2)
    ax2.text(zoom_start + (end_ts - zoom_start) / 2, ymax2 * 0.965,
             "PRESENT  (actual vs predicted)", ha="center", va="top",
             fontsize=10, fontweight="bold", color=MUTED)
    ax2.text(end_ts + (d_fut.index[-1] - end_ts) / 2, ymax2 * 0.965,
             "FUTURE  (forecast)", ha="center", va="top",
             fontsize=10, fontweight="bold", color="#2F7D32")

    ax2.set_title(f"Zoom - last 75 days of walk-forward validation + 30-day forecast "
                  f"(validation ends {end_ts.date()})",
                  fontsize=11, fontweight="bold", color=INK, pad=10)
    ax2.set_xlabel("Date", fontsize=10, color=MUTED)
    ax2.set_ylabel("Incidents per day", fontsize=10, color=MUTED)
    ax2.legend(loc="lower left", frameon=True, framealpha=0.94, fontsize=9, ncol=3)
    for lb in ax2.get_xticklabels():
        lb.set_rotation(30)
        lb.set_ha("right")

    # ---- metrics strip: identical to INCIDENT_MODEL_REPORT.txt ----
    strip = (f"3-fold walk-forward (hourly):   MAE {M['MAE']}   RMSE {M['RMSE']}   "
             f"Poisson Dev {M['Poisson_Deviance']}   MASE {M['MASE']}   "
             f"R2 {M['R2']}   |   Train R2 {S['Train_R2']}  Val R2 {S['Val_R2']}  "
             f"Gap {S['Gap']}")
    fig.text(0.5, 0.030, strip, ha="center", fontsize=9.5, color=INK,
             bbox=dict(boxstyle="round,pad=0.5", facecolor="#F3F4F6",
                       edgecolor="#D0D3D8"))
    note = ("Metrics computed from the walk-forward folds above (expanding window "
            "76%/84%/92%, no fixed train-test ratio). Validation is one-step-ahead on "
            "real lags; the forecast is recursive, so it damps toward the seasonal mean.")
    fig.text(0.5, 0.004, note, ha="center", fontsize=8.5, color=MUTED, style="italic")

    plt.tight_layout(rect=[0, 0.06, 1, 1])
    png = f"{OUT}/chart_rf_incident_forecast.png"
    plt.savefig(png, dpi=200, bbox_inches="tight", facecolor="white")
    plt.close()
    print(f"  saved {png}")

    # ---- companion table + forecast exports ----
    pd.concat([d_act.rename("actual_incidents"),
               d_pred.rename("rf_predicted_walkforward"),
               d_fut.rename("rf_forecast")], axis=1).rename_axis("date") \
      .to_csv(f"{OUT}/chart_rf_incident_forecast_data.csv")
    fut.rename("forecast_incidents").to_frame().to_csv(
        f"{OUT}/rf_incident_forecast_hourly_30d.csv", index_label="timestamp")
    with open(f"{OUT}/rf_incident_forecast_summary.json", "w") as fh:
        json.dump({
            "model": "Random Forest",
            "validation": "3-fold expanding-window walk-forward",
            "metrics_source": "computed from this script's walk-forward folds",
            "metrics": M, "split_r2": S,
            "past_end": str(split_ts), "validation_end": str(end_ts),
            "forecast_end": str(fut.index[-1]),
            "forecast_horizon_hours": FUTURE_HOURS,
            "forecast_daily_mean": round(float(d_fut.mean()), 3),
            "forecast_vs_heldback_actuals_daily_mae": (
                round(fc_mae, 3) if fc_mae is not None else None),
        }, fh, indent=4, default=str)


if __name__ == "__main__":
    main()
