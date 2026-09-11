import csv
import os
from collections import Counter

folder = r'C:\Users\Hans\.gemini\antigravity\scratch\synthetic-nlex-data'

for fname in sorted(os.listdir(folder)):
    if not fname.endswith('.csv'):
        continue
    fpath = os.path.join(folder, fname)
    size_mb = os.path.getsize(fpath) / (1024*1024)
    
    print(f"\n{'='*60}")
    print(f"FILE: {fname} ({size_mb:.1f} MB)")
    print(f"{'='*60}")
    
    with open(fpath, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        rows = 0
        exit_plazas = Counter()
        date_min = None
        date_max = None
        
        for row in reader:
            rows += 1
            exit_plazas[row['exit_plaza_name']] += 1
            d = row['date']
            if date_min is None or d < date_min:
                date_min = d
            if date_max is None or d > date_max:
                date_max = d
        
        print(f"  Total rows: {rows:,}")
        print(f"  Date range: {date_min} to {date_max}")
        print(f"  Unique exit plazas: {len(exit_plazas)}")
        print(f"\n  Exit Plaza Names ({len(exit_plazas)} total):")
        for plaza, cnt in sorted(exit_plazas.items(), key=lambda x: -x[1]):
            print(f"    - {plaza}: {cnt:,} rows")
