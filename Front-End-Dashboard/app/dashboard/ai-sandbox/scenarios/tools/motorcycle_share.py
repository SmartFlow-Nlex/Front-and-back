#!/usr/bin/env python3
"""
How many motorcycles do NLEX's own records show, and where do they sit in NLEX's vehicle classes?

Read-only: reads two columns (TypeOfVehicle, VehicleClass) of the client's breakdown exports and prints
counts. It never reads, keeps or prints a plate number, a driver or any other personal field.

    python motorcycle_share.py --csv-dir <folder holding breakdown_data_*.csv>

    The folder can also come from the NLEX_CSV_DIR environment variable. There is no built-in default path.

WHAT IT REPORTS
  - every TypeOfVehicle value with its count, and every VehicleClass value with its count;
  - the class each Motorcycle record is filed under (in the 2022-2026 exports: all of them Class 1);
  - the motorcycle share of ALL records, and of Class 1 records — the figure the sandbox draws motorcycles at
    (ASSUMPTIONS.MOTORCYCLE_SHARE_OF_CLASS_1).

WHAT IT CANNOT TELL YOU
  These are breakdown records, not traffic counts. The share is a fleet share only if motorcycles break down
  as often, per vehicle, as the other Class 1 vehicles do — an assumption, recorded as one. The traffic table
  (gold.fact_traffic_hourly) carries class_1 / class_2 / class_3 and a total, with no motorcycle count of its
  own; NLEX files motorcycles under Class 1, so they are inside class_1.
"""
import argparse
import csv
import glob
import io
import os
import sys
from collections import Counter

csv.field_size_limit(10**9)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv-dir", default=os.environ.get("NLEX_CSV_DIR"), help="folder with breakdown_data_*.csv")
    args = ap.parse_args()
    if not args.csv_dir:
        print("--csv-dir (or NLEX_CSV_DIR) is required: there is no built-in default path.", file=sys.stderr)
        return 2
    files = sorted(glob.glob(os.path.join(args.csv_dir, "breakdown_data_*.csv")))
    if not files:
        print(f"no breakdown_data_*.csv in {args.csv_dir}", file=sys.stderr)
        return 2

    types: Counter = Counter()
    classes: Counter = Counter()
    moto_class: Counter = Counter()
    rows = 0
    for fp in files:
        with io.open(fp, encoding="utf-8-sig", errors="replace", newline="") as f:
            for row in csv.DictReader(f):
                rows += 1
                t = (row.get("TypeOfVehicle") or "").strip() or "(blank)"
                c = (row.get("VehicleClass") or "").strip() or "(blank)"
                types[t] += 1
                classes[c] += 1
                if t.lower() == "motorcycle":
                    moto_class[c] += 1

    moto = types.get("Motorcycle", 0)
    print(f"{len(files)} files, {rows:,} breakdown records")
    print("\nTypeOfVehicle:")
    for k, v in types.most_common():
        print(f"  {v:>9,}  {k}")
    print("\nVehicleClass:")
    for k, v in classes.most_common():
        print(f"  {v:>9,}  {k}")
    print(f"\nMotorcycle records: {moto:,}, filed under: {dict(moto_class)}")
    print(f"  share of all records     : {moto / rows:.4%}")
    class_1 = classes.get("Class 1", 0)
    if class_1:
        print(f"  share of Class 1 records : {moto / class_1:.4%}   ({moto:,} / {class_1:,})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
