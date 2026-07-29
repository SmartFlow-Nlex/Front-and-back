"""
STAGE 17 - PUBLISH THE INCIDENT ANALYTICS TO AWS RDS
====================================================
Stages 11-16 leave the evaluation on local disk only; the dashboard tables carry
just the champion's plotted series. This uploads the analytics themselves so the
results are queryable in the database rather than living in files:

    ml_model_evaluation      one row per model per run - all 11 KPIs, the split-R2
                             diagnostic, rank, champion flag, diagnosis
    ml_model_fold_metrics    per-fold walk-forward detail behind those averages
    ml_gwr_risk_segments     the GWR spatial risk surface (21 x 2km segments)
    ml_evaluation_report     the full INCIDENT_MODEL_REPORT.txt text

APPEND-ONLY. Every run is stamped with a run_id, so history accumulates and model
performance can be tracked across retrains - which is what makes a feedback loop
possible rather than a one-shot selection. Nothing is deleted; the three dashboard
tables (ml_daily_actuals / ml_predictive_incidents / ml_training_metadata) are not
touched by this script at all.

Run:  set PGURL=...  &&  python 17_publish_analytics_to_aws.py
"""
import os
import json
from datetime import datetime, timezone

import psycopg2
from psycopg2.extras import execute_values

PGURL = os.environ["PGURL"]
HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "outputs", "models")

GAP_THRESHOLD = 0.10
MASE_BASELINE = 1.0

PANEL_A = ["Poisson_GLM", "Negative_Binomial", "Random_Forest", "XGBoost",
           "SARIMAX", "LSTM", "GRU"]
PANEL_B = ["GWR", "Spatial_LSTM"]

DDL = """
CREATE TABLE IF NOT EXISTS ml_model_evaluation (
    id                SERIAL PRIMARY KEY,
    run_id            TEXT        NOT NULL,
    evaluated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    panel             TEXT        NOT NULL,
    model             TEXT        NOT NULL,
    target            TEXT        NOT NULL,
    validation        TEXT,
    rank              INTEGER,
    is_champion       BOOLEAN     NOT NULL DEFAULT FALSE,
    rejected          BOOLEAN     NOT NULL DEFAULT FALSE,
    diagnosis         TEXT,
    mae               DOUBLE PRECISION,
    mse               DOUBLE PRECISION,
    rmse              DOUBLE PRECISION,
    mape              DOUBLE PRECISION,
    smape             DOUBLE PRECISION,
    wmape             DOUBLE PRECISION,
    poisson_deviance  DOUBLE PRECISION,
    mase              DOUBLE PRECISION,
    rmsse             DOUBLE PRECISION,
    r2                DOUBLE PRECISION,
    adjusted_r2       DOUBLE PRECISION,
    train_r2          DOUBLE PRECISION,
    val_r2            DOUBLE PRECISION,
    gap               DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS ix_ml_model_eval_run   ON ml_model_evaluation (run_id);
CREATE INDEX IF NOT EXISTS ix_ml_model_eval_model ON ml_model_evaluation (model);

CREATE TABLE IF NOT EXISTS ml_model_fold_metrics (
    id                SERIAL PRIMARY KEY,
    run_id            TEXT        NOT NULL,
    model             TEXT        NOT NULL,
    fold              INTEGER     NOT NULL,
    mae               DOUBLE PRECISION,
    rmse              DOUBLE PRECISION,
    poisson_deviance  DOUBLE PRECISION,
    mase              DOUBLE PRECISION,
    r2                DOUBLE PRECISION,
    train_r2          DOUBLE PRECISION,
    val_r2            DOUBLE PRECISION,
    gap               DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS ix_ml_fold_run ON ml_model_fold_metrics (run_id);

CREATE TABLE IF NOT EXISTS ml_gwr_risk_segments (
    id                 SERIAL PRIMARY KEY,
    run_id             TEXT        NOT NULL,
    computed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rank               INTEGER,
    segment            TEXT,
    fitted_daily_rate  DOUBLE PRECISION,
    intercept          DOUBLE PRECISION,
    beta_km            DOUBLE PRECISION,
    local_r2           DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS ix_ml_gwr_run ON ml_gwr_risk_segments (run_id);

CREATE TABLE IF NOT EXISTS ml_evaluation_report (
    id            SERIAL PRIMARY KEY,
    run_id        TEXT        NOT NULL,
    generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    report_text   TEXT
);
"""


def num(v):
    """Metrics carry 'N/A' strings for undefined values; store those as NULL."""
    return float(v) if isinstance(v, (int, float)) else None


def diagnose(gap, mase):
    if not isinstance(gap, (int, float)) or not isinstance(mase, (int, float)):
        return None
    if gap > GAP_THRESHOLD:
        return "OVERFITTING"
    return "UNDERFITTING" if mase >= MASE_BASELINE else "JUST RIGHT"


def rank_key(v):
    m = v["metrics"]
    return (m["MASE"] >= 1.0, m["Poisson_Deviance"])


def main():
    path = f"{MODELS}/all_incident_models.json"
    if not os.path.exists(path):
        raise SystemExit(f"{path} not found - run 13 then 14 first.")
    with open(path) as fh:
        res = json.load(fh)

    run_id = datetime.now(timezone.utc).strftime("run_%Y%m%dT%H%M%SZ")
    print(f"run_id = {run_id}")

    conn = psycopg2.connect(PGURL)
    cur = conn.cursor()
    cur.execute(DDL)
    print("  schema ensured (CREATE TABLE IF NOT EXISTS)")

    # ---------------- ml_model_evaluation + fold detail ----------------
    eval_rows, fold_rows = [], []
    for panel_name, keys in [("A - global hourly", PANEL_A), ("B - spatial", PANEL_B)]:
        present = [k for k in keys if k in res]
        ranked = sorted((res[k] for k in present), key=rank_key)
        for i, v in enumerate(ranked, 1):
            m, s = v["metrics"], v["split_r2_diagnostic"]
            rejected = isinstance(m.get("MASE"), (int, float)) and m["MASE"] >= 1.0
            eval_rows.append((
                run_id, panel_name, v["model"], v["target"], v.get("validation"),
                i, (i == 1 and not rejected), rejected,
                diagnose(s.get("Gap"), m.get("MASE")),
                num(m.get("MAE")), num(m.get("MSE")), num(m.get("RMSE")),
                num(m.get("MAPE")), num(m.get("sMAPE")), num(m.get("WMAPE")),
                num(m.get("Poisson_Deviance")), num(m.get("MASE")), num(m.get("RMSSE")),
                num(m.get("R2")), num(m.get("Adjusted_R2")),
                num(s.get("Train_R2")), num(s.get("Val_R2")), num(s.get("Gap")),
            ))
            for f in v.get("per_fold", []):
                fold_rows.append((
                    run_id, v["model"], int(f.get("fold", 0)),
                    num(f.get("MAE")), num(f.get("RMSE")),
                    num(f.get("Poisson_Deviance")), num(f.get("MASE")),
                    num(f.get("R2")), num(f.get("Train_R2")),
                    num(f.get("Val_R2")), num(f.get("Gap")),
                ))

    execute_values(cur, """
        INSERT INTO ml_model_evaluation
        (run_id, panel, model, target, validation, rank, is_champion, rejected,
         diagnosis, mae, mse, rmse, mape, smape, wmape, poisson_deviance, mase,
         rmsse, r2, adjusted_r2, train_r2, val_r2, gap) VALUES %s""", eval_rows)
    print(f"  ml_model_evaluation    +{len(eval_rows)} rows")

    if fold_rows:
        execute_values(cur, """
            INSERT INTO ml_model_fold_metrics
            (run_id, model, fold, mae, rmse, poisson_deviance, mase, r2,
             train_r2, val_r2, gap) VALUES %s""", fold_rows)
        print(f"  ml_model_fold_metrics  +{len(fold_rows)} rows")

    # ---------------- GWR risk surface ----------------
    gwr = res.get("GWR", {}).get("gwr_surface_last_fold")
    if gwr:
        seg = sorted(gwr["per_segment"].items(),
                     key=lambda kv: -kv[1]["fitted_daily_rate"])
        rows = [(run_id, i, name, v["fitted_daily_rate"], v["intercept"],
                 v.get("beta_seg_km"), v["local_R2"])
                for i, (name, v) in enumerate(seg, 1)]
        execute_values(cur, """
            INSERT INTO ml_gwr_risk_segments
            (run_id, rank, segment, fitted_daily_rate, intercept, beta_km, local_r2)
            VALUES %s""", rows)
        print(f"  ml_gwr_risk_segments   +{len(rows)} rows")

    # ---------------- report text ----------------
    rpt = f"{MODELS}/INCIDENT_MODEL_REPORT.txt"
    if os.path.exists(rpt):
        with open(rpt, encoding="utf-8") as fh:
            cur.execute("INSERT INTO ml_evaluation_report (run_id, report_text) "
                        "VALUES (%s, %s)", (run_id, fh.read()))
        print("  ml_evaluation_report   +1 row")

    conn.commit()

    # ---------------- verify ----------------
    print("\nVerifying:")
    cur.execute("""SELECT panel, model, rank, is_champion, poisson_deviance, mase,
                          diagnosis
                   FROM ml_model_evaluation WHERE run_id = %s
                   ORDER BY panel, rank""", (run_id,))
    for r in cur.fetchall():
        star = " *CHAMPION*" if r[3] else ""
        print(f"  [{r[0]:<17s}] #{r[2]} {r[1]:<24s} PoisDev={r[4]:<9} "
              f"MASE={r[5]:<8} {r[6]}{star}")

    for t in ["ml_model_evaluation", "ml_model_fold_metrics",
              "ml_gwr_risk_segments", "ml_evaluation_report"]:
        cur.execute(f"SELECT COUNT(*), COUNT(DISTINCT run_id) FROM {t}")
        n, runs = cur.fetchone()
        print(f"  {t:24s} {n:>5} rows across {runs} run(s)")

    conn.close()
    print(f"\nDone. run_id = {run_id}")


if __name__ == "__main__":
    main()
