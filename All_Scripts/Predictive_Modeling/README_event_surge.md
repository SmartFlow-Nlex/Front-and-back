# Event Surge Impact by Exit — rebuilding the uplift

`build_event_surge.py` measures how much extra traffic a Philippine Arena event
puts through each NLEX exit, scores that against baselines on event days it
never saw, and writes the result for the Predictive tab's *Event Surge Impact
by Exit* card.

## Run it

```
cd All_Scripts/Predictive_Modeling
python build_event_surge.py --dry-run     # compute and print, write nothing
python build_event_surge.py               # publish
```

Credentials come from `Back-End/.env`, so that file has to stay in place. The
run takes about a minute. It is not scheduled: the arena calendar and the
volume warehouse both move slowly, so re-run it when either is refreshed.

## What it fixes

The version in commit `54087f4` had no event calendar available, so it
**inferred** event days from traffic:

```python
event_days = days where the CDV/PH Arena exit ran >= 1.45x its weekday+month median
```

and then measured that same exit's uplift on those same days. A day qualified
*because* the anchor was busy, so the anchor's uplift could not come out near
1.0 whatever the arena did. It reported **1.59x**. Against the real calendar
the same exit rises **1.16x** — the old figure was about four times the true
effect.

Two further consequences:

- The 48 "Philippine Arena event days" were never checked against the calendar.
  Any holiday, long weekend or diversion that pushed one exit over the
  threshold became an "event day", and the dashboard labelled it as one.
- The numbers could not be reproduced. `build_event_surge.py` and
  `eval_event_surge.py` were deleted after that commit, so nothing in the repo
  produced `gold.ml_event_surge_forecast`, and the warehouse could not be made
  to yield 48 by any documented rule.

Both scripts are now one file, so the served uplift and the score that
validates it can never drift apart.

## Method

- **Event days come from `silver.philippine_arena_events_clean`** — the same
  calendar the backend already uses to forecast upcoming events. 109 of its
  dates fall inside the volume record. Nothing is selected by how busy the road
  was, so the measured uplift is free to be small, and at most exits it is.
- **Holidays are a separate regime.** A concert on New Year's Eve is not a
  normal Tuesday with a concert on it — 31 Dec 2024 carried 210k vehicles
  against a December-Tuesday median of 364k. The normal-day median is built
  from days that are neither events nor holidays; each exit then gets a holiday
  factor (about **0.84x** of an ordinary day, from `public.ph_holidays`), and a
  day's expectation is the median times that factor when the day is a holiday.
  Uplift is read on top of that, so the calendar is not credited to the event.
  12 event days fall on a holiday.
- **Uplift** is the median ratio of actual to expected over event days, with a
  **bootstrap 95% interval**. An exit is *material* only when the whole
  interval clears 1.0. With effects this small that matters: a quartile
  heuristic waves through exits whose rise is sampling noise.

## How it is tested

Event days are split **chronologically** — the earlier 76 fit, the last 33 are
held out from 2024-10-01. The normal medians, the holiday factor and the
multipliers are all built from days before the cut, so nothing the model is
scored on has touched it. 627 exit-days are scored.

| Model | Error on held-out events |
|---|---|
| **Per-exit uplift** (served) | **11.44%** |
| Per-exit uplift, shrunk toward the corridor mean | 11.49% |
| Gradient Boosting | 11.59% |
| Flat uplift *(baseline)* | 11.89% |
| No event adjustment *(baseline)* | 13.69% |

Knowing an event is on cuts the error from 13.69% to 11.44%. The typical
held-out event day is **7.9%** off on corridor total; the mean is dragged up by
New Year's Eve, which stays the widest miss even after the holiday adjustment.

> These are **not** comparable with the old 5.49%. That was scored on days
> selected for being busy, where the baseline relationship is mechanically
> tighter. 11.44% is the first honest measurement on real event days.

## What it writes

- `gold.ml_event_surge_forecast` — per exit: baseline and surge volume, uplift
  with its bootstrap interval, extra vehicles, event count, and whether the
  rise is material. Dropped and recreated each run.
- `gold.ml_model_metrics` where `target = 'Event Surge'` — the leaderboard
  above, baselines included and marked as rejected.
- `gold.ml_event_surge_eval` — one JSON row holding the **replay**: every
  held-out event day with predicted and actual corridor volume, the closest
  call and the widest miss, and the method string. The card renders its
  "Did past predictions match what really happened?" chart from this; the API
  returns it as `extras.eventSurgeEval` on `/api/traffic/forecast`.

## Limits, carried into the table

- **Attendance is not in the calendar.** A sold-out concert and a small
  exhibition get the same prediction. This is the largest remaining source of
  error and the obvious next improvement if attendance data can be sourced.
- The uplift is an average of what past events did — a planning input, not a
  promise about one future night.
- Exits far from the arena show no reliable effect and are reported as *not
  material* rather than given a decorative multiplier. 13 of 19 qualify.
