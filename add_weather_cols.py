import psycopg2

POSTGRES_URL = "postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone"
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
