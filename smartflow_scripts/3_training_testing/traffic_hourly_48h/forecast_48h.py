"""
SmartFlow NLEX - issue the 48-hour hourly traffic forecast from the latest upload.

    python forecast_48h.py                 # dry run: builds the forecast, prints a summary, writes nothing
    python forecast_48h.py --write-db      # writes gold.ml_forecast_48h_runs + gold.ml_forecast_hourly_48h
    python forecast_48h.py --write-db --if-changed   # skip when the latest run already used this history and model

Reads dataset.npz (run build_dataset.py first) and production.json (train_production.py). The forecast starts the
hour after the latest uploaded day. Per series:
  model             the production model (production.json), when the model loads and the series' last 14 days and
                    56-day daily window are complete
  fallback_profile  otherwise the current dashboard method (same weekday last week x the usual hourly shape), which is
                    what the dashboard showed before; the reason is recorded on the run
The corridor total is the sum of the series (so plaza, direction and class views add up exactly); its 80% band is
calibrated on corridor totals separately. Bands come from intervals.npz (split conformal, see train_production.py).
The run records whether the history it started from is synthetic (the team's 2026) and when it ends, so the API can
mark a stale forecast.
"""
import argparse, json, os, sys
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
import numpy as np
import pandas as pd
# psycopg2 before anything that loads TensorFlow (features/Keras): on the Linux runner the binary wheel's
# bundled libssl crashed the process (SIGABRT, exit -6) when TensorFlow had loaded first. The congestion
# trainer, which passes there, imports in this order (2 Nov 2026).
import psycopg2  # noqa: E402
from psycopg2.extras import Json, execute_values  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "config"))
from db import PG, WORK  # noqa: E402
from features import H, Features, apply_hybrid  # noqa: E402

CACHE = Path(WORK) / "cache" / "traffic_hourly_48h"
KEEP_RUNS = 20

DDL = """
CREATE TABLE IF NOT EXISTS gold.ml_forecast_48h_runs (
  run_id            serial PRIMARY KEY,
  issued_at         timestamptz NOT NULL DEFAULT now(),
  origin_ts         timestamp NOT NULL,            -- first forecast hour (Manila local)
  history_end       timestamp NOT NULL,            -- last recorded hour the forecast starts from
  history_synthetic boolean NOT NULL,              -- that history is the team's synthetic 2026
  model             text NOT NULL,                 -- production.json model key, or 'profile'
  model_label       text NOT NULL,
  status            text NOT NULL,                 -- ok | partial_fallback | fallback
  series_model      int NOT NULL,
  series_fallback   int NOT NULL,
  interval_level    numeric,
  info              jsonb,                         -- backtest metrics, band coverage, fallback reasons
  CONSTRAINT ml_forecast_48h_status CHECK (status IN ('ok', 'partial_fallback', 'fallback'))
);
CREATE TABLE IF NOT EXISTS gold.ml_forecast_hourly_48h (
  run_id         int NOT NULL REFERENCES gold.ml_forecast_48h_runs(run_id) ON DELETE CASCADE,
  forecast_ts    timestamp NOT NULL,
  horizon_h      smallint NOT NULL,                -- 1..48
  series_key     text NOT NULL,                    -- exit|direction|role|toll_system, or 'corridor'
  exit_canonical text,
  direction      text,
  role           text,
  toll_system    text,
  class_1        real NOT NULL, class_2 real NOT NULL, class_3 real NOT NULL, total real NOT NULL,
  lo_total       real, hi_total real,
  lo_1 real, hi_1 real, lo_2 real, hi_2 real, lo_3 real, hi_3 real,
  method         text NOT NULL,                    -- model | fallback_profile | sum
  PRIMARY KEY (run_id, series_key, forecast_ts),
  CONSTRAINT ml_forecast_48h_nonneg CHECK (class_1 >= 0 AND class_2 >= 0 AND class_3 >= 0 AND total >= 0)
);
"""


COMPARED = ["lstm1", "stacked", "dualpath", "hybrid"]          # the learned candidates of the 2025 backtest


def comparison(selected):
    """Every learned candidate's 2025 backtest (metrics.json from evaluate.py), for the dashboard's evidence table:
    overall, by hours ahead and by condition, at the plaza-hour level and on the corridor total."""
    f = CACHE / "metrics.json"
    if not f.exists():
        return []
    m = json.loads(f.read_text())["models"]
    out = []
    for k in COMPARED:
        if k not in m:
            continue
        r = m[k]
        out.append({
            "model": k, "label": r["label"], "served": k == selected,
            "wape": r["series"]["all"]["WAPE"], "corridor_wape": r["corridor"]["all"]["WAPE"],
            # the same measures the daily models' table shows, per plaza, direction and class, hour by hour
            "mase": r["series"]["all"].get("MASE"), "mae": r["series"]["all"]["MAE"], "rmse": r["series"]["all"]["RMSE"],
            "r2": r["series"]["all"].get("R2"), "mape": r["series"]["all"].get("MAPE"),
            "by_horizon": {h: r["horizon"][str(h)]["WAPE"] for h in (1, 6, 12, 24, 48) if str(h) in r["horizon"]},
            "by_condition": {c: r["series"][c]["WAPE"] for c in ("weekday", "weekend", "holiday", "heavy rain", "event day")
                             if c in r["series"]},
        })
    return out


def load_model(prod):
    """The production model, or (None, reason)."""
    kind = prod.get("model")
    if kind not in ("lstm1", "stacked", "dualpath", "hybrid"):
        return None, None, f"production model is '{kind}'"
    try:
        import keras
        m = keras.models.load_model(CACHE / prod["refit"]["model_file"], safe_mode=False)
        reg = None
        if kind == "hybrid":
            import xgboost as xgb
            reg = xgb.XGBRegressor(); reg.load_model(str(CACHE / prod["refit"]["xgb_file"]))
        return m, reg, None
    except Exception as e:                                  # noqa: BLE001 - any load failure means fall back
        return None, None, f"model failed to load: {type(e).__name__}: {e}"


def build(D, prod):
    n_hist = int(D["n_hist"]); keys = D["keys"]; S = len(keys)
    ts = pd.to_datetime(D["ts"])
    scaler = dict(np.load(CACHE / prod["refit"]["scaler_file"], allow_pickle=True)) if "refit" in prod else None
    F = Features(D, n_hist, scaler=scaler)
    o = np.full(S, n_hist); s = np.arange(S)
    prof = F.profile(o, s)                                                  # [S,H,3]
    m, reg, why = load_model(prod)
    ok = F.history_complete(o, s)
    method = np.array(["fallback_profile"] * S, dtype=object)
    pred = prof.copy()
    reasons = {}
    if m is not None and ok.any():
        X, _ = F.batch(o[ok], s[ok])
        z = m.predict(X, verbose=0)
        if reg is not None:
            z = apply_hybrid(reg, X, z)
        pred[ok] = F.to_counts(z, s[ok])
        method[ok] = "model"
    for j in np.where(method != "model")[0]:
        reasons[str(keys[j])] = why or "a day of its inputs (last 14 days or the 56-day window) is missing"
    assert pred.shape == (S, H, 3) and np.isfinite(pred).all() and (pred >= 0).all()

    band = np.load(CACHE / "intervals.npz") if (CACHE / "intervals.npz").exists() else None
    fts = ts[n_hist:n_hist + H]
    rows = []
    for j, k in enumerate(keys):
        ex, di, ro, sy = (None if v == "-" else v for v in str(k).split("|"))
        for h in range(H):
            c = pred[j, h]; tot = float(c.sum())
            r = dict(forecast_ts=fts[h].to_pydatetime(), horizon_h=h + 1, series_key=str(k), exit_canonical=ex,
                     direction=di, role=ro, toll_system=sy, class_1=float(c[0]), class_2=float(c[1]),
                     class_3=float(c[2]), total=tot, method=method[j])
            if band is not None and method[j] == "model":
                r["lo_total"] = float(np.expm1(np.log1p(tot) + band["tot_lo"][j, h]))
                r["hi_total"] = float(np.expm1(np.log1p(tot) + band["tot_hi"][j, h]))
                for ci in range(3):
                    r[f"lo_{ci + 1}"] = float(np.expm1(np.log1p(c[ci]) + band["lo"][j, h, ci]))
                    r[f"hi_{ci + 1}"] = float(np.expm1(np.log1p(c[ci]) + band["hi"][j, h, ci]))
            rows.append(r)
    corr = pred.sum(axis=0)                                                  # [H,3]
    for h in range(H):
        tot = float(corr[h].sum())
        r = dict(forecast_ts=fts[h].to_pydatetime(), horizon_h=h + 1, series_key="corridor", exit_canonical=None,
                 direction=None, role=None, toll_system=None, class_1=float(corr[h, 0]), class_2=float(corr[h, 1]),
                 class_3=float(corr[h, 2]), total=tot, method="sum")
        if band is not None and (method == "model").all():
            r["lo_total"] = float(np.expm1(np.log1p(tot) + band["corr_lo"][h]))
            r["hi_total"] = float(np.expm1(np.log1p(tot) + band["corr_hi"][h]))
        rows.append(r)
    n_model = int((method == "model").sum())
    status = "ok" if n_model == S else ("fallback" if n_model == 0 else "partial_fallback")
    run = dict(origin_ts=fts[0].to_pydatetime(), history_end=ts[n_hist - 1].to_pydatetime(),
               history_synthetic=bool(D["is_synthetic"][n_hist - 1]),
               model=prod["model"] if n_model else "profile",
               model_label=prod["label"] if n_model else "Current method (daily x hourly profile)",
               status=status, series_model=n_model, series_fallback=S - n_model,
               interval_level=float(band["level"]) if band is not None and n_model else None,
               info={"selected_at": prod.get("selected_at"), "why": prod.get("why"),
                     "backtest": prod.get("backtest"), "naive_backtest": prod.get("naive_backtest"),
                     "current_method_backtest": prod.get("current_method_backtest"),
                     "intervals": prod.get("intervals"), "refit": prod.get("refit"),
                     "test_window": prod.get("test_window"), "trained_through": prod.get("trained_through"),
                     "comparison": comparison(prod.get("model")),
                     "fallback_reasons": reasons})
    return run, rows


def write(run, rows, if_changed):
    conn = psycopg2.connect(PG)
    try:
        with conn, conn.cursor() as cur:
            cur.execute(DDL)
            if if_changed:
                cur.execute("""SELECT history_end, model, info->>'selected_at' FROM gold.ml_forecast_48h_runs
                               ORDER BY run_id DESC LIMIT 1""")
                last = cur.fetchone()
                if last and last[0] == run["history_end"] and last[1] == run["model"] and last[2] == run["info"]["selected_at"]:
                    print("unchanged: the latest run already used this history and model; nothing written")
                    return None
            cur.execute("""INSERT INTO gold.ml_forecast_48h_runs (origin_ts, history_end, history_synthetic, model,
                             model_label, status, series_model, series_fallback, interval_level, info)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING run_id""",
                        (run["origin_ts"], run["history_end"], run["history_synthetic"], run["model"], run["model_label"],
                         run["status"], run["series_model"], run["series_fallback"], run["interval_level"],
                         Json(run["info"])))
            run_id = cur.fetchone()[0]
            cols = ["forecast_ts", "horizon_h", "series_key", "exit_canonical", "direction", "role", "toll_system",
                    "class_1", "class_2", "class_3", "total", "lo_total", "hi_total", "lo_1", "hi_1", "lo_2", "hi_2",
                    "lo_3", "hi_3", "method"]
            execute_values(cur, f"INSERT INTO gold.ml_forecast_hourly_48h (run_id, {', '.join(cols)}) VALUES %s",
                           [(run_id, *[r.get(c) for c in cols]) for r in rows])
            cur.execute("""DELETE FROM gold.ml_forecast_48h_runs WHERE run_id NOT IN
                           (SELECT run_id FROM gold.ml_forecast_48h_runs ORDER BY run_id DESC LIMIT %s)""", (KEEP_RUNS,))
        return run_id
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write-db", action="store_true")
    ap.add_argument("--if-changed", action="store_true")
    args = ap.parse_args()
    D = dict(np.load(CACHE / "dataset.npz", allow_pickle=True))
    pf = CACHE / "production.json"
    prod = json.loads(pf.read_text()) if pf.exists() else {"model": "profile", "label": "Current method"}
    run, rows = build(D, prod)
    corr = [r for r in rows if r["series_key"] == "corridor"]
    print(f"origin {run['origin_ts']} (history ends {run['history_end']}, synthetic={run['history_synthetic']}); "
          f"model {run['model']} status {run['status']} ({run['series_model']} model / {run['series_fallback']} fallback)")
    print(f"corridor next 24 h: {sum(r['total'] for r in corr[:24]):,.0f} vehicles; next 48 h {sum(r['total'] for r in corr):,.0f}")
    if run["info"]["fallback_reasons"]:
        print("fallback:", json.dumps(run["info"]["fallback_reasons"], indent=1))
    if args.write_db:
        rid = write(run, rows, args.if_changed)
        if rid: print(f"written: run {rid}, {len(rows)} rows")
    else:
        print("dry run: nothing written (add --write-db)")


if __name__ == "__main__":
    main()
