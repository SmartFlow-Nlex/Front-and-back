import pandas as pd
import numpy as np
import psycopg2
from sklearn.ensemble import RandomForestRegressor
from scipy.stats import pearsonr, spearmanr

POSTGRES_URL = "postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone"
conn = psycopg2.connect(POSTGRES_URL)

traffic_df = pd.read_sql_query("""
    SELECT date AS ds, total_volume AS y
    FROM gold.daily_traffic_volume
    WHERE date IS NOT NULL AND total_volume > 0
""", conn)
traffic_df['ds'] = pd.to_datetime(traffic_df['ds'])

weather_df = pd.read_sql_query("""
    SELECT 
        timestamp_utc::date AS ds,
        AVG(temperature)   AS avg_temp,
        SUM(rainfall)      AS total_rain,
        AVG(wind_speed)    AS avg_wind,
        AVG(humidity)      AS avg_humidity
    FROM public.hourly_weather
    GROUP BY timestamp_utc::date
""", conn)
weather_df['ds'] = pd.to_datetime(weather_df['ds'])

df = traffic_df.merge(weather_df, on='ds', how='inner').dropna()

print("==== PEARSON CORRELATION (Linear) ====")
for col in ['avg_temp', 'total_rain', 'avg_wind', 'avg_humidity']:
    r, p = pearsonr(df[col], df['y'])
    print(f"{col:15} | r = {r:+.4f} (p={p:.4f})")

print("\n==== SPEARMAN CORRELATION (Non-linear/Rank) ====")
for col in ['avg_temp', 'total_rain', 'avg_wind', 'avg_humidity']:
    r, p = spearmanr(df[col], df['y'])
    print(f"{col:15} | r = {r:+.4f} (p={p:.4f})")

print("\n==== RANDOM FOREST FEATURE IMPORTANCE ====")
# To isolate weather, we should also include day of week, otherwise weather might just proxy for seasonality
df['day_of_week'] = df['ds'].dt.dayofweek
df['month'] = df['ds'].dt.month
features = ['avg_temp', 'total_rain', 'avg_wind', 'avg_humidity', 'day_of_week', 'month']
rf = RandomForestRegressor(n_estimators=100, random_state=42)
rf.fit(df[features], df['y'])

for f, imp in zip(features, rf.feature_importances_):
    print(f"{f:15} | Importance = {imp:.4f}")
    
# Let's also look at extreme weather days
print("\n==== IMPACT OF HEAVY RAIN ====")
dry_days = df[df['total_rain'] == 0]
wet_days = df[df['total_rain'] > 0]
heavy_rain_days = df[df['total_rain'] > df['total_rain'].quantile(0.90)]

print(f"Avg Volume (Dry Days):    {dry_days['y'].mean():,.0f} vehicles")
print(f"Avg Volume (Wet Days):    {wet_days['y'].mean():,.0f} vehicles")
print(f"Avg Volume (Heavy Rain):  {heavy_rain_days['y'].mean():,.0f} vehicles")
print(f"Difference (Dry vs Heavy): {heavy_rain_days['y'].mean() - dry_days['y'].mean():,.0f} vehicles")
