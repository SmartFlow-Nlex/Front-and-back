import os
import pandas as pd
from sqlalchemy import create_engine
import numpy as np
import warnings

# Suppress SQLAlchemy warnings
warnings.filterwarnings('ignore')

OUTPUT_DIR = "output"
DB_URL = "postgresql://postgres:Hanszy123@smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone"

def clean_time(t):
    """Clean time strings like '04:30 PM' to extract just the hour."""
    if pd.isna(t):
        return 0
    try:
        dt = pd.to_datetime(t, format='%I:%M %p')
        return dt.hour
    except:
        return 0

def clean_date(d):
    """Clean date strings which might be in different formats like '01/15/2020' or '15-Jan-20'"""
    try:
        return pd.to_datetime(d)
    except:
        return pd.NaT

def main():
    print("Connecting to AWS RDS to build the dataset from raw crash/stalled tables...")
    engine = create_engine(DB_URL)

    # 1. Load the 3 tables requested by the user
    print("Loading nlex_road_crashes...")
    df_road = pd.read_sql("SELECT date, reported_time, location FROM nlex_road_crashes", engine)
    print("Loading nlex_motorcycle_crashes...")
    df_moto = pd.read_sql("SELECT date, reported_time, location FROM nlex_motorcycle_crashes", engine)
    print("Loading nlex_stalled_vehicles...")
    df_stalled = pd.read_sql("SELECT date, reported_time, location FROM nlex_stalled_vehicles", engine)

    # 2. Combine them into a single incidents dataframe
    df_incidents = pd.concat([df_road, df_moto, df_stalled], ignore_index=True)
    print(f"Total raw incident records from AWS: {len(df_incidents)}")

    # 3. Clean and format Dates and Times
    df_incidents['date_day'] = df_incidents['date'].apply(clean_date)
    df_incidents['hour_of_day'] = df_incidents['reported_time'].apply(clean_time)
    
    # Drop rows with invalid dates
    df_incidents = df_incidents.dropna(subset=['date_day'])
    df_incidents['date_day'] = df_incidents['date_day'].dt.date

    # 4. Group by Date, Hour, Location to get the incident_count
    agg_incidents = df_incidents.groupby(['date_day', 'hour_of_day', 'location']).size().reset_index(name='incident_count')

    # Limit to Top 15 locations by incident count to prevent 16-million row explosion
    top_locations = agg_incidents.groupby('location')['incident_count'].sum().nlargest(15).index
    agg_incidents = agg_incidents[agg_incidents['location'].isin(top_locations)]
    
    # 5. Build the Zero-Inflated Master Grid
    unique_dates = agg_incidents['date_day'].unique()
    unique_locations = top_locations
    
    if len(unique_dates) == 0:
        print("No valid dates found in data. Exiting.")
        return
        
    max_date = max(unique_dates)
    # Limit to the most recent 2 years (730 days) of data to keep training fast
    min_date = max_date - pd.Timedelta(days=730)
    print(f"Date range limited to: {min_date} to {max_date}")
    
    # Filter agg_incidents to just this date range
    agg_incidents = agg_incidents[(agg_incidents['date_day'] >= min_date) & (agg_incidents['date_day'] <= max_date)]
    
    all_dates = pd.date_range(start=min_date, end=max_date, freq='D').date
    all_hours = list(range(24))
    
    # Create multi-index from product of lists
    idx = pd.MultiIndex.from_product([all_dates, all_hours, unique_locations], names=['date_day', 'hour_of_day', 'location'])
    grid = pd.DataFrame(index=idx).reset_index()
    
    # 6. Left Join the actual incidents onto the master grid
    master_df = pd.merge(grid, agg_incidents, on=['date_day', 'hour_of_day', 'location'], how='left')
    master_df['incident_count'] = master_df['incident_count'].fillna(0).astype(int)
    
    # 7. Add Temporal Features
    master_df['date_day'] = pd.to_datetime(master_df['date_day'])
    master_df['day_of_week'] = master_df['date_day'].dt.dayofweek
    master_df['is_weekend'] = master_df['day_of_week'].isin([5, 6]).astype(int)
    master_df['is_rush_hour'] = master_df['hour_of_day'].isin([7,8,9, 17,18,19]).astype(int)
    master_df['is_holiday'] = 0 # Placeholder unless we merge a holiday calendar
    
    print(f"Master Zero-Inflated Dataset generated with {len(master_df)} rows.")
    
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    output_file = os.path.join(OUTPUT_DIR, "aws_incident_dataset.csv")
    master_df.to_csv(output_file, index=False)
    print(f"Saved to {output_file}")

if __name__ == "__main__":
    main()
