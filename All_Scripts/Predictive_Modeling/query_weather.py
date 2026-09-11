from dotenv import load_dotenv
load_dotenv()  # DB credentials come from .env, never from source
import os
import psycopg2
import pandas as pd
conn_string = os.environ["PG_CONN"]
conn = psycopg2.connect(conn_string)
df = pd.read_sql("SELECT column_name FROM information_schema.columns WHERE table_schema='silver' AND table_name='hourly_weather'", conn)
print(df)
conn.close()
