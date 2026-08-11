import pandas as pd
df = pd.read_csv(r"C:\Users\Hans\.gemini\antigravity\scratch\predictive folder\training_and_testing_outputs\01_dataset\traffic_speed_dataset.csv")
daily_sum = df.groupby('date_day')['total_volume'].sum()
print("First 5 daily sums in ML dataset:")
print(daily_sum.head())
print("\nMean daily sum:", daily_sum.mean())
