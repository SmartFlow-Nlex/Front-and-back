raise SystemExit(
    "ARCHIVED - do not run. Points at an older database instance (smartflow.cn4wwa2i4cux...) that is no longer production, and loads 2020-2021 data the project has since removed. "
    "Kept only as a record; see smartflow_scripts/README.md.")

import pandas as pd
import glob

folder = 'C:/Users/Hans/.gemini/antigravity/scratch/2020_2021_synthetic'
files = glob.glob(f"{folder}/*.csv")
for f in files:
    df = pd.read_csv(f, nrows=1)
    print(f"--- {f.split('/')[-1]} ---")
    print(df.columns.tolist())

