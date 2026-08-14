import psycopg2
import pandas as pd

POSTGRES_URL = "postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone"
OUTPUT_FILE = r"C:\Users\Hans\.gemini\antigravity\scratch\predictive folder\training_and_testing_outputs\01_dataset\true_traffic_dataset.csv"

def extract_dataset():
    print("Connecting to AWS Database...")
    conn = psycopg2.connect(POSTGRES_URL)
    
    query = """
    SELECT 
        date_day,
        hour_of_day,
        MAX(day_of_week) as day_of_week,
        MAX(is_weekend::int) as is_weekend,
        MAX(month_name) as month_name,
        MAX(quarter) as quarter,
        MAX(is_rush_hour::int) as is_rush_hour,
        MAX(is_holiday::int) as is_holiday,
        MAX(is_holiday_window::int) as is_holiday_window,
        SUM(volume_class1) as volume_class1,
        SUM(volume_class2) as volume_class2,
        SUM(volume_class3) as volume_class3,
        SUM(total_volume) as "Total",
        SUM(total_volume) as total_volume,
        AVG(avg_speed_kmh) as avg_speed_kmh,
        AVG(avg_jam_level) as avg_jam_level,
        MAX(max_delay_seconds) as max_delay_seconds,
        AVG(temperature) as temperature,
        AVG(rainfall) as rainfall,
        AVG(wind_speed) as wind_speed,
        AVG(humidity) as humidity
    FROM bronze.nlex_traffic_volume
    GROUP BY date_day, hour_of_day
    ORDER BY date_day ASC, hour_of_day ASC
    """
    
    print("Querying the true hourly dataset (this might take a moment)...")
    df = pd.read_sql_query(query, conn)
    
    # Fill NAs
    df.fillna(0, inplace=True)
    
    print(f"Exporting dataset to {OUTPUT_FILE}...")
    df.to_csv(OUTPUT_FILE, index=False)
    
    print("Done! Dataset is ready for ML retraining.")
    
    conn.close()

if __name__ == "__main__":
    extract_dataset()
