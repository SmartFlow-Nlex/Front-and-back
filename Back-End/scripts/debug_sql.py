import psycopg2
import os
import pandas as pd
from dotenv import load_dotenv

load_dotenv('C:/Users/Hans/.gemini/antigravity/scratch/predictive folder/Front-and-back-FE-BE-Kia-Descriptive/Back-End/.env')
url = os.getenv('DATABASE_URL') or os.getenv('POSTGRES_URL')
conn = psycopg2.connect(url)

query = """
SELECT date AS date_day, 
       SUM(
           COALESCE(h00, 0) + COALESCE(h01, 0) + COALESCE(h02, 0) + COALESCE(h03, 0) + 
           COALESCE(h04, 0) + COALESCE(h05, 0) + COALESCE(h06, 0) + COALESCE(h07, 0) + 
           COALESCE(h08, 0) + COALESCE(h09, 0) + COALESCE(h10, 0) + COALESCE(h11, 0) + 
           COALESCE(h12, 0) + COALESCE(h13, 0) + COALESCE(h14, 0) + COALESCE(h15, 0) + 
           COALESCE(h16, 0) + COALESCE(h17, 0) + COALESCE(h18, 0) + COALESCE(h19, 0) + 
           COALESCE(h20, 0) + COALESCE(h21, 0) + COALESCE(h22, 0) + COALESCE(h23, 0)
       ) as total_volume
FROM bronze.traffic_volume
GROUP BY date
ORDER BY date
LIMIT 5
"""
df = pd.read_sql_query(query, conn)
print("Query result shape:", df.shape)
print(df.head())
