raise SystemExit(
    "ARCHIVED - do not run. Points at an older database instance (smartflow.cn4wwa2i4cux...) that is no longer production, and loads 2020-2021 data the project has since removed. "
    "Kept only as a record; see smartflow_scripts/README.md.")

import psycopg2
import pandas as pd
conn_string = "host='smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com' port=5432 user='postgres' password='REMOVED' dbname='nlex_capstone' sslmode='require'"
conn = psycopg2.connect(conn_string)

df = pd.read_sql("SELECT MIN(date), MAX(date) FROM silver.traffic_volume", conn)
print("Silver traffic volume dates:", df)

conn.close()
