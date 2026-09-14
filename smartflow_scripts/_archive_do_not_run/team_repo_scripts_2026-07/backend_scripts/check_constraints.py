raise SystemExit(
    "ARCHIVED - do not run. Team repo scripts from July 2026 (Kia's descriptive branch); superseded by the current trainers. Kept only as a record; see smartflow_scripts/README.md.")

import psycopg2
import os
from dotenv import load_dotenv

load_dotenv('C:/Users/Hans/.gemini/antigravity/scratch/predictive folder/Front-and-back-FE-BE-Kia-Descriptive/Back-End/.env')
url = os.getenv('DATABASE_URL') or os.getenv('POSTGRES_URL')
conn = psycopg2.connect(url)
cur = conn.cursor()

cur.execute("""
SELECT tc.constraint_name, tc.constraint_type
FROM information_schema.table_constraints tc
WHERE tc.table_schema = 'bronze' AND tc.table_name = 'traffic_volume'
""")
print("bronze.traffic_volume constraints:", cur.fetchall())
