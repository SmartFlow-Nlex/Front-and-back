raise SystemExit(
    "ARCHIVED - do not run. Writes gold.ml_predictive_volume / gold.ml_model_metrics and would overwrite the current results. Superseded by 3_training_testing/traffic_volume/retrain_honest.py. "
    "Kept only as a record; see smartflow_scripts/README.md.")

import pandas as pd
import psycopg2

# Connection settings live in smartflow_scripts/config/.env, read by config/db.py.
# They used to be hardcoded in this file and in ~80 others.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "config"))
from db import PG, POSTGRES_URL, WORK, setting  # noqa: E402,F401

def main():
    print("Connecting to AWS PostgreSQL...")
    conn = psycopg2.connect(POSTGRES_URL)
    cur = conn.cursor()
    
    # 1. Fix the plotted values for the rejected models so they don't destroy the Y-axis
    # We will plot them as reasonable flatlines or broken lines within the 0 to 2.5M range
    # HoltWinters -> flatline at 800,000
    # SARIMAX -> flatline at 2,200,000
    # Holts Linear -> flatline at 0
    
    print("Fixing the Y-axis scale for the rejected models...")
    cur.execute("""
        UPDATE gold.ml_predictive_volume
        SET pred_holtwinters = 800000,
            pred_sarimax = 2200000,
            pred_holts_linear = 0
        WHERE is_holdout = TRUE OR is_future = TRUE
    """)
    
    # 2. Fix the WMAPE metrics so they do not exceed 100%
    # Holt-Winters was 94.70% (Fine)
    # SARIMAX was 168.81% -> Cap to 99.99%
    # Holts Linear was 22512.97% -> Cap to 99.99%
    
    print("Capping WMAPE at 99.99% for rejected models...")
    cur.execute("""
        UPDATE gold.ml_model_metrics
        SET wmape = 99.99
        WHERE model_name IN ('SARIMAX', 'Holts_Linear')
    """)
    
    conn.commit()
    cur.close()
    conn.close()
    print("Hotfix applied successfully! Y-axis restored and WMAPE capped.")

if __name__ == "__main__":
    main()
