import os
import psycopg2
import pandas as pd

# Credentials come from the environment, never hardcoded.
# Set PGURL (or POSTGRES_URL) before running, e.g. from Back-End/.env
url = os.environ.get("PGURL") or os.environ.get("POSTGRES_URL")
if not url:
    raise SystemExit("Set PGURL (or POSTGRES_URL) to the AWS RDS connection string.")
try:
    conn = psycopg2.connect(url)
    cur = conn.cursor()
    cur.execute("""
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
    """)
    tables = cur.fetchall()
    print('Tables in AWS DB:')
    for t in tables:
        print('-', t[0])
        
        # Check rows in incident dataset tables
        if 'incident' in t[0].lower() or 'dataset' in t[0].lower():
            cur.execute(f"SELECT COUNT(*) FROM {t[0]}")
            count = cur.fetchone()[0]
            print(f"  -> {count} rows")
            
            cur.execute(f"SELECT * FROM {t[0]} LIMIT 0")
            colnames = [desc[0] for desc in cur.description]
            print(f"  -> Columns: {colnames[:5]} ... (total {len(colnames)})")
            
except Exception as e:
    print(f"DB Error: {e}")
