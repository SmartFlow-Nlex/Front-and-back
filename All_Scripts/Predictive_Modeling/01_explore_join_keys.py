from dotenv import load_dotenv
load_dotenv()  # DB credentials come from .env, never from source
import os
import psycopg2
import pandas as pd

conn_string = os.environ["PG_CONN"]

def main():
    try:
        conn = psycopg2.connect(conn_string)
        
        print("--- Sample waze_hourly_jams ---")
        waze_sample = pd.read_sql("SELECT id, date_day, hour_of_day, nlex_exit_id, avg_speed_kmh FROM silver.waze_hourly_jams LIMIT 10", conn)
        print(waze_sample)
        
        print("\n--- Distinct nlex_exit_id counts ---")
        counts = pd.read_sql("""
            SELECT nlex_exit_id, COUNT(*) as freq 
            FROM silver.waze_hourly_jams 
            GROUP BY nlex_exit_id 
            ORDER BY freq DESC LIMIT 10
        """, conn)
        print(counts)
        nlex_plazas = pd.read_sql("""
            SELECT DISTINCT toll_plaza 
            FROM silver.traffic_volume
        """, conn)
        print(nlex_plazas)
        
    except Exception as e:
        print(f"Error: {e}")
    finally:
        if 'conn' in locals():
            conn.close()

if __name__ == "__main__":
    main()
