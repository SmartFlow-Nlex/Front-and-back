import pandas as pd
df = pd.read_csv('C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs/traffic_speed_dataset.csv')
df['date_time'] = pd.to_datetime(df['date_day']) + pd.to_timedelta(df['hour_of_day'], unit='h')

vol_df = df.dropna(subset=['total_volume'])
vol_df = vol_df[vol_df['total_volume'] > 0]
print("VOLUME DATA:")
print(f"  Rows: {len(vol_df):,}")
print(f"  Date Range: {vol_df['date_time'].min()} to {vol_df['date_time'].max()}")

spd_df = df.dropna(subset=['avg_speed_kmh'])
print("\nSPEED DATA:")
print(f"  Rows: {len(spd_df):,}")
print(f"  Date Range: {spd_df['date_time'].min()} to {spd_df['date_time'].max()}")
