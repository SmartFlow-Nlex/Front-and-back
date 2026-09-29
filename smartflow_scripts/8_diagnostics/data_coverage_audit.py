"""What data the warehouse actually holds, and where the holes are.

Read-only. Answers, from the live database, the three questions that keep
coming up:

  1. HOW MUCH of each source is loaded, and what period does it cover?
  2. HOW STALE is each feed right now?
  3. WHICH DAYS have no data, and is that hole covered by another source?

Written after a September 2026 review found the Waze tables starting only on
4 Aug 2026. The cause was not the laptop being switched off: the live Waze
collector runs on an AWS EC2 instance (it connects as `waze_etl`) every two
minutes, and it kept full 24-hour coverage through a week when this laptop was
asleep. The real hole is 19 Apr - 3 Aug 2026, between the end of the one-off
Waze Partner Hub export and the day that collector started. The local 43.7 GB
export cannot fill it: its own alert rows stop in April 2026, and its monthly
counts already match what is loaded.

RUN (from the repo root, needs Back-End/.env):
    python smartflow_scripts/8_diagnostics/data_coverage_audit.py
    python smartflow_scripts/8_diagnostics/data_coverage_audit.py --from 2026-04-01 --to 2026-08-10
"""
import argparse
import datetime as dt
import os
import re
import sys

import psycopg2

# ── connection, from Back-End/.env (never hard-coded) ────────────────────────
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENV = os.path.join(ROOT, "Back-End", ".env")


def pg_dsn() -> str:
    if not os.path.exists(ENV):
        sys.exit(f"Back-End/.env not found at {ENV}")
    env = {}
    with open(ENV, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$", line)
            if m:
                env[m.group(1)] = m.group(2).strip().strip("\"'")
    if env.get("POSTGRES_URL"):
        return env["POSTGRES_URL"]
    need = ("PG_HOST", "PG_PORT", "PG_DATABASE", "PG_USER", "PG_PASSWORD")
    if not all(env.get(k) for k in need):
        sys.exit("Back-End/.env has neither POSTGRES_URL nor the full set of PG_* values.")
    return (f"host={env['PG_HOST']} port={env['PG_PORT']} dbname={env['PG_DATABASE']} "
            f"user={env['PG_USER']} password={env['PG_PASSWORD']} sslmode=require")


# (label, table, date column). Grouped by what the row actually is.
SOURCES = [
    ("Waze live jams (raw feed)",     "bronze.waze_raw_jams",               "ingested_at"),
    ("Waze live alerts (raw feed)",   "bronze.waze_raw_alerts",             "ingested_at"),
    ("Waze jams, per jam",            "silver.fact_waze_jams",              "date_day"),
    ("Waze alerts, per incident",     "silver.fact_incident_log",           "date_day"),
    ("Waze alerts, hourly",           "bronze.waze_hourly_alerts",          "date_day"),
    ("Waze jams, hourly",             "bronze.waze_hourly_jams",            "date_day"),
    ("Waze irregularities, hourly",   "bronze.waze_hourly_irregularities",  "date_day"),
    ("NLEX incidents (official CSV)", "bronze.nlex_incidents",              "incident_date"),
    ("NLEX accidents, cleaned",       "silver.nlex_accident_events_clean",  "event_start_date"),
    ("NLEX breakdowns, cleaned",      "silver.nlex_breakdown_events_clean", "event_encoded_date"),
    ("Stalled vehicles",              "public.nlex_stalled_vehicles",       "reported_time"),
    ("Toll traffic, hourly (gold)",   "gold.fact_traffic_hourly",           "date"),
    ("Emissions, hourly (gold)",      "gold.fact_emissions_hourly",         "date"),
    ("Weather, hourly",               "public.hourly_weather",              "timestamp_utc"),
]

# Sources that can answer "was there an incident on this day?", for the
# cross-source blind-spot test.
INCIDENT_SOURCES = [
    ("waze_hourly",  "bronze.waze_hourly_alerts",          "date_day"),
    ("waze_live",    "silver.fact_incident_log",           "date_day"),
    ("official",     "bronze.nlex_incidents",              "incident_date"),
    ("breakdowns",   "silver.nlex_breakdown_events_clean", "event_encoded_date"),
    ("stalled",      "public.nlex_stalled_vehicles",       "reported_time"),
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="d_from", default="2026-04-01", help="blind-spot window start (YYYY-MM-DD)")
    ap.add_argument("--to", dest="d_to", default=None, help="blind-spot window end; default today")
    args = ap.parse_args()
    d_to = args.d_to or dt.date.today().isoformat()

    conn = psycopg2.connect(pg_dsn())
    conn.set_session(readonly=True, autocommit=True)
    cur = conn.cursor()
    cur.execute("SET statement_timeout = 180000")

    print(f"SmartFlow data coverage — {dt.datetime.now():%Y-%m-%d %H:%M}\n")
    print(f"{'source':<32}{'rows':>12}  {'from':<12}{'to':<12}{'age':>10}")
    print("-" * 80)
    for label, table, col in SOURCES:
        try:
            # reltuples first: a COUNT(*) on the multi-GB raw feeds is not worth
            # the wait, and an estimate is enough to say "is this loaded".
            cur.execute("SELECT pg_total_relation_size(%s), (SELECT reltuples::bigint FROM pg_class WHERE oid = %s::regclass)",
                        (table, table))
            size, est = cur.fetchone()
            if size > 400 * 1024 ** 2:
                rows, approx = est, "~"
            else:
                cur.execute(f"SELECT COUNT(*) FROM {table}")
                rows, approx = cur.fetchone()[0], ""
            cur.execute(f"SELECT MIN({col})::date, MAX({col})::date, "
                        f"EXTRACT(EPOCH FROM (now() - MAX({col})))/86400 FROM {table}")
            lo, hi, age_days = cur.fetchone()
            # A date column stamps midnight, so "today" reads as negative
            # against a UTC clock that is still on yesterday's date in Manila.
            age_days = max(0.0, float(age_days)) if age_days is not None else None
            age = "—" if age_days is None else (f"{age_days * 24:.1f} h" if age_days < 2 else f"{age_days:.0f} d")
            print(f"{label:<32}{approx}{rows:>11,}  {str(lo):<12}{str(hi):<12}{age:>10}")
        except Exception as exc:  # a missing table must not kill the report
            print(f"{label:<32}{'—':>12}  {str(exc).strip()[:40]}")

    # ── cross-source blind spots ─────────────────────────────────────────────
    print(f"\nIncident coverage, {args.d_from} to {d_to}")
    print("-" * 80)
    parts = ", ".join(
        f"(SELECT COUNT(*) FROM {t} x WHERE x.{c}::date = d.dd)::int AS {name}"
        for name, t, c in INCIDENT_SOURCES
    )
    cur.execute(
        f"WITH d AS (SELECT generate_series(%s::date, %s::date, '1 day')::date AS dd) "
        f"SELECT d.dd, {parts} FROM d ORDER BY d.dd", (args.d_from, d_to))
    rows = cur.fetchall()
    names = [n for n, _, _ in INCIDENT_SOURCES]

    def runs(pred):
        """Contiguous day ranges where pred(row) holds."""
        out, start, prev = [], None, None
        for r in rows:
            if pred(r):
                if start is None:
                    start = r[0]
                prev = r[0]
            elif start is not None:
                out.append((start, prev)); start = None
        if start is not None:
            out.append((start, prev))
        return out

    blind = runs(lambda r: not any(r[1:]))
    waze_only = runs(lambda r: not (r[1] or r[2]) and any(r[3:]))

    for name, idx in zip(names, range(1, len(names) + 1)):
        days = [r[0] for r in rows if r[idx]]
        span = f"{days[0]} .. {days[-1]}" if days else "no data in window"
        print(f"  {name:<14}{len(days):>5} days   {span}")

    print("\n  Waze missing, but official records present:")
    for a, b in waze_only or []:
        print(f"    {a} .. {b}  ({(b - a).days + 1} days)")
    if not waze_only:
        print("    none")

    print("\n  NO data from ANY source (a true blind spot):")
    for a, b in blind or []:
        print(f"    {a} .. {b}  ({(b - a).days + 1} days)")
    if not blind:
        print("    none")

    print("\nA Waze hole can only be refilled from a new Waze Partner Hub export;")
    print("the local export's own rows stop in April 2026 and are already loaded.")
    conn.close()


if __name__ == "__main__":
    main()
