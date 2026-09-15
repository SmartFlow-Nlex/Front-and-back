from dotenv import load_dotenv
load_dotenv()  # DB credentials come from .env, never from source
import os
import psycopg2
import pandas as pd
import numpy as np

conn_string = os.environ["PG_CONN"]

def main():
    print("Connecting to database...")
    conn = psycopg2.connect(conn_string)
    
    print("1. Extracting Global Waze Jams (Speed)...")
    waze_query = """
    SELECT date_day, hour_of_day, 
           AVG(avg_speed_kmh) as avg_speed_kmh,
           AVG(avg_jam_level) as avg_jam_level,
           MAX(max_delay_seconds) as max_delay_seconds
    FROM silver.waze_hourly_jams
    GROUP BY date_day, hour_of_day
    """
    waze_df = pd.read_sql(waze_query, conn)
    waze_df['date_day'] = pd.to_datetime(waze_df['date_day'])
    print(f"Loaded {len(waze_df)} Waze hours.")

    print("2. Extracting Global NLEX Traffic Volume...")
    vol_query = """
    SELECT date, hour_of_day, vehicle_class, SUM(volume) as volume
    FROM silver.traffic_volume
    GROUP BY date, hour_of_day, vehicle_class
    """
    vol_df = pd.read_sql(vol_query, conn)
    vol_df['date'] = pd.to_datetime(vol_df['date'])
    
    # Pivot vehicle classes to columns
    vol_pivot = vol_df.pivot_table(index=['date', 'hour_of_day'], 
                                   columns='vehicle_class', 
                                   values='volume', fill_value=0).reset_index()
    vol_pivot.rename(columns={'Class 1': 'volume_class1', 'Class 2': 'volume_class2', 'Class 3': 'volume_class3'}, inplace=True)
    if 'volume_class1' not in vol_pivot.columns: vol_pivot['volume_class1'] = 0
    if 'volume_class2' not in vol_pivot.columns: vol_pivot['volume_class2'] = 0
    if 'volume_class3' not in vol_pivot.columns: vol_pivot['volume_class3'] = 0
    
    vol_pivot['total_volume'] = vol_pivot['volume_class1'] + vol_pivot['volume_class2'] + vol_pivot['volume_class3']
    print(f"Loaded {len(vol_pivot)} Volume hours.")

    print("3. Extracting Weather...")
    weather_query = """
    SELECT DATE(timestamp_utc AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila') as date_day, 
           EXTRACT(HOUR FROM timestamp_utc AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila') as hour_of_day, 
           AVG(temperature) as temperature, 
           AVG(rainfall) as rainfall, 
           AVG(wind_speed) as wind_speed, 
           AVG(humidity) as humidity
    FROM silver.hourly_weather
    GROUP BY DATE(timestamp_utc AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila'), 
             EXTRACT(HOUR FROM timestamp_utc AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila')
    """
    weather_df = pd.read_sql(weather_query, conn)
    weather_df['date_day'] = pd.to_datetime(weather_df['date_day'])
    print(f"Loaded {len(weather_df)} Weather hours.")
    
    print("4. Extracting Dim Time...")
    time_query = """
    SELECT date_day, hour_of_day, day_of_week, is_weekend, month_name, 
           quarter, is_rush_hour, is_holiday, is_holiday_window
    FROM dim.dim_time
    """
    time_df = pd.read_sql(time_query, conn)
    time_df['date_day'] = pd.to_datetime(time_df['date_day'])
    print(f"Loaded {len(time_df)} Time hours.")

    print("\nMerging all data...")
    # Merge using time_df as base (to ensure all hours exist, fill missing with 0 or forward fill)
    merged = pd.merge(time_df, vol_pivot, left_on=['date_day', 'hour_of_day'], right_on=['date', 'hour_of_day'], how='left')
    merged.drop(columns=['date'], inplace=True, errors='ignore')
    
    merged = pd.merge(merged, waze_df, on=['date_day', 'hour_of_day'], how='left')
    merged = pd.merge(merged, weather_df, on=['date_day', 'hour_of_day'], how='left')
    
    # Fill missing values
    merged['volume_class1'] = merged['volume_class1'].fillna(0)
    merged['volume_class2'] = merged['volume_class2'].fillna(0)
    merged['volume_class3'] = merged['volume_class3'].fillna(0)
    merged['total_volume'] = merged['total_volume'].fillna(0)
    
    # Forward fill weather, but if it's completely empty, provide defaults
    if weather_df.empty or merged['temperature'].isnull().all():
        merged['temperature'] = 30.0
        merged['rainfall'] = 0.0
        merged['wind_speed'] = 10.0
        merged['humidity'] = 80.0
    else:
        merged[['temperature', 'rainfall', 'wind_speed', 'humidity']] = merged[['temperature', 'rainfall', 'wind_speed', 'humidity']].ffill().bfill()

    
    # Leave speed and jam level as NaN if missing (e.g. for 2020-2021)
    # merged['avg_speed_kmh'] = merged['avg_speed_kmh'].fillna(80.0)
    # merged['avg_jam_level'] = merged['avg_jam_level'].fillna(0.0)
    merged['max_delay_seconds'] = merged['max_delay_seconds'].fillna(0.0)
    
    # Ensure boolean flags
    merged['is_weekend'] = merged['is_weekend'].astype(int)
    merged['is_rush_hour'] = merged['is_rush_hour'].astype(int)
    merged['is_holiday'] = merged['is_holiday'].astype(int)
    merged['is_holiday_window'] = merged['is_holiday_window'].astype(int)
    
    print("Saving dataset...")
    out_path = "C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs/traffic_speed_dataset.csv"
    merged.to_csv(out_path, index=False)
    print(f"Saved to {out_path} with {len(merged)} rows and {len(merged.columns)} columns.")
    
    conn.close()

if __name__ == "__main__":
    main()
