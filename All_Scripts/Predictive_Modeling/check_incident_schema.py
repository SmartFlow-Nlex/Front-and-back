from dotenv import load_dotenv
load_dotenv()  # DB credentials come from .env, never from source
import os
import psycopg2

conn_string = os.environ["PG_CONN"]

conn = psycopg2.connect(conn_string)
cur = conn.cursor()

tables = ['bronze.road_crashes', 'bronze.motorcycle_crashes', 'bronze.stalled_vehicles']

for table in tables:
    print(f"\n=== {table} ===")
    cur.execute(f"SELECT column_name, data_type FROM information_schema.columns WHERE table_schema || '.' || table_name = '{table}' ORDER BY ordinal_position")
    for row in cur.fetchall():
        print(f"  {row[0]:40s} {row[1]}")
    
    cur.execute(f"SELECT COUNT(*) FROM {table}")
    print(f"  ROWS: {cur.fetchone()[0]}")

# Also check silver.road_incidents
print("\n=== silver.road_incidents ===")
try:
    cur.execute("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'silver' AND table_name = 'road_incidents' ORDER BY ordinal_position")
    cols = cur.fetchall()
    if cols:
        for row in cols:
            print(f"  {row[0]:40s} {row[1]}")
    else:
        # It might be a view
        cur.execute("SELECT * FROM silver.road_incidents LIMIT 1")
        col_names = [desc[0] for desc in cur.description]
        print(f"  Columns: {col_names}")
    cur.execute("SELECT COUNT(*) FROM silver.road_incidents")
    print(f"  ROWS: {cur.fetchone()[0]}")
except Exception as e:
    print(f"  Error: {e}")
    conn.rollback()

conn.close()
