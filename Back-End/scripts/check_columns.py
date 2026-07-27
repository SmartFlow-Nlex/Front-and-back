import psycopg2
import os
from dotenv import load_dotenv

load_dotenv('C:/Users/Hans/.gemini/antigravity/scratch/predictive folder/Front-and-back-FE-BE-Kia-Descriptive/Back-End/.env')
url = os.getenv('DATABASE_URL') or os.getenv('POSTGRES_URL')
conn = psycopg2.connect(url)
cur = conn.cursor()

cur.execute("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND (column_name LIKE '%co2%' OR column_name LIKE '%emission%' OR column_name LIKE '%penalty%')")
for r in cur.fetchall():
    print(f"{r[0]}.{r[1]}")

cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name='incidents_table'")
print("incidents_table columns:", [r[0] for r in cur.fetchall()])
