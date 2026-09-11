from dotenv import load_dotenv
load_dotenv()  # DB credentials come from .env, never from source
import os
import psycopg2
import pandas as pd
conn_string = os.environ["PG_CONN"]
conn = psycopg2.connect(conn_string)

df = pd.read_sql("SELECT MIN(date), MAX(date) FROM silver.traffic_volume", conn)
print("Silver traffic volume dates:", df)

conn.close()
