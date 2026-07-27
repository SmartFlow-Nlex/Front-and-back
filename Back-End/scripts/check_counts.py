import psycopg2
import os
from dotenv import load_dotenv

load_dotenv('C:/Users/Hans/.gemini/antigravity/scratch/predictive folder/Front-and-back-FE-BE-Kia-Descriptive/Back-End/.env')
url = os.getenv('DATABASE_URL') or os.getenv('POSTGRES_URL')
conn = psycopg2.connect(url)
cur = conn.cursor()

tables = [
    ("Traffic Volume", "bronze.traffic_volume"),
    ("Road Crashes", "bronze.road_crashes"),
    ("Stalled Vehicles", "bronze.stalled_vehicles"),
    ("Motorcycle Crashes", "nlex_motorcycle_crashes")
]

for name, table in tables:
    try:
        cur.execute(f"SELECT COUNT(*) FROM {table}")
        count = cur.fetchone()[0]
        print(f"{name}: {count} rows")
    except Exception as e:
        print(f"{name}: Error - {e}")
        conn.rollback()
