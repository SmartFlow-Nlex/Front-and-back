raise SystemExit(
    "ARCHIVED - do not run. Belongs to the pre-2026-08-12 run: its folder convention (01_dataset/, 02_final_evaluation_walkforward/, 04_aws_live_predictions/) was archived to REPORTS_DIR/_archive_pre_2026-08-12_honest_retrain. "
    "Kept only as a record; see smartflow_scripts/README.md.")
import psycopg2
import pandas as pd

# Connection settings live in smartflow_scripts/config/.env, read by config/db.py.
# They used to be hardcoded in this file and in ~80 others.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "config"))
from db import PG, POSTGRES_URL, WORK, setting  # noqa: E402,F401
import os
OUTPUT_FILE = os.path.join(setting("REPORTS_DIR", required=True), "01_dataset", "true_traffic_dataset.csv")

def extract_dataset():
    print("Connecting to AWS Database...")
    conn = psycopg2.connect(POSTGRES_URL)
    
    query = """
    SELECT 
        date_day,
        hour_of_day,
        MAX(day_of_week) as day_of_week,
        MAX(is_weekend::int) as is_weekend,
        MAX(month_name) as month_name,
        MAX(quarter) as quarter,
        MAX(is_rush_hour::int) as is_rush_hour,
        MAX(is_holiday::int) as is_holiday,
        MAX(is_holiday_window::int) as is_holiday_window,
        SUM(volume_class1) as volume_class1,
        SUM(volume_class2) as volume_class2,
        SUM(volume_class3) as volume_class3,
        SUM(total_volume) as "Total",
        SUM(total_volume) as total_volume,
        AVG(avg_speed_kmh) as avg_speed_kmh,
        AVG(avg_jam_level) as avg_jam_level,
        MAX(max_delay_seconds) as max_delay_seconds,
        AVG(temperature) as temperature,
        AVG(rainfall) as rainfall,
        AVG(wind_speed) as wind_speed,
        AVG(humidity) as humidity
    FROM bronze.nlex_traffic_volume
    GROUP BY date_day, hour_of_day
    ORDER BY date_day ASC, hour_of_day ASC
    """
    
    print("Querying the true hourly dataset (this might take a moment)...")
    df = pd.read_sql_query(query, conn)
    
    # Fill NAs
    df.fillna(0, inplace=True)
    
    print(f"Exporting dataset to {OUTPUT_FILE}...")
    df.to_csv(OUTPUT_FILE, index=False)
    
    print("Done! Dataset is ready for ML retraining.")
    
    conn.close()

if __name__ == "__main__":
    extract_dataset()
