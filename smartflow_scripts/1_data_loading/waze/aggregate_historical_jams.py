"""Roll the local 38 GB Waze jam export up to one row per exit-hour.

WHY. The live collector fills silver.fact_waze_jams from 4 Aug 2026 onward, so
the congestion model sees about eight weeks. Four years of jam history sits in
the cleaned Partner Hub export on the analyst's PC, but what reached the
warehouse from it -- bronze.waze_hourly_jams -- is unusable: its "nlex_exit_id"
column holds Waze segment ids (289,787 distinct values, up to 1.8 billion), and
the silver copy dropped the column instead of fixing it, leaving rows with no
location at all.

This reads the export once, locally, and writes a compact hourly summary. The
38 GB never leaves the machine; only ~750k rows (under 100 MB) are loaded, which
is the hybrid design the project already follows: raw stays local, the data-mart
gets what the dashboard and the models query.

TWO THINGS THIS FIXES ON THE WAY THROUGH

1. EXIT IDS ARE RE-MATCHED, NOT TRUSTED. The export was matched in July 2026
   against an older exit list (id 13 = Apalit, id 19 = "Sta. Ines / SCTEX").
   bronze.nlex_exits today is a different list (id 13 = Pulilan, id 19 = SCTEX),
   and Apalit, Calumpit, Karuhatan and Plaridel are not in it. Joining on the
   file's nearest_exit_id would attach jams to the wrong places, so every row is
   re-matched from its own match_lat/match_lon to the current exits.

2. TIME IS CONVERTED TO MANILA. The file stamps UTC; silver.fact_waze_jams and
   the dashboard both key on Manila-local date_day / hour_of_day. The older
   hourly tables bucketed by the UTC string, which is an 8-hour shift against
   everything else.

COUNTING. A jam appears in every 2-minute snapshot it survives, so raw rows are
snapshots, not jams. Both are kept: jam_snapshots (exposure) and jams_distinct
(unique uuids in that exit-hour), the latter being what compares with the live
table's one-row-per-jam. Speed is length-weighted over snapshots, which is a
time-weighted average of conditions during the hour.

RUN (about 20-40 minutes for 38 GB; nothing touches the database):
    python smartflow_scripts/1_data_loading/waze/aggregate_historical_jams.py \
        --src "C:/Users/Hans/.gemini/antigravity/scratch/cleaned/waze-cleaned/jams/nlex_jams_cleaned.csv" \
        --out _work/waze_jam_hourly_exit.csv
Then load it with load_historical_jams.py.
"""
import argparse
import csv
import math
import os
import re
import sys
import time
from collections import defaultdict

import psycopg2

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENV = os.path.join(ROOT, "Back-End", ".env")

# The live system's "this street is the NLEX mainline" test, from
# Back-End/src/utils/nlex-street.ts, so history and live mean the same thing.
EXCLUDED = ("service", "crossing", "exit rd", "halili", "dulalia", "tullahan",
            "libtong", "slex", "skyway", "sctex", "tplex", "cavitex")


def on_corridor(street: str) -> bool:
    s = (street or "").lower()
    if "nlex" not in s and "north luzon" not in s:
        return False
    return not any(word in s for word in EXCLUDED)


def pg_dsn() -> str:
    env = {}
    with open(ENV, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$", line)
            if m:
                env[m.group(1)] = m.group(2).strip().strip("\"'")
    if env.get("POSTGRES_URL"):
        return env["POSTGRES_URL"]
    return (f"host={env['PG_HOST']} port={env['PG_PORT']} dbname={env['PG_DATABASE']} "
            f"user={env['PG_USER']} password={env['PG_PASSWORD']} sslmode=require")


def load_exits():
    """The CURRENT exits, straight from the warehouse — never a copy in code."""
    conn = psycopg2.connect(pg_dsn())
    cur = conn.cursor()
    cur.execute("SELECT id, exit_name, latitude::float, longitude::float FROM bronze.nlex_exits ORDER BY id")
    rows = cur.fetchall()
    conn.close()
    if not rows:
        sys.exit("bronze.nlex_exits is empty — cannot match without it.")
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="nlex_jams_cleaned.csv")
    ap.add_argument("--out", required=True, help="where to write the hourly CSV")
    ap.add_argument("--near-m", type=float, default=250.0,
                    help="at-exit band, metres; matches the live ETL's ON/NEAR_CORRIDOR spread")
    ap.add_argument("--limit", type=int, default=0, help="stop after N rows (for a quick trial run)")
    args = ap.parse_args()

    exits = load_exits()
    print(f"matching against {len(exits)} exits from bronze.nlex_exits")
    # Equirectangular metres around the corridor: 20 candidates per row, so the
    # cost of a real haversine here is not worth paying.
    lat0 = sum(e[2] for e in exits) / len(exits)
    kx = 111_320 * math.cos(math.radians(lat0))
    ky = 110_574
    ex_xy = [(e[0], e[2] * ky, e[3] * kx) for e in exits]
    near_m = args.near_m

    # (day, hour, exit_id, on_corridor, at_exit) -> accumulators
    agg = defaultdict(lambda: [0, 0.0, 0.0, 0.0, 0.0, 0, 0.0, 0, 0.0, 0])
    #                          0:snaps 1:sp*len 2:len 3:sp 4:lvl 5:lvlmax 6:delay 7:delaymax 8:dist 9:(unused)
    seen = set()   # (bucket hash, uuid hash) — de-duplicates jams across chunks
    distinct = defaultdict(int)

    csv.field_size_limit(1 << 30)
    t0 = time.time()
    n = skipped_far = skipped_bad = 0

    with open(args.src, newline="", encoding="utf-8", errors="replace") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            n += 1
            if args.limit and n > args.limit:
                break
            try:
                ts = row["ts"]                      # "2026-04-03 09:08:31 UTC"
                y, mo, d = int(ts[0:4]), int(ts[5:7]), int(ts[8:10])
                hh = int(ts[11:13])
                lat = float(row["match_lat"]); lon = float(row["match_lon"])
            except (TypeError, ValueError, KeyError):
                skipped_bad += 1
                continue

            # UTC -> Manila (+8). Postgres does the same when it stores a
            # timestamptz, but these are naive strings, so it is done here.
            hh += 8
            if hh >= 24:
                hh -= 24
                # date arithmetic without building a date object per row
                d += 1
                dim = (31, 29 if (y % 4 == 0 and (y % 100 or y % 400 == 0)) else 28,
                       31, 30, 31, 30, 31, 31, 30, 31, 30, 31)[mo - 1]
                if d > dim:
                    d = 1
                    mo += 1
                    if mo > 12:
                        mo = 1
                        y += 1

            py, px = lat * ky, lon * kx
            best_id, best_d2 = None, None
            for eid, ey, ex in ex_xy:
                dy = py - ey; dx = px - ex
                d2 = dy * dy + dx * dx
                if best_d2 is None or d2 < best_d2:
                    best_id, best_d2 = eid, d2
            dist_m = math.sqrt(best_d2)
            # The live ETL keeps distant jams and labels them (NAMED_ONLY runs
            # to 48 km), so nothing is dropped here either — the band is part of
            # the key and the consumer decides.
            at_exit = dist_m <= near_m
            oc = on_corridor(row.get("street"))
            key = (f"{y:04d}-{mo:02d}-{d:02d}", hh, best_id, oc, at_exit)
            a = agg[key]

            def num(v, default=0.0):
                try:
                    return float(v)
                except (TypeError, ValueError):
                    return default

            spd = num(row.get("speedKMH"))
            ln = max(1.0, num(row.get("length"), 1.0))
            lvl = num(row.get("level"))
            dly = num(row.get("delay"))

            a[0] += 1
            a[1] += spd * ln
            a[2] += ln
            a[3] += spd
            a[4] += lvl
            a[5] = max(a[5], int(lvl))
            a[6] += dly
            a[7] = max(a[7], int(dly))
            a[8] += dist_m
            a[9] = max(a[9], int(ln))

            uu = row.get("uuid") or row.get("id") or ""
            h = (hash(key) & ((1 << 40) - 1)) << 24 ^ (hash(uu) & ((1 << 24) - 1))
            if h not in seen:
                seen.add(h)
                distinct[key] += 1

            if n % 5_000_000 == 0:
                # No fh.tell() here: Python forbids it while the file is being
                # iterated, and that killed a 38 GB run at the first progress
                # line. Rows are the honest measure of progress anyway.
                print(f"  {n:,} rows | {time.time()-t0:5.0f}s | "
                      f"{len(agg):,} cells | {len(seen):,} distinct", flush=True)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["date_day", "hour_of_day", "nlex_exit_id", "on_corridor", "at_exit",
                    "jam_snapshots", "jams_distinct", "speed_kmh_wavg", "speed_kmh_avg",
                    "jam_level_avg", "jam_level_max", "delay_s_avg", "delay_s_max",
                    "length_m_avg", "length_m_max", "distance_m_avg"])
        for (day, hour, eid, oc, ax), a in sorted(agg.items()):
            snaps = a[0]
            w.writerow([day, hour, eid, "true" if oc else "false", "true" if ax else "false",
                        snaps, distinct[(day, hour, eid, oc, ax)],
                        round(a[1] / a[2], 2) if a[2] else "", round(a[3] / snaps, 2),
                        round(a[4] / snaps, 2), a[5],
                        round(a[6] / snaps, 1), a[7],
                        round(a[2] / snaps, 1), a[9],
                        round(a[8] / snaps, 1)])

    days = {k[0] for k in agg}
    print(f"\nread {n:,} rows in {time.time()-t0:.0f}s")
    print(f"  skipped: {skipped_bad:,} unparsable (none dropped for distance)")
    print(f"  wrote {len(agg):,} exit-hours covering {len(days)} days: {min(days)} -> {max(days)}")
    print(f"  distinct jams: {len(seen):,}")
    print(f"  output: {args.out} ({os.path.getsize(args.out)/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
