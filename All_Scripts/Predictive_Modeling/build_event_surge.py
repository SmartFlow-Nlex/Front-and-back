"""
Event surge per exit — measured against the real Philippine Arena calendar.

WHY THIS REPLACES THE 2026-09 VERSION
  The previous build_event_surge.py identified event days FROM TRAFFIC, because
  when it was written no event calendar was available:

      event_days = days where the CDV/PH Arena exit ran >= 1.45x its own
                   weekday+month median

  It then measured the uplift at that same exit on those same days. That is
  circular: a day qualifies BECAUSE the anchor was busy, so the anchor's uplift
  cannot come out near 1.0 no matter what the arena did. It reported 1.59x.

  Measured against the arena's actual calendar the same exit rises 1.15x. The
  old figure was roughly four times the real effect, and the 48 "event days" it
  reported were never checked against the calendar at all — any holiday, long
  weekend or diversion that pushed CDV above the threshold became a
  "Philippine Arena event day". The dashboard then labelled them as such.

  The calendar now exists — silver.philippine_arena_events_clean, which the
  backend already uses to forecast UPCOMING events. So the pipeline was
  internally inconsistent: upcoming forecasts used real event dates, multiplied
  by an uplift measured on inferred ones.

WHAT THIS DOES INSTEAD
  Event days come from the calendar. Nothing selects a day by how busy it was,
  so the measured uplift is free to be small - and at most exits it is.

  For each exit the baseline is the median of NON-event days matched on weekday
  and month, so a Saturday concert in November is compared against November
  Saturdays. Event days are excluded from that baseline, or events would
  inflate the very normal they are measured against.

  Uplift is the median ratio over event days, with a bootstrap 95% confidence
  interval. An exit counts as materially affected only when the lower bound of
  that interval clears 1.0 — that is, when we can say the rise is real rather
  than noise. With the honest (small) effect sizes this matters: a quartile
  heuristic would wave through exits whose "uplift" is sampling noise.

HOW IT IS TESTED
  Event days are split CHRONOLOGICALLY: the earlier ones fit the uplift, the
  later ones are held out. Baselines for the test window are built only from
  non-event days BEFORE the cut, so neither the norm nor the multiplier has
  seen a test day. Candidates are scored by WMAPE on held-out exit-days against
  two baselines a person could use without any model: predict the normal day
  and ignore the event, or apply one corridor-wide multiplier.

  The run also writes a REPLAY - every held-out event day, predicted corridor
  volume next to what actually arrived - so the card can show the comparison
  rather than only assert an error rate.

HOLIDAYS ARE A SEPARATE REGIME
  A concert on New Year's Eve is not a normal Tuesday with a concert on it. The
  first version of this compared 31 Dec 2024 against the median December
  Tuesday and "predicted" 364k vehicles against an actual 210k - the miss was
  the holiday, not the event. Traffic on a Philippine holiday runs far below an
  ordinary day of the same weekday and month, and 16 of the calendar's event
  days fall on one.

  So the two effects are separated. The normal-day median is built from days
  that are neither events NOR holidays. Each exit then gets a holiday factor -
  how much that exit runs relative to its own normal on a non-event holiday -
  and a day's expected volume is the normal median times that factor when the
  day is a holiday. Uplift is measured against that expectation, so it answers
  "what did the event add?" rather than "what did the event and the calendar
  add together?".

LIMITS, carried into the table so the panel can show them
  - Attendance is not in the calendar, so a sold-out concert and a small
    exhibition carry the same prediction. This is the largest single source of
    remaining error.
  - The uplift is an average of what past events did. It is a planning input,
    not a promise about one future night.
  - Exits far from the arena show no reliable effect; they are reported as
    not material rather than given a decorative multiplier.
"""
import json
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
from sklearn.ensemble import GradientBoostingRegressor

warnings.filterwarnings("ignore")

# --dry-run: compute, score and print everything, write nothing.
DRY_RUN = "--dry-run" in sys.argv

# Credentials come from Back-End/.env, never from this file: the version of
# this script in commit 54087f4 carried the production password in plain text.
_env = {}
for _line in (Path(__file__).resolve().parents[2] / "Back-End" / ".env").read_text().splitlines():
    if "=" in _line and not _line.startswith("#"):
        _k, _v = _line.split("=", 1)
        _env[_k.strip()] = _v.strip().strip('"')
PG = (f"host={_env['PG_HOST']} port={_env.get('PG_PORT', 5432)} dbname={_env['PG_DATABASE']} "
      f"user={_env['PG_USER']} password={_env['PG_PASSWORD']} sslmode=require")

ANCHOR_HINT = "CDV"        # the exit serving the Philippine Arena
TEST_FRACTION = 0.30       # share of event days held out, chronologically
MIN_EVENTS = 8             # an exit needs this many clean event days to be judged
BOOTSTRAP = 2000
RNG = np.random.default_rng(42)


def banner(t):
    print("\n" + "=" * 72 + f"\n  {t}\n" + "=" * 72)


def wmape(pred, actual):
    """Weighted MAPE: total absolute error as a share of total actual volume.
    Weighted, so a big exit's miss counts for more than a small one's."""
    denom = np.sum(np.abs(actual))
    return float(np.sum(np.abs(pred - actual)) / denom * 100) if denom else float("nan")


conn = psycopg2.connect(PG)

# ── 1. Data ─────────────────────────────────────────────────────────────────
banner("STEP 1: Daily volume per exit, and the event calendar")
d = pd.read_sql_query("""
    SELECT date, exit_canonical AS ex, SUM(total)::float AS v
    FROM gold.fact_traffic_hourly GROUP BY 1, 2 ORDER BY 1""", conn)
d["date"] = pd.to_datetime(d.date)
d["dow"] = d.date.dt.dayofweek
d["m"] = d.date.dt.month
print(f"  {len(d):,} exit-days | {d.date.min().date()} -> {d.date.max().date()} | {d.ex.nunique()} exits")

cal = pd.read_sql_query("""
    SELECT DISTINCT event_date::date AS d FROM silver.philippine_arena_events_clean
    WHERE event_date IS NOT NULL ORDER BY 1""", conn)
cal["d"] = pd.to_datetime(cal.d)
all_events = sorted(cal.d)
events = [t for t in all_events if d.date.min() <= t <= d.date.max()]
hol = pd.read_sql_query("SELECT DISTINCT date_day::date AS d FROM public.ph_holidays", conn)
hol["d"] = pd.to_datetime(hol.d)
HOLIDAYS = set(hol.d)
d["is_hol"] = d.date.isin(HOLIDAYS)
anchor_name = sorted(x for x in d.ex.unique() if ANCHOR_HINT.lower() in x.lower())[0]
print(f"  calendar: {len(all_events)} event days total, {len(events)} inside the volume range")
print(f"  event days come from silver.philippine_arena_events_clean — nothing is inferred from traffic")
print(f"  anchor exit (serves the arena): {anchor_name}")
print(f"  holidays: {len(HOLIDAYS)} dates from public.ph_holidays; "
      f"{len([t for t in events if t in HOLIDAYS])} event days fall on one")
if len(events) < MIN_EVENTS * 2:
    raise SystemExit(f"only {len(events)} usable event days — too few to fit and test honestly")

# ── 2. Chronological split ──────────────────────────────────────────────────
banner("STEP 2: Splitting the event days in time")
n_test = max(MIN_EVENTS, int(round(len(events) * TEST_FRACTION)))
train_ev, test_ev = set(events[:-n_test]), set(events[-n_test:])
cut = min(test_ev)
print(f"  fit  {len(train_ev)} events  {min(train_ev).date()} -> {max(train_ev).date()}")
print(f"  test {len(test_ev)} events  {cut.date()} -> {max(test_ev).date()}  (never seen while fitting)")

ALL_EV = set(events)


def build_expectation(pool, label):
    """A normal-day median per (exit, weekday, month) from days that are
    neither events nor holidays, plus a per-exit holiday factor measured on
    non-event holidays. Returns a function mapping a frame to its expected
    volume. Keeping the two separate stops a holiday from being charged to the
    event, and keeps the normal-day sample large."""
    ordinary = pool[~pool.is_hol]
    nrm = ordinary.groupby(["ex", "dow", "m"]).v.median().rename("exp0").reset_index()
    # Holiday factor: on a non-event holiday, how does the exit compare with
    # its own ordinary median for that weekday and month?
    hol_days = pool[pool.is_hol].merge(nrm, on=["ex", "dow", "m"], how="left").dropna(subset=["exp0"])
    hf = (hol_days.assign(r=lambda f: f.v / f.exp0).groupby("ex").r.median()
          if len(hol_days) else pd.Series(dtype=float))
    overall_hf = float(hf.median()) if len(hf) else 1.0
    print(f"  {label}: {len(ordinary):,} ordinary exit-days -> normal medians; "
          f"{len(hol_days):,} holiday exit-days -> factor "
          f"{overall_hf:.2f}x (median across exits)")

    def apply(frame):
        out = frame.merge(nrm, on=["ex", "dow", "m"], how="left").dropna(subset=["exp0"])
        factor = np.where(out.is_hol.values, out.ex.map(hf).fillna(overall_hf).values, 1.0)
        out["exp"] = out.exp0.values * factor
        return out.drop(columns=["exp0"])

    return apply, hf, overall_hf


# Fitted only on days before the cut, so no test-window information reaches
# either the normal median or the holiday factor.
expect_pre, hf_pre, hf0_pre = build_expectation(
    d[(d.date < cut) & (~d.date.isin(ALL_EV))], "pre-cut baseline")

TR = expect_pre(d[d.date.isin(train_ev)])
TE = expect_pre(d[d.date.isin(test_ev)])
TR["ratio"] = TR.v / TR["exp"]
TE["ratio"] = TE.v / TE["exp"]
print(f"  {len(TR):,} exit-days to fit | {len(TE):,} exit-days to score")

# ── 3. Candidate models ─────────────────────────────────────────────────────
banner("STEP 3: Candidates, scored on held-out event days")
flat_uplift = float(TR.ratio.median())
per_exit = TR.groupby("ex").ratio.median()
n_by_exit = TR.groupby("ex").ratio.size()

# Shrinkage: an exit with 6 clean event days should not be trusted as far as
# one with 70. Each exit's multiplier is pulled toward the corridor-wide one in
# proportion to how little evidence it has (James-Stein in spirit; k is the
# number of events at which own-evidence and corridor evidence weigh equally).
K_SHRINK = 12.0
shrunk = {ex: (n_by_exit[ex] * per_exit[ex] + K_SHRINK * flat_uplift) / (n_by_exit[ex] + K_SHRINK)
          for ex in per_exit.index}

preds = {
    "No event adjustment (baseline)": TE["exp"].values,
    "Flat uplift (baseline)": TE["exp"].values * flat_uplift,
    "Per-exit uplift": TE["exp"].values * TE.ex.map(per_exit).fillna(flat_uplift).values,
    "Per-exit uplift, shrunk": TE["exp"].values * TE.ex.map(shrunk).fillna(flat_uplift).values,
}

# A learned comparator, given the same information the multipliers get plus the
# calendar features. Fitted on every day before the cut so it can learn what an
# ordinary day looks like as well as an event one.
fit_src = expect_pre(d[d.date < cut])
ex_codes = {e: i for i, e in enumerate(sorted(d.ex.unique()))}


def feats(frame):
    return np.column_stack([
        frame.ex.map(ex_codes).fillna(-1).values,
        frame.dow.values, frame.m.values, frame["exp"].values,
        frame.date.isin(ALL_EV).astype(float).values,
        frame.is_hol.astype(float).values,
    ])


gb = GradientBoostingRegressor(n_estimators=300, max_depth=3, learning_rate=0.05, random_state=42)
gb.fit(feats(fit_src), fit_src.v.values)
preds["Gradient Boosting"] = gb.predict(feats(TE))
print(f"  Gradient Boosting fitted on {len(fit_src):,} exit-days before {cut.date()}")

actual = TE.v.values
rows = [{"model": k, "wmape": wmape(p, actual),
         "mae": float(np.mean(np.abs(p - actual))),
         "mape": float(np.mean(np.abs(p - actual) / np.where(actual == 0, np.nan, actual)) * 100)}
        for k, p in preds.items()]
res = pd.DataFrame(rows).sort_values("wmape").reset_index(drop=True)
no_adj = float(res.loc[res.model == "No event adjustment (baseline)", "wmape"].iloc[0])
res["accepted"] = (res.wmape < no_adj) & (~res.model.str.contains("baseline"))
res["rank"] = np.where(res.accepted, res.index + 1, None)

print(f"  {'model':<34}{'WMAPE':>9}{'MAE':>11}   verdict")
for r in res.itertuples():
    print(f"  {r.model:<34}{r.wmape:>8.3f}%{r.mae:>11,.0f}   "
          f"{'ACCEPTED' if r.accepted else ('baseline' if 'baseline' in r.model else 'rejected')}")
champ = res[res.accepted].iloc[0] if res.accepted.any() else res.iloc[0]
print(f"\n  champion: {champ.model} at {champ.wmape:.3f}% "
      f"vs {no_adj:.3f}% for ignoring the event entirely")

# ── 4. Uplift per exit, with an honest interval ─────────────────────────────
banner("STEP 4: Uplift per exit, over every calendar event day")
expect_all, hf_all, hf0_all = build_expectation(d[~d.date.isin(ALL_EV)], "full-history baseline")
E = expect_all(d[d.date.isin(ALL_EV)])
E["ratio"] = E.v / E["exp"]
E["extra"] = E.v - E["exp"]


def boot_ci(x):
    """Bootstrap 95% interval for the median ratio. With effects this small the
    question 'is this rise real?' has to be answered by an interval, not by a
    quartile that happens to sit above 1."""
    if len(x) < 3:
        return float("nan"), float("nan")
    draws = RNG.choice(x, size=(BOOTSTRAP, len(x)), replace=True)
    meds = np.median(draws, axis=1)
    return float(np.percentile(meds, 2.5)), float(np.percentile(meds, 97.5))


g = []
for ex, grp in E.groupby("ex"):
    lo, hi = boot_ci(grp.ratio.values)
    g.append({"ex": ex, "n": len(grp), "uplift": float(grp.ratio.median()),
              "lo": lo, "hi": hi, "extra": float(grp.extra.median()),
              "baseline": float(grp["exp"].median()), "surge": float(grp.v.median())})
g = pd.DataFrame(g)
# Material only when the whole 95% interval sits above a normal day AND there
# is enough evidence to have formed one.
g["material"] = (g.lo > 1.0) & (g.n >= MIN_EVENTS)
g = g.sort_values("extra", ascending=False)

print(f"  {'exit':<26}{'n':>5}{'uplift':>9}{'95% CI':>18}{'extra veh/day':>15}   material")
for r in g.itertuples():
    ci = f"{r.lo:.2f}-{r.hi:.2f}" if np.isfinite(r.lo) else "--"
    print(f"  {r.ex:<26}{r.n:>5}{r.uplift:>8.2f}x{ci:>18}{r.extra:>15,.0f}   {'YES' if r.material else 'no'}")
tot = g.loc[g.material, "extra"].sum()
print(f"\n  corridor-wide extra on an event day: {tot:,.0f} vehicles across "
      f"{int(g.material.sum())} of {len(g)} exits")

# ── 5. The replay: every held-out event day, predicted vs actual ────────────
banner("STEP 5: Replay of the held-out events")
best_pred = preds[champ.model]
rep = TE[["date", "ex"]].copy()
rep["pred"] = best_pred
rep["act"] = actual
day = (rep.groupby("date").agg(p=("pred", "sum"), a=("act", "sum"), n=("ex", "size"))
       .reset_index().sort_values("date"))
day_err = (day.p - day.a).abs() / day.a * 100
replay = {
    "model": str(champ.model),
    "events_total": len(events), "events_train": len(train_ev), "events_test": len(test_ev),
    "test_from": cut.strftime("%Y-%m-%d"),
    "exit_days_scored": int(len(TE)),
    "wmape": float(champ.wmape), "baseline_wmape": no_adj,
    "median_day_error_pct": float(day_err.median()),
    "series": [{"t": t.strftime("%Y-%m-%d"), "p": int(round(p)), "a": int(round(a)), "n": int(n)}
               for t, p, a, n in zip(day.date, day.p, day.a, day.n)],
    "anchor_exit": anchor_name,
    "anchor_uplift": float(g.loc[g.ex == anchor_name, "uplift"].iloc[0]) if (g.ex == anchor_name).any() else None,
    "material_exits": int(g.material.sum()), "total_exits": int(len(g)),
    "holiday_factor": round(hf0_all, 3),
    "holiday_event_days": len([t for t in events if t in HOLIDAYS]),
    "method": ("event days from silver.philippine_arena_events_clean; baseline is the "
               "median of days that are neither events nor holidays, matched on weekday "
               "and month, times a per-exit holiday factor when the day is a public "
               "holiday; uplift is the median ratio with a bootstrap 95% interval"),
}
print(f"  {len(day)} held-out event days | corridor total off by a median of "
      f"{replay['median_day_error_pct']:.2f}% per event day")
_best = day.loc[day_err.idxmin()]
_worst = day.loc[day_err.idxmax()]
replay["examples"] = [
    {"kind": "closest call", "t": _best.date.strftime("%Y-%m-%d"), "predicted": int(_best.p), "actual": int(_best.a)},
    {"kind": "widest miss", "t": _worst.date.strftime("%Y-%m-%d"), "predicted": int(_worst.p), "actual": int(_worst.a)},
]
for e in replay["examples"]:
    print(f"    {e['kind']}: {e['t']} — predicted {e['predicted']:,}, actually {e['actual']:,}")

# ── 6. Write ────────────────────────────────────────────────────────────────
banner("STEP 6: Writing to AWS")
if DRY_RUN:
    print("  --dry-run: nothing written. Rerun without the flag to publish.")
    conn.close()
    banner("DONE (dry run)")
    raise SystemExit(0)

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
  'OBSERVED event-day uplift per exit, measured against the real Philippine Arena calendar (silver.philippine_arena_events_clean). Baselines are non-event weekday+month medians and exclude event days. uplift_lo/uplift_hi are a bootstrap 95% interval for the median ratio; material is true only when that interval clears 1.0. Written by All_Scripts/Predictive_Modeling/build_event_surge.py. The previous version INFERRED event days as days the anchor exit ran 1.45x its own norm, which selected days by how busy they were and inflated the anchor uplift from 1.15x to 1.59x.'""")

label = "Philippine Arena event"
for r in g.itertuples():
    cur.execute("""INSERT INTO gold.ml_event_surge_forecast
        (exit_name, event_name, baseline_volume, surge_volume, uplift, uplift_lo, uplift_hi,
         extra_vehicles, n_events, material, method, anchor_exit, threshold, first_event, last_event)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (r.ex, label, int(round(r.baseline)), int(round(r.surge)),
         float(r.uplift), None if not np.isfinite(r.lo) else float(r.lo),
         None if not np.isfinite(r.hi) else float(r.hi),
         int(round(r.extra)), int(r.n), bool(r.material),
         "event-day median vs non-event non-holiday weekday/month median, holiday-adjusted, real arena calendar",
         anchor_name, None, min(events).date(), max(events).date()))

cur.execute("DELETE FROM gold.ml_model_metrics WHERE target = 'Event Surge'")
note = (f"held out {len(test_ev)} of {len(events)} calendar event days chronologically "
        f"({cut.date()} onward); {len(TE):,} exit-days scored")
for r in res.itertuples():
    cur.execute("""INSERT INTO gold.ml_model_metrics
        (model_name, target, wmape, mape, mae, rank, accepted, rejected_reason, updated_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s, now())""",
        (r.model, "Event Surge", float(r.wmape), float(r.mape), float(r.mae),
         int(r.rank) if r.rank else None, bool(r.accepted),
         None if r.accepted else note))

cur.execute("""CREATE TABLE IF NOT EXISTS gold.ml_event_surge_eval (
    id int PRIMARY KEY DEFAULT 1, payload jsonb NOT NULL, updated_at timestamptz DEFAULT now())""")
cur.execute("""INSERT INTO gold.ml_event_surge_eval (id, payload, updated_at) VALUES (1, %s, now())
               ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()""",
            (json.dumps(replay),))
conn.commit()
cur.execute("SELECT COUNT(*), COUNT(*) FILTER (WHERE material) FROM gold.ml_event_surge_forecast")
n, mat = cur.fetchone()
print(f"  wrote {n} exits ({mat} material), {len(res)} scored candidates, and the replay")
conn.close()
banner("DONE")
