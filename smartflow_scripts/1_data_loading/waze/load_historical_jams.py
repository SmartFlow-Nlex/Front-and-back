"""Load the hourly Waze jam summary into the warehouse.

Input is the CSV written by aggregate_historical_jams.py — about a million rows
summarising 77 million local ones. The 38 GB export itself is never uploaded.

COST AND LOAD. The instance is a shared capstone database on metered AWS, so
this is written to touch it as briefly as possible:
  - one COPY into an UNLOGGED staging table, which skips WAL for the bulk write;
  - one INSERT ... ON CONFLICT from staging into the real table, inside a single
    transaction, so a re-run replaces rather than duplicates;
  - one composite index, created once, matching how the models query it;
  - no triggers, no continuous job, nothing that runs on a schedule.
A full load is a couple of minutes of database time and adds roughly 150-250 MB
to an 11 GB database. Re-running is safe and idempotent.

The table is ADDITIVE: nothing existing is altered or dropped, and no model is
repointed at it. silver.fact_waze_jams (the live feed) is untouched.

RUN:
    python smartflow_scripts/1_data_loading/waze/load_historical_jams.py \
        --src _work/waze_jam_hourly_exit.csv
    python .../load_historical_jams.py --src ... --dry-run    # counts only
"""
import argparse
import os
import re
import sys

import psycopg2

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENV = os.path.join(ROOT, "Back-End", ".env")

TABLE = "silver.waze_jam_hourly_exit"

DDL = f"""
CREATE TABLE IF NOT EXISTS {TABLE} (
  date_day        date        NOT NULL,
  hour_of_day     smallint    NOT NULL,
  nlex_exit_id    integer     NOT NULL,
  -- the dashboard's own "this street is the NLEX mainline" test
  on_corridor     boolean     NOT NULL,
  -- within 250 m of the exit, the spread the live ETL calls ON/NEAR_CORRIDOR
  at_exit         boolean     NOT NULL,
  jam_snapshots   integer     NOT NULL,
  jams_distinct   integer     NOT NULL,
  speed_kmh_wavg  numeric(7,2),
  speed_kmh_avg   numeric(7,2),
  jam_level_avg   numeric(5,2),
  jam_level_max   smallint,
  delay_s_avg     numeric(9,1),
  delay_s_max     integer,
  length_m_avg    numeric(10,1),
  length_m_max    integer,
  distance_m_avg  numeric(10,1),
  PRIMARY KEY (date_day, hour_of_day, nlex_exit_id, on_corridor, at_exit)
);
COMMENT ON TABLE {TABLE} IS
  'Hourly Waze jam summary per exit, Jan 2022 - Apr 2026, aggregated locally '
  'from the 38 GB cleaned Partner Hub export. Manila-local date_day/hour_of_day, '
  'exits re-matched to bronze.nlex_exits by coordinates. jam_snapshots counts '
  '2-minute feed snapshots (exposure); jams_distinct counts unique jam uuids '
  'WITHIN that exit-hour, so a jam lasting three hours counts three times. '
  'silver.fact_waze_jams (live, 4 Aug 2026 onward) instead holds one row per '
  'jam keyed to its first hour, so the two counts are close but not identical; '
  'speed_kmh_wavg is comparable across both, being length-weighted.';
"""

COLUMNS = ("date_day", "hour_of_day", "nlex_exit_id", "on_corridor", "at_exit",
           "jam_snapshots", "jams_distinct", "speed_kmh_wavg", "speed_kmh_avg",
           "jam_level_avg", "jam_level_max", "delay_s_avg", "delay_s_max",
           "length_m_avg", "length_m_max", "distance_m_avg")


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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--dry-run", action="store_true", help="report what would load, write nothing")
    args = ap.parse_args()
    if not os.path.exists(args.src):
        sys.exit(f"not found: {args.src}")

    with open(args.src, encoding="utf-8") as fh:
        header = fh.readline().strip().split(",")
        n_rows = sum(1 for _ in fh)
    if tuple(header) != COLUMNS:
        sys.exit(f"unexpected columns:\n  got      {header}\n  expected {list(COLUMNS)}")
    print(f"{args.src}: {n_rows:,} rows, {os.path.getsize(args.src)/1e6:.1f} MB")
    if args.dry_run:
        print("dry run — nothing written")
        return

    conn = psycopg2.connect(pg_dsn())
    conn.autocommit = False
    cur = conn.cursor()
    try:
        cur.execute(DDL)
        # UNLOGGED staging: the bulk write skips WAL, so the instance does a
        # fraction of the I/O. It is dropped at the end either way.
        cur.execute(f"DROP TABLE IF EXISTS _stage_waze_jam_hourly")
        cur.execute(f"CREATE UNLOGGED TABLE _stage_waze_jam_hourly (LIKE {TABLE} INCLUDING DEFAULTS)")
        with open(args.src, encoding="utf-8") as fh:
            cur.copy_expert(
                "COPY _stage_waze_jam_hourly (" + ",".join(COLUMNS) + ") FROM STDIN WITH (FORMAT csv, HEADER true)",
                fh)
        cur.execute("SELECT COUNT(*) FROM _stage_waze_jam_hourly")
        staged = cur.fetchone()[0]

        cur.execute(f"""
            INSERT INTO {TABLE} ({','.join(COLUMNS)})
            SELECT {','.join(COLUMNS)} FROM _stage_waze_jam_hourly
            ON CONFLICT (date_day, hour_of_day, nlex_exit_id, on_corridor, at_exit)
            DO UPDATE SET
              jam_snapshots = EXCLUDED.jam_snapshots, jams_distinct = EXCLUDED.jams_distinct,
              speed_kmh_wavg = EXCLUDED.speed_kmh_wavg, speed_kmh_avg = EXCLUDED.speed_kmh_avg,
              jam_level_avg = EXCLUDED.jam_level_avg, jam_level_max = EXCLUDED.jam_level_max,
              delay_s_avg = EXCLUDED.delay_s_avg, delay_s_max = EXCLUDED.delay_s_max,
              length_m_avg = EXCLUDED.length_m_avg, length_m_max = EXCLUDED.length_m_max,
              distance_m_avg = EXCLUDED.distance_m_avg
        """)
        merged = cur.rowcount
        cur.execute("DROP TABLE _stage_waze_jam_hourly")
        # Matches how the trainers filter: a date range for one or all exits.
        cur.execute(f"CREATE INDEX IF NOT EXISTS waze_jam_hourly_exit_day_idx ON {TABLE} (date_day, nlex_exit_id)")
        conn.commit()
        print(f"staged {staged:,}, merged {merged:,}")

        cur.execute(f"""SELECT COUNT(*), MIN(date_day)::text, MAX(date_day)::text,
                               SUM(jams_distinct), SUM(jam_snapshots),
                               pg_size_pretty(pg_total_relation_size('{TABLE}'))
                          FROM {TABLE}""")
        n, lo, hi, dj, sn, size = cur.fetchone()
        print(f"{TABLE}: {n:,} rows | {lo} -> {hi} | {dj:,} distinct jams, {sn:,} snapshots | {size}")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
