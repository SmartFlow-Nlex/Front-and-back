import psycopg2
import os
from dotenv import load_dotenv

load_dotenv('C:/Users/Hans/.gemini/antigravity/scratch/predictive folder/Front-and-back-FE-BE-Kia-Descriptive/Back-End/.env')
url = os.getenv('DATABASE_URL') or os.getenv('POSTGRES_URL')
conn = psycopg2.connect(url)
cur = conn.cursor()

try:
    # Get base table for nlex_motorcycle_crashes
    cur.execute("SELECT view_definition FROM information_schema.views WHERE table_name='nlex_motorcycle_crashes'")
    motorcycle_view = cur.fetchone()
    
    # Truncate all tables
    queries = [
        "TRUNCATE TABLE bronze.traffic_volume CASCADE;",
        "TRUNCATE TABLE bronze.road_crashes CASCADE;",
        "TRUNCATE TABLE bronze.stalled_vehicles CASCADE;",
        "TRUNCATE TABLE data_uploads CASCADE;"
    ]
    
    for q in queries:
        try:
            cur.execute(q)
            print(f"Executed: {q}")
        except Exception as e:
            print(f"Failed to execute {q}: {e}")
            conn.rollback()

    conn.commit()
    print("All tables successfully truncated!")
except Exception as e:
    print(f"Error: {e}")
