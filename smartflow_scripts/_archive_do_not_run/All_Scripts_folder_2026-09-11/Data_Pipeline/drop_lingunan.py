import csv
import os

src = r'C:\Users\Hans\.gemini\antigravity\scratch\synthetic-nlex-data\nlex_traffic_hourly_2025.csv'
dst = r'C:\Users\Hans\.gemini\antigravity\scratch\synthetic-nlex-data\nlex_traffic_hourly_2025_clean.csv'

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
