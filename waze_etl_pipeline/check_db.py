import psycopg2
import os

DB_HOST = "smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com"
DB_NAME = "nlex_capstone"
DB_USER = "postgres"
DB_PASSWORD = "Hanszy123"
DB_PORT = "5432"

try:
    conn = psycopg2.connect(
        host=DB_HOST,
        port=DB_PORT,
        database=DB_NAME,
        user=DB_USER,
        password=DB_PASSWORD
    )
    cur = conn.cursor()
    cur.execute("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema='public';")
    print(cur.fetchall())
    cur.close()
    conn.close()
except Exception as e:
    print(f"Error: {e}")
