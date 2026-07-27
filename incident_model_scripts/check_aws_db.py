import psycopg2
import pandas as pd

url = 'postgresql://postgres:Hanszy123@smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone'
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
