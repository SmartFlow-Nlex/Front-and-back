import pandas as pd
import psycopg2
from statsmodels.tsa.holtwinters import ExponentialSmoothing

POSTGRES_URL = "postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone"
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
