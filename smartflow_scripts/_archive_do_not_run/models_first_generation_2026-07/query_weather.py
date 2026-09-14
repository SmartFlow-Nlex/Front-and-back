raise SystemExit(
    "ARCHIVED - do not run. First-generation models (July 2026) on the retired 2020-2026 synthetic data; superseded by 3_training_testing/. Kept only as a record; see smartflow_scripts/README.md.")

import psycopg2
import pandas as pd
conn_string = "host='smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com' port=5432 user='postgres' password='REMOVED' dbname='nlex_capstone' sslmode='require'"
conn = psycopg2.connect(conn_string)
df = pd.read_sql("SELECT column_name FROM information_schema.columns WHERE table_schema='silver' AND table_name='hourly_weather'", conn)
print(df)
conn.close()
