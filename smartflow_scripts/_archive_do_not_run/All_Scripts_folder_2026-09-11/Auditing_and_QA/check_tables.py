import pandas as pd
import glob

folder = 'C:/Users/Hans/.gemini/antigravity/scratch/2020_2021_synthetic'
files = glob.glob(f"{folder}/*.csv")
for f in files:
    df = pd.read_csv(f, nrows=1)
    print(f"--- {f.split('/')[-1]} ---")
    print(df.columns.tolist())

