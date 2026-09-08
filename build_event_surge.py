"""
Event surge, measured from the corridor's own history.

WHAT THIS REPLACES
  gold.ml_event_surge_forecast held three hand-entered rows:

      Bocaue Exit    62,300 -> 115,878   (1.86x)
      Marilao Exit   45,000 ->  52,100   (1.16x)
      Balagtas Exit  38,000 ->  41,500   (1.09x)

  Round numbers, no date, no provenance, and no row anywhere in
  gold.ml_model_metrics scoring an event-surge model. Nothing was trained and
  nothing was tested; the dashboard's "Prophet" badge was a hardcoded string.
  The panel then multiplied those invented ratios onto REAL observed baselines,
  which is what made the output look measured.

WHAT THIS DOES INSTEAD
  No event calendar was supplied, so event days are IDENTIFIED FROM THE DATA:
  the Philippine Arena is served by the CDV/PH Arena exit, so an event shows up
  as that exit running far above its own normal level for that weekday and
  month. Days above a threshold are taken as event days.

  Then, for every exit, the uplift on those days is measured against the same
  weekday-and-month median computed from NON-event days only. That gives an
  observed multiplier per exit, with a sample size and a spread.

HONEST LIMITS, carried into the table so the panel can show them
  - Event days are INFERRED, not supplied. A large non-event disruption on the
    corridor could be mislabelled as an event.
  - The uplift is a historical average of what happened, not a forecast of what
    a future event will do. It is a scenario input.
  - It cannot be split by event type or attendance; those are not in the data.
"""
import numpy as np
import pandas as pd
import psycopg2

PG = ("host=smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com port=5432 "
      "dbname=nlex_capstone user=postgres password=Hanszy123! sslmode=require")
ANCHOR = "CDV"          # exit serving the Philippine Arena
THRESHOLD = 1.45        # ratio to its own weekday/month norm that marks an event day
MIN_EVENTS = 5


def banner(t):
    print("\n" + "=" * 72 + f"\n  {t}\n" + "=" * 72)


conn = psycopg2.connect(PG)
banner("STEP 1: Daily volume per exit")
d = pd.read_sql_query("""
    SELECT date, exit_canonical AS ex, SUM(total)::float AS v
    FROM gold.fact_traffic_hourly GROUP BY 1, 2 ORDER BY 1""", conn)
d["date"] = pd.to_datetime(d.date)
d["dow"] = d.date.dt.dayofweek
d["m"] = d.date.dt.month
print(f"  {len(d):,} exit-days | {d.date.min().date()} -> {d.date.max().date()} | {d.ex.nunique()} exits")

banner("STEP 2: Identify event days from the anchor exit")
anchor_name = sorted(x for x in d.ex.unique() if ANCHOR.lower() in x.lower())[0]
a = d[d.ex == anchor_name].copy()
norm0 = a.groupby(["dow", "m"]).v.median().rename("exp")
a = a.merge(norm0, on=["dow", "m"])
a["ratio"] = a.v / a["exp"]
event_days = sorted(a.loc[a.ratio >= THRESHOLD, "date"])
print(f"  anchor exit: {anchor_name}")
print(f"  threshold: {THRESHOLD}x its own weekday+month norm")
print(f"  -> {len(event_days)} event days identified")
if len(event_days) < MIN_EVENTS:
    raise SystemExit(f"only {len(event_days)} event days - too few to measure an uplift honestly")
for t in event_days[:12]:
    r = float(a.loc[a.date == t, "ratio"].iloc[0])
    print(f"     {t.date()} ({t.strftime('%a')})  {r:.2f}x")
if len(event_days) > 12:
    print(f"     ... and {len(event_days) - 12} more")

banner("STEP 3: Uplift per exit, event days vs matched normal days")
ev = set(event_days)
# The norm must exclude event days, otherwise the events inflate their own
# baseline and the measured uplift is understated.
normal = d[~d.date.isin(ev)]
norm = normal.groupby(["ex", "dow", "m"]).v.median().rename("exp").reset_index()
E = d[d.date.isin(ev)].merge(norm, on=["ex", "dow", "m"], how="left").dropna(subset=["exp"])
E["ratio"] = E.v / E["exp"]
E["extra"] = E.v - E["exp"]

g = E.groupby("ex").agg(n=("ratio", "size"), uplift=("ratio", "median"),
                        lo=("ratio", lambda s: s.quantile(0.25)),
                        hi=("ratio", lambda s: s.quantile(0.75)),
                        extra=("extra", "median")).reset_index()
# Only keep exits where the rise is consistent, not a one-off: the lower
# quartile must still be above normal.
g["material"] = (g.lo > 1.02) & (g.n >= MIN_EVENTS)
g = g.sort_values("extra", ascending=False)

print(f"  {'exit':<26}{'n':>4}{'uplift':>9}{'IQR':>16}{'extra veh/day':>15}   material")
for r in g.itertuples():
    print(f"  {r.ex:<26}{r.n:>4}{r.uplift:>8.2f}x   {r.lo:>5.2f}-{r.hi:<5.2f}{r.extra:>15,.0f}"
          f"   {'YES' if r.material else 'no'}")

tot = g.loc[g.material, "extra"].sum()
print(f"\n  corridor-wide extra on an event day: {tot:,.0f} vehicles across "
      f"{int(g.material.sum())} exits")
print("  share of the surge:")
for r in g[g.material].itertuples():
    print(f"    {r.ex:<26}{r.extra / tot * 100:>5.1f}%")

banner("STEP 4: Replacing the hand-entered table")
cur = conn.cursor()
cur.execute("DROP TABLE IF EXISTS gold.ml_event_surge_forecast")
cur.execute("""
  CREATE TABLE gold.ml_event_surge_forecast (
    id serial PRIMARY KEY,
    exit_name text NOT NULL,
    event_name text NOT NULL,
    baseline_volume int, surge_volume int,
    uplift numeric(8,4), uplift_lo numeric(8,4), uplift_hi numeric(8,4),
    extra_vehicles int, n_events int, material boolean,
    method text, anchor_exit text, threshold numeric(6,3),
    first_event date, last_event date, updated_at timestamptz DEFAULT now())""")
cur.execute("""COMMENT ON TABLE gold.ml_event_surge_forecast IS
  'OBSERVED event-day uplift per exit, measured from history — not a trained forecast and not hand-entered. Event days are INFERRED as days when the Philippine Arena exit ran far above its own weekday/month norm (no event calendar was supplied). Baselines exclude event days so events cannot inflate their own baseline. Replaces three hand-typed rows that no model produced and that nothing in gold.ml_model_metrics ever scored.'""")

label = "Philippine Arena event"   # sample size travels in n_events, not the name
for r in g.itertuples():
    cur.execute("""INSERT INTO gold.ml_event_surge_forecast
        (exit_name, event_name, baseline_volume, surge_volume, uplift, uplift_lo, uplift_hi,
         extra_vehicles, n_events, material, method, anchor_exit, threshold, first_event, last_event)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (r.ex, label,
         int(round(E[E.ex == r.ex]["exp"].median())),
         int(round(E[E.ex == r.ex].v.median())),
         float(r.uplift), float(r.lo), float(r.hi), int(round(r.extra)), int(r.n),
         bool(r.material), "observed event-day median vs non-event weekday/month median",
         anchor_name, THRESHOLD, min(event_days).date(), max(event_days).date()))
conn.commit()
cur.execute("SELECT COUNT(*), COUNT(*) FILTER (WHERE material) FROM gold.ml_event_surge_forecast")
n, mat = cur.fetchone()
print(f"  wrote {n} exits ({mat} material) — every value measured, none entered by hand")
conn.close()
banner("DONE")
