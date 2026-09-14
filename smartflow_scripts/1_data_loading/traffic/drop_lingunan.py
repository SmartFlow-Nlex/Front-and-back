import csv
import os
# Connection settings live in smartflow_scripts/config/.env, read by config/db.py.
# They used to be hardcoded in this file and in ~80 others.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[2] / "config"))
from db import setting  # noqa: E402
RAW_TRAFFIC_DIR = setting("RAW_TRAFFIC_DIR", required=True)   # set in config/.env

src = os.path.join(RAW_TRAFFIC_DIR, 'nlex_traffic_hourly_2025.csv')
dst = os.path.join(RAW_TRAFFIC_DIR, 'nlex_traffic_hourly_2025_clean.csv')

total = 0
dropped = 0

with open(src, 'r', encoding='utf-8') as fin, open(dst, 'w', encoding='utf-8', newline='') as fout:
    reader = csv.reader(fin)
    writer = csv.writer(fout)
    
    header = next(reader)
    writer.writerow(header)
    
    # Find the exit_plaza_name column index
    exit_col = header.index('exit_plaza_name')
    
    for row in reader:
        total += 1
        if 'Lingunan' in row[exit_col]:
            dropped += 1
        else:
            writer.writerow(row)

print(f"Total rows processed: {total:,}")
print(f"Lingunan rows dropped: {dropped:,}")
print(f"Rows kept: {total - dropped:,}")

# Replace original with clean file
os.replace(dst, src)
print(f"\nDone! Replaced original file with cleaned version.")
