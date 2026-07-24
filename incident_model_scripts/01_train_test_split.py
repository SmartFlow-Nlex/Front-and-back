import os
import pandas as pd
import numpy as np

# Configurations
INPUT_CSV = r"D:\predictive folder\training_and_testing_outputs\01_dataset\incident_dataset_per_exit.csv"
OUTPUT_DIR = "output"

def main():
    print(f"Loading dataset: {INPUT_CSV}")
    
    if not os.path.exists(INPUT_CSV):
        print(f"Error: Could not find {INPUT_CSV}")
        return

    # Read the dataset
    df = pd.read_csv(INPUT_CSV)
    print(f"Total records loaded: {len(df)}")
    
    # Preprocessing
    # Sort by date/time
    if "date_day" in df.columns and "hour_of_day" in df.columns:
        df["datetime"] = pd.to_datetime(df["date_day"]) + pd.to_timedelta(df["hour_of_day"], unit='h')
        df = df.sort_values(by="datetime").reset_index(drop=True)
    
    # Fill missing weather features if they exist
    weather_cols = ["temperature", "rainfall", "wind_speed", "humidity"]
    for col in weather_cols:
        if col in df.columns:
            df[col] = df[col].fillna(df[col].median())
    
    # Fill avg_speed_kmh and avg_jam_level
    if "avg_speed_kmh" in df.columns:
        df["avg_speed_kmh"] = df["avg_speed_kmh"].fillna(df["avg_speed_kmh"].median())
    if "avg_jam_level" in df.columns:
        df["avg_jam_level"] = df["avg_jam_level"].fillna(0)

    # 80/20 chronological train-test split
    split_idx = int(len(df) * 0.8)
    train_df = df.iloc[:split_idx].copy()
    test_df = df.iloc[split_idx:].copy()

    # Ensure output directory exists
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # Save datasets
    train_file = os.path.join(OUTPUT_DIR, "train_incident.csv")
    test_file = os.path.join(OUTPUT_DIR, "test_incident.csv")
    
    train_df.to_csv(train_file, index=False)
    test_df.to_csv(test_file, index=False)
    
    print(f"Train set saved: {train_file} ({len(train_df)} rows)")
    print(f"Test set saved: {test_file} ({len(test_df)} rows)")
    print("Dataset split complete!")

if __name__ == "__main__":
    main()
