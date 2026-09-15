raise SystemExit(
    "ARCHIVED - do not run. Medallion rebuild and metrics-table setup from a Gemini session (Jul 27 - Aug 1 2026); already applied. Kept only as a record; see smartflow_scripts/README.md.")

import psycopg2
import pandas as pd
import warnings
warnings.filterwarnings('ignore')

conn_string = "host='smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com' port=5432 user='postgres' password='REMOVED' dbname='nlex_capstone' sslmode='require'"
conn = psycopg2.connect(conn_string)

year_query = """
SELECT EXTRACT(YEAR FROM date::date) AS year, COUNT(*) AS count
FROM bronze.motorcycle_crashes
GROUP BY year
ORDER BY year;
"""
df = pd.read_sql(year_query, conn)
print("=== ROWS PER YEAR ===")
print(df.to_string(index=False))
conn.close()
