from dotenv import load_dotenv
load_dotenv()  # DB credentials come from .env, never from source
"""
SmartFlow NLEX — Incident Data Extraction & Feature Engineering
================================================================
Extracts incident data from AWS RDS (road crashes, motorcycle crashes, stalled vehicles).
Excludes apprehensions (traffic violations).
Aggregates to hourly grain — both GLOBAL and PER-EXIT.
Joins with traffic volume, speed, weather, and time dimensions.
"""
import psycopg2
import pandas as pd
import numpy as np
import os

conn_string = os.environ["PG_CONN"]

# NLEX exits with their KM markers (for mapping incidents to nearest exit)
NLEX_EXITS = [
    ("Balintawak", 11.0),
    ("Valenzuela", 16.8),
    ("Meycauayan", 24.0),
    ("Marilao", 27.0),
    ("Bocaue", 31.0),
    ("Balagtas", 36.0),
    ("Tabang", 40.0),
    ("Santa Rita", 44.0),
    ("Pulilan", 50.0),
    ("San Simon", 56.0),
    ("San Fernando", 67.0),
    ("Mexico", 74.0),
    ("Angeles", 78.0),
    ("Dau", 82.0),
    ("Sta. Ines", 93.0),
]

def extract_km_from_location(loc):
    """Extract KM value from location strings like 'Km 15+600', 'KM 25+000', etc."""
    if pd.isna(loc):
        return np.nan
    loc = str(loc).upper().strip()
    
    # Try to find KM pattern
    import re
    # Match patterns like "KM 15+600", "KM15+600", "KM 25", "KM25+000"
    match = re.search(r'KM\s*(\d+)\+?(\d*)', loc)
    if match:
        km = float(match.group(1))
        if match.group(2):
            km += float(match.group(2)) / 1000.0
        return km
    
    # Try to match named locations
    loc_lower = loc.lower()
    for exit_name, exit_km in NLEX_EXITS:
        if exit_name.lower() in loc_lower:
            return exit_km
    
    return np.nan

def map_to_nearest_exit(km_value):
    """Map a KM value to the nearest NLEX exit."""
    if pd.isna(km_value):
        return "Unknown"
    
    min_dist = float('inf')
    nearest = "Unknown"
    for exit_name, exit_km in NLEX_EXITS:
        dist = abs(km_value - exit_km)
        if dist < min_dist:
            min_dist = dist
            nearest = exit_name
    return nearest

def main():
    print("Connecting to AWS RDS...")
    conn = psycopg2.connect(conn_string)
    
    # =====================================================
    # 1. EXTRACT ROAD CRASHES
    # =====================================================
    print("\n1. Extracting Road Crashes...")
    road_query = """
    SELECT 
        date AS incident_date,
        reported_time,
        cleared_time,
        location,
        no_of_vehicles_involved,
        cause_of_accident,
        type_of_accident,
        weather_condition,
        injuries_male AS no_of_injuries_male,
        injuries_female AS no_of_injuries_female,
        fatalities_male AS no_of_fatalities_male,
        fatalities_female AS no_of_fatalities_female
    FROM bronze.road_crashes
    """
    road_df = pd.read_sql(road_query, conn)
    road_df['incident_type'] = 'road_crash'
    print(f"  Loaded {len(road_df)} road crashes")
    
    # =====================================================
    # 2. EXTRACT MOTORCYCLE CRASHES
    # =====================================================
    print("2. Extracting Motorcycle Crashes...")
    moto_query = """
    SELECT 
        date AS incident_date,
        reported_time,
        cleared_time,
        location,
        no_of_vehicles_involved,
        cause_of_accident,
        type_of_accident,
        weather_condition,
        injuries_male AS no_of_injuries_male,
        injuries_female AS no_of_injuries_female,
        fatalities_male AS no_of_fatalities_male,
        fatalities_female AS no_of_fatalities_female
    FROM bronze.motorcycle_crashes
    """
    moto_df = pd.read_sql(moto_query, conn)
    moto_df['incident_type'] = 'motorcycle_crash'
    print(f"  Loaded {len(moto_df)} motorcycle crashes")
    
    # =====================================================
    # 3. EXTRACT STALLED VEHICLES
    # =====================================================
    print("3. Extracting Stalled Vehicles...")
    stall_query = """
    SELECT 
        date AS incident_date,
        reported_time,
        cleared_time,
        location,
        vehicle_cause
    FROM bronze.stalled_vehicles
    """
    stall_df = pd.read_sql(stall_query, conn)
    stall_df['incident_type'] = 'stalled_vehicle'
    stall_df['no_of_vehicles_involved'] = 1
    stall_df['cause_of_accident'] = stall_df['vehicle_cause']
    stall_df['type_of_accident'] = 'Stall'
    stall_df['weather_condition'] = np.nan
    stall_df['no_of_injuries_male'] = 0
    stall_df['no_of_injuries_female'] = 0
    stall_df['no_of_fatalities_male'] = 0
    stall_df['no_of_fatalities_female'] = 0
    stall_df.drop(columns=['vehicle_cause'], inplace=True)
    print(f"  Loaded {len(stall_df)} stalled vehicles")
    
    # =====================================================
    # 4. COMBINE ALL INCIDENTS
    # =====================================================
    print("\n4. Combining all incidents...")
    cols = ['incident_date', 'reported_time', 'cleared_time', 'location', 
            'incident_type', 'no_of_vehicles_involved', 'cause_of_accident',
            'type_of_accident', 'weather_condition',
            'no_of_injuries_male', 'no_of_injuries_female',
            'no_of_fatalities_male', 'no_of_fatalities_female']
    
    all_incidents = pd.concat([road_df[cols], moto_df[cols], stall_df[cols]], ignore_index=True)
    print(f"  Total incidents: {len(all_incidents)}")
    
    # Parse dates and times
    all_incidents['incident_date'] = pd.to_datetime(all_incidents['incident_date'], errors='coerce')
    all_incidents['reported_time'] = pd.to_datetime(all_incidents['reported_time'], format='mixed', errors='coerce')
    all_incidents['cleared_time'] = pd.to_datetime(all_incidents['cleared_time'], format='mixed', errors='coerce')
    
    # Extract hour from reported_time
    all_incidents['hour_of_day'] = all_incidents['reported_time'].dt.hour
    # If reported_time is NaT, try to use a default
    all_incidents['hour_of_day'] = all_incidents['hour_of_day'].fillna(12).astype(int)
    
    # Extract KM and map to nearest exit
    print("  Mapping locations to KM markers and exits...")
    all_incidents['km_value'] = all_incidents['location'].apply(extract_km_from_location)
    all_incidents['nearest_exit'] = all_incidents['km_value'].apply(map_to_nearest_exit)
    
    # Calculate clearance time in minutes
    all_incidents['clearance_minutes'] = (
        (all_incidents['cleared_time'] - all_incidents['reported_time']).dt.total_seconds() / 60.0
    )
    all_incidents['clearance_minutes'] = all_incidents['clearance_minutes'].clip(lower=0, upper=1440)
    
    # Total injuries and fatalities
    all_incidents['total_injuries'] = (
        all_incidents['no_of_injuries_male'].fillna(0) + 
        all_incidents['no_of_injuries_female'].fillna(0)
    ).astype(int)
    all_incidents['total_fatalities'] = (
        all_incidents['no_of_fatalities_male'].fillna(0) + 
        all_incidents['no_of_fatalities_female'].fillna(0)
    ).astype(int)
    
    # Severity classification
    def classify_severity(row):
        if row['total_fatalities'] > 0:
            return 'critical'
        elif row['total_injuries'] > 0:
            return 'moderate'
        elif row['incident_type'] in ['road_crash', 'motorcycle_crash']:
            return 'minor'
        else:
            return 'low'
    
    all_incidents['severity'] = all_incidents.apply(classify_severity, axis=1)
    
    # Drop rows with no valid date
    all_incidents = all_incidents.dropna(subset=['incident_date'])
    print(f"  Valid incidents after cleaning: {len(all_incidents)}")
    
    # Print summary
    print("\n  Incident Type Breakdown:")
    print(all_incidents['incident_type'].value_counts().to_string())
    print("\n  Severity Breakdown:")
    print(all_incidents['severity'].value_counts().to_string())
    print(f"\n  Date Range: {all_incidents['incident_date'].min()} to {all_incidents['incident_date'].max()}")
    print(f"  Nearest Exit Distribution:")
    print(all_incidents['nearest_exit'].value_counts().head(10).to_string())
    
    # =====================================================
    # 5. AGGREGATE TO HOURLY — GLOBAL
    # =====================================================
    print("\n5. Aggregating to hourly grain (GLOBAL)...")
    hourly_global = all_incidents.groupby(
        [all_incidents['incident_date'].dt.date.rename('date_day'), 'hour_of_day']
    ).agg(
        incident_count=('incident_type', 'size'),
        crash_count=('incident_type', lambda x: (x.isin(['road_crash', 'motorcycle_crash'])).sum()),
        stall_count=('incident_type', lambda x: (x == 'stalled_vehicle').sum()),
        avg_clearance_min=('clearance_minutes', 'mean'),
        total_injuries=('total_injuries', 'sum'),
        total_fatalities=('total_fatalities', 'sum'),
        avg_vehicles_involved=('no_of_vehicles_involved', 'mean'),
    ).reset_index()
    
    hourly_global['has_incident'] = 1  # All these rows have at least one incident
    print(f"  Hourly records with incidents: {len(hourly_global)}")
    
    # =====================================================
    # 6. AGGREGATE TO HOURLY — PER EXIT
    # =====================================================
    print("6. Aggregating to hourly grain (PER EXIT)...")
    hourly_exit = all_incidents.groupby(
        [all_incidents['incident_date'].dt.date.rename('date_day'), 'hour_of_day', 'nearest_exit']
    ).agg(
        incident_count=('incident_type', 'size'),
        crash_count=('incident_type', lambda x: (x.isin(['road_crash', 'motorcycle_crash'])).sum()),
        stall_count=('incident_type', lambda x: (x == 'stalled_vehicle').sum()),
        avg_clearance_min=('clearance_minutes', 'mean'),
        total_injuries=('total_injuries', 'sum'),
        total_fatalities=('total_fatalities', 'sum'),
    ).reset_index()
    
    hourly_exit['has_incident'] = 1
    print(f"  Hourly-exit records with incidents: {len(hourly_exit)}")
    
    # =====================================================
    # 7. LOAD TIME DIMENSION (to fill zero-incident hours)
    # =====================================================
    print("\n7. Loading time dimension and filling zero-incident hours...")
    time_query = """
    SELECT date_day, hour_of_day, day_of_week, is_weekend, month_name, 
           quarter, is_rush_hour, is_holiday, is_holiday_window
    FROM dim.dim_time
    WHERE date_day >= '2022-01-01' AND date_day <= '2026-06-30'
    """
    time_df = pd.read_sql(time_query, conn)
    time_df['date_day'] = pd.to_datetime(time_df['date_day']).dt.date
    print(f"  Time dimension rows: {len(time_df)}")
    
    # =====================================================
    # 8. LOAD TRAFFIC + WEATHER (reuse from our existing dataset)
    # =====================================================
    print("8. Loading traffic volume and weather data...")
    vol_query = """
    SELECT date, hour_of_day, vehicle_class, SUM(volume) as volume
    FROM silver.traffic_volume
    WHERE date >= '2022-01-01'
    GROUP BY date, hour_of_day, vehicle_class
    """
    vol_df = pd.read_sql(vol_query, conn)
    vol_df['date'] = pd.to_datetime(vol_df['date']).dt.date
    vol_pivot = vol_df.pivot_table(index=['date', 'hour_of_day'],
                                   columns='vehicle_class',
                                   values='volume', fill_value=0).reset_index()
    vol_pivot.columns = ['date_day', 'hour_of_day'] + [f'volume_{c.lower().replace(" ", "")}' for c in vol_pivot.columns[2:]]
    if 'volume_class1' not in vol_pivot.columns: vol_pivot['volume_class1'] = 0
    if 'volume_class2' not in vol_pivot.columns: vol_pivot['volume_class2'] = 0
    if 'volume_class3' not in vol_pivot.columns: vol_pivot['volume_class3'] = 0
    vol_pivot['total_volume'] = vol_pivot['volume_class1'] + vol_pivot['volume_class2'] + vol_pivot['volume_class3']
    print(f"  Volume rows: {len(vol_pivot)}")
    
    weather_query = """
    SELECT DATE(timestamp_utc AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila') as date_day, 
           EXTRACT(HOUR FROM timestamp_utc AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila') as hour_of_day, 
           AVG(temperature) as temperature, 
           AVG(rainfall) as rainfall, 
           AVG(wind_speed) as wind_speed, 
           AVG(humidity) as humidity
    FROM silver.hourly_weather
    WHERE timestamp_utc >= '2022-01-01'
    GROUP BY DATE(timestamp_utc AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila'), 
             EXTRACT(HOUR FROM timestamp_utc AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila')
    """
    weather_df = pd.read_sql(weather_query, conn)
    weather_df['date_day'] = pd.to_datetime(weather_df['date_day']).dt.date
    weather_df['hour_of_day'] = weather_df['hour_of_day'].astype(int)
    print(f"  Weather rows: {len(weather_df)}")
    
    # Speed data
    speed_query = """
    SELECT date_day, hour_of_day, 
           AVG(avg_speed_kmh) as avg_speed_kmh,
           AVG(avg_jam_level) as avg_jam_level
    FROM silver.waze_hourly_jams
    WHERE date_day >= '2022-01-01'
    GROUP BY date_day, hour_of_day
    """
    speed_df = pd.read_sql(speed_query, conn)
    speed_df['date_day'] = pd.to_datetime(speed_df['date_day']).dt.date
    print(f"  Speed rows: {len(speed_df)}")
    
    conn.close()
    print("  Database connection closed.")
    
    # =====================================================
    # 9. BUILD GLOBAL INCIDENT DATASET
    # =====================================================
    print("\n9. Building GLOBAL incident dataset...")
    
    # Merge time with incident counts
    hourly_global['date_day'] = pd.to_datetime(hourly_global['date_day']).dt.date if not isinstance(hourly_global['date_day'].iloc[0], type(time_df['date_day'].iloc[0])) else hourly_global['date_day']
    
    merged = pd.merge(time_df, hourly_global, on=['date_day', 'hour_of_day'], how='left')
    
    # Fill zero-incident hours
    merged['incident_count'] = merged['incident_count'].fillna(0).astype(int)
    merged['crash_count'] = merged['crash_count'].fillna(0).astype(int)
    merged['stall_count'] = merged['stall_count'].fillna(0).astype(int)
    merged['has_incident'] = merged['has_incident'].fillna(0).astype(int)
    merged['avg_clearance_min'] = merged['avg_clearance_min'].fillna(0)
    merged['total_injuries'] = merged['total_injuries'].fillna(0).astype(int)
    merged['total_fatalities'] = merged['total_fatalities'].fillna(0).astype(int)
    merged['avg_vehicles_involved'] = merged['avg_vehicles_involved'].fillna(0)
    
    # Merge with volume
    merged = pd.merge(merged, vol_pivot, on=['date_day', 'hour_of_day'], how='left')
    merged['total_volume'] = merged['total_volume'].fillna(0)
    
    # Merge with weather
    merged = pd.merge(merged, weather_df, on=['date_day', 'hour_of_day'], how='left')
    merged[['temperature', 'rainfall', 'wind_speed', 'humidity']] = merged[['temperature', 'rainfall', 'wind_speed', 'humidity']].ffill().bfill()
    
    # Merge with speed
    merged = pd.merge(merged, speed_df, on=['date_day', 'hour_of_day'], how='left')
    
    # Boolean conversions
    merged['is_weekend'] = merged['is_weekend'].astype(int)
    merged['is_rush_hour'] = merged['is_rush_hour'].astype(int)
    merged['is_holiday'] = merged['is_holiday'].astype(int)
    
    # Lag features
    merged.sort_values(['date_day', 'hour_of_day'], inplace=True)
    merged['incidents_lag_24h'] = merged['incident_count'].shift(24).fillna(0).astype(int)
    merged['incidents_lag_168h'] = merged['incident_count'].shift(168).fillna(0).astype(int)
    
    print(f"  Global dataset: {len(merged)} rows, {len(merged.columns)} columns")
    print(f"  Hours with incidents: {merged['has_incident'].sum()} ({merged['has_incident'].mean()*100:.1f}%)")
    print(f"  Hours without incidents: {(merged['has_incident']==0).sum()} ({(merged['has_incident']==0).mean()*100:.1f}%)")
    
    # Save GLOBAL dataset
    out_dir = 'C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs/01_dataset'
    os.makedirs(out_dir, exist_ok=True)
    merged.to_csv(f"{out_dir}/incident_dataset_global.csv", index=False)
    print(f"  Saved: incident_dataset_global.csv")
    
    # =====================================================
    # 10. BUILD PER-EXIT INCIDENT DATASET
    # =====================================================
    print("\n10. Building PER-EXIT incident dataset...")
    
    # Create full grid: every (date, hour, exit) combination
    exits = [e[0] for e in NLEX_EXITS]
    time_exit_grid = time_df.assign(key=1).merge(
        pd.DataFrame({'nearest_exit': exits, 'key': 1}), on='key'
    ).drop('key', axis=1)
    
    hourly_exit['date_day'] = pd.to_datetime(hourly_exit['date_day']).dt.date if not isinstance(hourly_exit['date_day'].iloc[0], type(time_df['date_day'].iloc[0])) else hourly_exit['date_day']
    
    exit_merged = pd.merge(time_exit_grid, hourly_exit, 
                           on=['date_day', 'hour_of_day', 'nearest_exit'], how='left')
    
    exit_merged['incident_count'] = exit_merged['incident_count'].fillna(0).astype(int)
    exit_merged['crash_count'] = exit_merged['crash_count'].fillna(0).astype(int)
    exit_merged['stall_count'] = exit_merged['stall_count'].fillna(0).astype(int)
    exit_merged['has_incident'] = exit_merged['has_incident'].fillna(0).astype(int)
    exit_merged['avg_clearance_min'] = exit_merged['avg_clearance_min'].fillna(0)
    exit_merged['total_injuries'] = exit_merged['total_injuries'].fillna(0).astype(int)
    exit_merged['total_fatalities'] = exit_merged['total_fatalities'].fillna(0).astype(int)
    
    # Merge with volume and weather (global, since we don't have per-exit volume)
    exit_merged = pd.merge(exit_merged, vol_pivot, on=['date_day', 'hour_of_day'], how='left')
    exit_merged['total_volume'] = exit_merged['total_volume'].fillna(0)
    exit_merged = pd.merge(exit_merged, weather_df, on=['date_day', 'hour_of_day'], how='left')
    exit_merged[['temperature', 'rainfall', 'wind_speed', 'humidity']] = exit_merged[['temperature', 'rainfall', 'wind_speed', 'humidity']].ffill().bfill()
    exit_merged = pd.merge(exit_merged, speed_df, on=['date_day', 'hour_of_day'], how='left')
    
    exit_merged['is_weekend'] = exit_merged['is_weekend'].astype(int)
    exit_merged['is_rush_hour'] = exit_merged['is_rush_hour'].astype(int)
    exit_merged['is_holiday'] = exit_merged['is_holiday'].astype(int)
    
    # Encode exit as numeric
    exit_map = {name: i for i, (name, _) in enumerate(NLEX_EXITS)}
    exit_merged['exit_code'] = exit_merged['nearest_exit'].map(exit_map).fillna(-1).astype(int)
    exit_merged['exit_km'] = exit_merged['nearest_exit'].map(dict(NLEX_EXITS)).fillna(0)
    
    print(f"  Per-exit dataset: {len(exit_merged)} rows, {len(exit_merged.columns)} columns")
    print(f"  Hours-exits with incidents: {exit_merged['has_incident'].sum()} ({exit_merged['has_incident'].mean()*100:.2f}%)")
    
    # Save PER-EXIT dataset
    exit_merged.to_csv(f"{out_dir}/incident_dataset_per_exit.csv", index=False)
    print(f"  Saved: incident_dataset_per_exit.csv")
    
    # =====================================================
    # 11. SAVE RAW INCIDENTS FOR REFERENCE
    # =====================================================
    all_incidents.to_csv(f"{out_dir}/incidents_raw_combined.csv", index=False)
    print(f"\n  Saved: incidents_raw_combined.csv ({len(all_incidents)} records)")
    
    print("\n" + "="*60)
    print("  INCIDENT DATA EXTRACTION COMPLETE")
    print("="*60)
    print(f"  Total raw incidents: {len(all_incidents)}")
    print(f"  Global dataset: {len(merged)} hourly rows")
    print(f"  Per-exit dataset: {len(exit_merged)} hourly-exit rows")
    print(f"  Date range: 2022-01-01 to 2026-06-30")

if __name__ == "__main__":
    main()
