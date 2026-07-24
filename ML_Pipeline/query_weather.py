import psycopg2
import pandas as pd
conn_string = "host='smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com' port=5432 user='postgres' password='Hanszy123' dbname='nlex_capstone' sslmode='require'"
conn = psycopg2.connect(conn_string)
df = pd.read_sql("SELECT column_name FROM information_schema.columns WHERE table_schema='silver' AND table_name='hourly_weather'", conn)
print(df)
conn.close()
