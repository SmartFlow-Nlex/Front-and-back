raise SystemExit(
    "ARCHIVED - do not run. Belongs to the pre-2026-08-12 run: its folder convention (01_dataset/, 02_final_evaluation_walkforward/, 04_aws_live_predictions/) was archived to REPORTS_DIR/_archive_pre_2026-08-12_honest_retrain. Its input file is no longer at that path. "
    "Kept only as a record; see smartflow_scripts/README.md.")
import pandas as pd
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "config"))
from db import setting  # noqa: E402
df = pd.read_csv(os.path.join(setting("REPORTS_DIR", required=True), "01_dataset", "traffic_speed_dataset.csv"))
daily_sum = df.groupby('date_day')['total_volume'].sum()
print("First 5 daily sums in ML dataset:")
print(daily_sum.head())
print("\nMean daily sum:", daily_sum.mean())
