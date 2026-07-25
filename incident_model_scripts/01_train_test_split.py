import os
import pandas as pd
from sklearn.preprocessing import LabelEncoder

OUTPUT_DIR = "output"

def main():
    print("Loading raw AWS zero-inflated dataset...")
    input_file = os.path.join(OUTPUT_DIR, "aws_incident_dataset.csv")
    
    if not os.path.exists(input_file):
        print(f"Error: {input_file} not found. Run 01_dataset_builder_aws.py first.")
        return
        
    df = pd.read_csv(input_file)
    print(f"Loaded {len(df)} rows.")

    # Sort chronologically
    df['date_day'] = pd.to_datetime(df['date_day'])
    df = df.sort_values(by=["date_day", "hour_of_day"]).reset_index(drop=True)
    
    # Encode location strings to integers so ML models can use them
    le = LabelEncoder()
    df['location_id'] = le.fit_transform(df['location'].astype(str))
    
    # Save the encoder classes so we know what location_id = 0 means
    loc_mapping = pd.DataFrame({
        'location': le.classes_,
        'location_id': range(len(le.classes_))
    })
    loc_mapping.to_csv(os.path.join(OUTPUT_DIR, "location_mapping.csv"), index=False)
    print(f"Encoded {len(le.classes_)} unique locations.")

    # 80/20 Chronological Split
    split_idx = int(len(df) * 0.8)
    train_df = df.iloc[:split_idx].copy()
    test_df = df.iloc[split_idx:].copy()

    train_file = os.path.join(OUTPUT_DIR, "train_incident.csv")
    test_file = os.path.join(OUTPUT_DIR, "test_incident.csv")
    
    train_df.to_csv(train_file, index=False)
    test_df.to_csv(test_file, index=False)
    
    print(f"Train set saved: {train_file} ({len(train_df)} rows)")
    print(f"Test set saved: {test_file} ({len(test_df)} rows)")
    
    # Validation info
    print("\nTraining feature snippet:")
    features = ['hour_of_day', 'day_of_week', 'is_weekend', 'is_rush_hour', 'is_holiday', 'location_id']
    print(train_df[features].head())

if __name__ == "__main__":
    main()
