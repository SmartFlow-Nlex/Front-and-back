import os as _os
if _os.environ.get("ALLOW_MIGRATION") != "1":
    raise SystemExit("One-off migration, already applied to the database. Re-running it can duplicate or undo changes. Set ALLOW_MIGRATION=1 to run it deliberately.")

import psycopg2

# Connection settings live in smartflow_scripts/config/.env, read by config/db.py.
# They used to be hardcoded in this file and in ~80 others.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[2] / "config"))
from db import PG, POSTGRES_URL, WORK, setting  # noqa: E402,F401
conn = psycopg2.connect(POSTGRES_URL)
cur = conn.cursor()

try:
    cur.execute("ALTER TABLE gold.ml_predictive_volume ADD COLUMN IF NOT EXISTS weather_rainfall NUMERIC;")
    cur.execute("ALTER TABLE gold.ml_predictive_volume ADD COLUMN IF NOT EXISTS weather_temp NUMERIC;")
    conn.commit()
    print("Columns added successfully.")
except Exception as e:
    print("Error:", e)
    conn.rollback()

cur.execute("""
    SELECT timestamp_utc::date AS ds, SUM(rainfall) AS total_rain 
    FROM public.hourly_weather 
    WHERE timestamp_utc::date >= '2026-07-20' 
    GROUP BY timestamp_utc::date 
    ORDER BY ds
""")
print("Rainfall in late July:")
for row in cur.fetchall():
    print(row)
