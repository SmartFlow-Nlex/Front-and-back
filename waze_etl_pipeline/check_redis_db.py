import psycopg2
import requests

# RDS and Upstash configuration
DB_HOST = "smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com"
DB_NAME = "nlex_capstone"
DB_USER = "postgres"
DB_PASSWORD = "Hanszy123"
DB_PORT = "5432"

REDIS_REST_URL = "https://united-mayfly-138714.upstash.io"
REDIS_REST_TOKEN = "gQAAAAAAAh3aAAIgcDFhYjk2NjA4N2FiNDQ0YjlmYjVkOGZlOTliNGRkZDMyYw"

def check_status():
    try:
        conn = psycopg2.connect(
            host=DB_HOST,
            port=DB_PORT,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )
        cur = conn.cursor()
        
        # Count locations
        cur.execute("SELECT count(*) FROM dim_location;")
        loc_count = cur.fetchone()[0]
        print(f"Total locations in dim_location: {loc_count}")
        
        # Sample locations
        cur.execute("SELECT segment_name, ST_AsText(geom) FROM dim_location LIMIT 3;")
        print("\nSample locations in dim_location:")
        for row in cur.fetchall():
            print(f"- {row[0]}: {row[1]}")
            
        # Count active incidents/jams
        cur.execute("SELECT count(*) FROM fact_incident_log WHERE is_active = TRUE;")
        active_incidents = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM fact_waze_jams WHERE is_active = TRUE;")
        active_jams = cur.fetchone()[0]
        print(f"\nActive Incidents in DB: {active_incidents}")
        print(f"Active Jams in DB: {active_jams}")
        
        cur.close()
        conn.close()
        
        # Fetch Redis values
        print("\n--- UPSTASH REDIS VALUES ---")
        headers = {"Authorization": f"Bearer {REDIS_REST_TOKEN}"}
        url = REDIS_REST_URL.rstrip('/')
        
        r1 = requests.post(url, json=["GET", "waze:active_alerts"], headers=headers)
        alerts = r1.json().get("result")
        print(f"waze:active_alerts: {alerts}")
        
        r2 = requests.post(url, json=["GET", "waze:active_jams"], headers=headers)
        jams = r2.json().get("result")
        print(f"waze:active_jams: {jams}")
        
    except Exception as e:
        print(f"Error checking status: {e}")

if __name__ == "__main__":
    check_status()
