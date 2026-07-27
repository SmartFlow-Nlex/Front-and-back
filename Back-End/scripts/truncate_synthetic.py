import psycopg2
import os
from dotenv import load_dotenv

load_dotenv('C:/Users/Hans/.gemini/antigravity/scratch/predictive folder/Front-and-back-FE-BE-Kia-Descriptive/Back-End/.env')
url = os.getenv('DATABASE_URL') or os.getenv('POSTGRES_URL')
conn = psycopg2.connect(url)
conn.autocommit = True
cur = conn.cursor()

tables_to_truncate = [
    'public.nlex_traffic_volume',
    'public.nlex_road_crashes',
    'public.nlex_motorcycle_crashes',
    'public.nlex_stalled_vehicles',
    'public.nlex_apprehensions'
]

for table in tables_to_truncate:
    print(f"Truncating {table}...")
    cur.execute(f"TRUNCATE TABLE {table} CASCADE;")

print("Truncation complete!")
