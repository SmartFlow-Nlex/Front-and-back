import pandas as pd
import psycopg2
import os

POSTGRES_URL = "postgresql://postgres:Hanszy123@smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone?sslmode=require"
OUTPUT_DIR = "C:/Users/Hans/.gemini/antigravity/scratch/predictive folder/training_and_testing_outputs/04_aws_live_predictions"

def main():
    print("Connecting to AWS Database...")
    conn = psycopg2.connect(POSTGRES_URL)
    
    print("Fetching the latest predictions...")
    query = "SELECT * FROM gold.ml_predictive_volume ORDER BY forecast_date"
    df = pd.read_sql_query(query, conn)
    
    csv_path = os.path.join(OUTPUT_DIR, "aws_live_predictions.csv")
    df.to_csv(csv_path, index=False)
    
    print(f"Successfully exported {len(df)} predictions to:")
    print(csv_path)

if __name__ == "__main__":
    main()
