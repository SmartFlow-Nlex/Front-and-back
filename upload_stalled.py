import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime

# DB Connection
POSTGRES_URL = "postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone"
CSV_PATH = r"C:\Users\Hans\.gemini\antigravity\scratch\synthetic_data_varying\stalled_vehicles_reports_2020_2026_synthetic.csv"

def parse_time(date_str, time_str):
    if pd.isna(time_str) or not time_str: return None
    try:
        # Date: 01-Jan-20
        # Time: 09:06 AM
        dt_str = f"{date_str} {time_str}"
        dt = datetime.strptime(dt_str, "%d-%b-%y %I:%M %p")
        return dt
    except:
        return None

def main():
    print("Loading CSV...")
    df = pd.read_csv(CSV_PATH)
    
    # Map to DB columns
    # DB: date (text), reported_time (timestamp), responded_time (timestamp), location (text), vehicle_cause (text)
    print("Formatting data...")
    records = []
    for _, row in df.iterrows():
        d = str(row['Date'])
        rep = parse_time(d, row['Reported Time'])
        res = parse_time(d, row['Responded Time'])
        loc = str(row['Location']) if pd.notna(row['Location']) else ""
        cause = str(row['Vehicle Cause']) if pd.notna(row['Vehicle Cause']) else ""
        
        # Format date as YYYY-MM-DD string for consistency, or just keep original
        try:
            date_formatted = datetime.strptime(d, "%d-%b-%y").strftime("%Y-%m-%d")
        except:
            date_formatted = d

        records.append((date_formatted, rep, res, loc, cause))

    print(f"Uploading {len(records)} records to AWS...")
    conn = psycopg2.connect(POSTGRES_URL)
    cur = conn.cursor()
    
    cur.execute("TRUNCATE TABLE public.nlex_stalled_vehicles;")
    
    query = """
        INSERT INTO public.nlex_stalled_vehicles (date, reported_time, responded_time, location, vehicle_cause)
        VALUES %s
    """
    execute_values(cur, query, records, page_size=1000)
    
    conn.commit()
    cur.close()
    conn.close()
    print("Successfully uploaded all stalled vehicles data!")

if __name__ == "__main__":
    main()
