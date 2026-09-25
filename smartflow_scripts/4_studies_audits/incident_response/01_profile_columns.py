import pandas as pd, glob, ast, json
src = "D:/OneDrive_2026-09-08/shared files/"
acc = pd.concat([pd.read_csv(f, dtype=str) for f in sorted(glob.glob(src+"accident_data_*.csv"))], ignore_index=True)
brk = pd.concat([pd.read_csv(f, dtype=str) for f in sorted(glob.glob(src+"breakdown_data_*.csv"))], ignore_index=True)
print("ACCIDENT rows", len(acc), "cols", list(acc.columns))
print("BREAKDOWN rows", len(brk), "cols", list(brk.columns))
print()
print("--- accident null share per col")
print((acc.isna().mean()*100).round(1).to_string())
print()
for c in ["EventStatus","Direction","Location","SubLocation","TypeOfEvent","MainCause","Detection","WeatherCondition","deployment_count","NumberOfInjured","NumberOfFatality"]:
    print("--", c); print(acc[c].value_counts(dropna=False).head(15).to_string()); print()
print("date range acc", acc.event_start_date.min(), acc.event_start_date.max())
print("date range brk", brk.event_encoded_date.min(), brk.event_encoded_date.max())
