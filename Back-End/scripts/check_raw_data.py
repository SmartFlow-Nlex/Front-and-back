import psycopg2
import os
from dotenv import load_dotenv

load_dotenv('C:/Users/Hans/.gemini/antigravity/scratch/predictive folder/Front-and-back-FE-BE-Kia-Descriptive/Back-End/.env')
url = os.getenv('DATABASE_URL') or os.getenv('POSTGRES_URL')
conn = psycopg2.connect(url)
cur = conn.cursor()

cur.execute("SELECT h00, h12 FROM bronze.traffic_volume LIMIT 5")
print(cur.fetchall())
