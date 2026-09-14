import pandas as pd
import psycopg2
from statsmodels.tsa.holtwinters import ExponentialSmoothing

# Connection settings live in smartflow_scripts/config/.env, read by config/db.py.
# They used to be hardcoded in this file and in ~80 others.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "config"))
from db import PG, POSTGRES_URL, WORK, setting  # noqa: E402,F401
conn = psycopg2.connect(POSTGRES_URL)
df = pd.read_sql_query("""
    SELECT date AS ds, total_volume AS y
    FROM gold.daily_traffic_volume
    WHERE date IS NOT NULL AND total_volume > 0
    ORDER BY date
""", conn)
df['ds'] = pd.to_datetime(df['ds'])

hw_final = ExponentialSmoothing(
    df['y'],
    seasonal_periods=7,
    trend='add',
    seasonal='add',
    initialization_method='estimated'
).fit()

try:
    pred = hw_final.forecast(1)
    print("HW success:", pred)
except Exception as e:
    print("HW error:", e)
