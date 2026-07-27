import psycopg2
import os
from dotenv import load_dotenv

load_dotenv('C:/Users/Hans/.gemini/antigravity/scratch/predictive folder/Front-and-back-FE-BE-Kia-Descriptive/Back-End/.env')
url = os.getenv('DATABASE_URL') or os.getenv('POSTGRES_URL')
conn = psycopg2.connect(url)
conn.autocommit = True
cur = conn.cursor()

tables_to_truncate = [
    'public.traffic_volumes',
    'public.directional_flow',
    'public.vehicle_classes',
    'public.incidents_table'
]

for table in tables_to_truncate:
    print(f"Truncating {table}...")
    try:
        cur.execute(f"TRUNCATE TABLE {table} CASCADE;")
    except Exception as e:
        print(f"Error on {table}: {e}")

print("Truncation complete!")
