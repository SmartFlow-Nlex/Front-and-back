import psycopg2
import os

DB_HOST = "smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com"
DB_NAME = "nlex_capstone"
DB_USER = "postgres"
DB_PASSWORD = "Hanszy123"
DB_PORT = "5432"

def init_db():
    try:
        print(f"Connecting to {DB_HOST}...")
        conn = psycopg2.connect(
            host=DB_HOST,
            port=DB_PORT,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )
        conn.autocommit = True
        cur = conn.cursor()
        
        with open('schema.sql', 'r') as f:
            sql = f.read()
            
        statements = [s.strip() for s in sql.split(';') if s.strip()]
        for idx, stmt in enumerate(statements):
            try:
                cur.execute(stmt)
                print(f"Success: Statement {idx}")
            except Exception as e:
                print(f"Failed at statement {idx}: {e}")
                
        cur.close()
        conn.close()
    except Exception as e:
        print(f"Database error: {e}")

if __name__ == "__main__":
    init_db()
