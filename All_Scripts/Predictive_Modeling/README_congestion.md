# Congestion State Map — refreshing the forecast

The Predictive tab's "Predictive Congestion State Map" is served from two
warehouse tables that only change when `train_congestion_horizon.py` is run:

| Table | What the card reads from it |
|---|---|
| `gold.ml_predictive_congestion` | one row per exit × hour ahead (20 × 12): state, probability, and `base_ts`, the last complete hour of Waze ingestion the forecast counts from |
| `gold.ml_congestion_horizon_accuracy` | accuracy per horizon for every candidate, plus the persistence benchmark |
| `gold.ml_model_metrics` (`target = 'Congestion'`) | the leaderboard the card's model badge and the accepted/rejected verdicts come from |

The card shows an **expired** badge once the forecast's twelve-hour window has
run out, so the script has to run regularly for the map to mean anything.

## Staying fresh automatically

`refresh_congestion.bat` runs the `--fast` path and appends to
`refresh_congestion.log`. The Scheduled Task calls it through
`refresh_congestion_hidden.ps1`, which starts it with no visible window: run
directly, the task opened a console on the desktop every hour, and one was
closed by hand mid-run, which killed the refresh before it published. The task
fires every hour and is registered by `register-task4.ps1`-style code, i.e.
`Register-ScheduledTask` with the launcher path quoted (an earlier
`schtasks /TR` registration left the spaces in the path unquoted and every run
failed with "file not found"):

```
schtasks /Query  /TN "SmartFlow congestion refresh"   # is it registered?
schtasks /Run    /TN "SmartFlow congestion refresh"   # run one now
schtasks /Delete /TN "SmartFlow congestion refresh" /F  # stop refreshing
```

The task runs as the signed-in user and needs the machine awake; it reads
`Back-End/.env` for credentials, so that file has to stay where it is. If the
Waze ingestion itself stalls, `base_ts` stops advancing and the card will still
say expired — correctly, because there is nothing newer to forecast from.

## Run it

```
cd All_Scripts/Predictive_Modeling
python train_congestion_horizon.py --dry-run   # train + score, print, write nothing
python train_congestion_horizon.py --fast      # skip SARIMAX (~2 min), then publish
python train_congestion_horizon.py             # full leaderboard (~25 min), then publish
```

`--fast` drops the SARIMAX candidate. It is about 90% of the runtime (280 model
fits at rolling origins) and has never been accepted, scoring near chance
because a speed forecast one-hot'd into a class is the wrong shape for this
task. Use the full run when you want the complete leaderboard; use `--fast` for
a routine refresh.

Connection details are read from `Back-End/.env` (`PG_HOST`, `PG_PORT`,
`PG_DATABASE`, `PG_USER`, `PG_PASSWORD`). Nothing is hard-coded in the script.

Dependencies: `pandas numpy psycopg2 scikit-learn xgboost statsmodels`.
`tensorflow` is optional; without it the GRU candidate is skipped and the
leaderboard is XGBoost, QRF and SARIMAX.

Runtime is about two minutes with `--fast`, about twenty-five without: SARIMAX
(refit at rolling origins for 20 exits) is nearly all of the difference.

## What it does

- Builds an exit × hour grid from `silver.fact_waze_jams`, trimming trailing
  hours whose record count is under 25% of the norm for that hour of day, so
  an ingestion gap is not read as an empty corridor.
- Labels each cell from the length-weighted jam speed: **Severe** under
  10 km/h, **Heavy** 10–20, **Moving** above that or when no jam was reported.
  These cuts were 30 and 60 — generic expressway thresholds. Waze only reports
  a jam here once traffic is already slow, so 96% of reported jams ran under
  30 km/h: every reported hour landed in one class, Heavy was never predicted,
  and the map was solid red. Re-cut at this corridor's own distribution, the
  three classes carry roughly 49% / 38% / 14% of the grid.
- Forecasts **168 hours** (7 days), not 12. The card's day view needs 24 and
  its week view needs a full week, and all three ranges come from this one
  model because `horizon` is one of its features. Accuracy is close to flat
  across that span — 65.9% at +1h, 64.4% at +24h, 64.1% at +168h — because
  the recurring weekday-and-hour pattern carries most of the signal and the
  recent lags only help in the first few hours. A week ahead is therefore
  about as trustworthy as twelve hours ahead, which is not obvious and is the
  reason the week view is offered at all.
- Every hour out to 24 is a fitting horizon; beyond that the frame is thinned
  to every 6th hour (`--horizon-stride`). Fitting all 168 meant 2.2M rows and
  7m46s, too heavy for an hourly job; thinning gives 2m16s and, because the
  model has nothing to learn from +30h that it did not learn from +28h,
  slightly *better* held-out accuracy (64.1% against 63.3%). Every hour is
  still predicted and served — only the fitting frame is thinned.
- **The test window is 12 days, not 7.** A seven-day-ahead forecast cannot be
  scored against a seven-day test window: at horizon *h* only origins in
  `[cut, end - h]` have a known answer, so h=168 would have zero test rows.
  Twelve days leaves 2,400 scored rows at the far end.
- For each horizon 1–168 h the target is the state *h hours later*; features
  are only what is knowable at the origin hour: hour, weekday, the same hour
  one and two days earlier, and the last 1/2/3/6 hours plus 6 h and 24 h
  rolling means (the short lags were added in Sep 2026; the original set knew
  only lag-24 and lag-48), plus two things the exit's own history cannot say:
  the lag-1 state and 6 h mean of its **neighbouring exits** (km-post order
  from `gold.exit_km_post`, since congestion travels along the carriageway)
  and the exit's **train-only hour-of-day profile** (mean state and severe
  share by exit × hour × weekend, computed on training hours so the test
  window never leaks in).
- Training rows are weighted by inverse class frequency so Severe (14% of
  hours) is not ignored.
- **Probabilities are calibrated.** The card shows a *chance of congestion*
  per cell, so the numbers have to mean what they say. Raw XGBoost ran hot
  (said 65% → happened 51%; said 75% → 62%). The last 2 days of the training
  window are held back from the fit and used for an isotonic correction per
  class (`IsoCal`, one-vs-rest then renormalised). After it: said 55% → 55%,
  66% → 66%, 75% → 77%. Nothing from the test window touches either step.
  The trade-off is that calibrated argmax labels Severe rarely (recall ~7%),
  so the card points readers at the per-cell severe % rather than red cells.
- Holds out the last 7 days, scores every candidate per horizon against the
  persistence and exit-hour-profile baselines, and accepts only models that
  beat the best baseline.
- **The week view adds chances; it does not count labels.** "Hours congested
  on Tuesday" is the sum of that day's calibrated hourly chances, not a count
  of hours whose most-likely label is congested. Taking the winner in every
  cell saturates: it collapses each exit toward whichever class it usually is,
  so Marilao (congested 80% of hours in the record) predicts 100% and
  Balintawak (54%) predicts 4%. Scored against each exit's real base rate,
  counting labels is off by 22.9 points on average and adding chances by 8.0.
  The chances can be added because they are calibrated.
- Serves the champion's forecast from the newest complete hour, writing each
  cell's winning state and confidence **and** the full vector `p_low`,
  `p_med`, `p_high` to `gold.ml_predictive_congestion` (columns are added
  with `ADD COLUMN IF NOT EXISTS` on first run).
- Writes one JSON row to `gold.ml_congestion_eval` — test size, class shares,
  per-class precision/recall, Brier score, macro-F1, the calibration table
  (said vs happened per decile), thresholds, the feature list, and the
  **replay** (below). The card's Validation evidence is rendered from it; the
  API returns it as `extras.congestionEval` on `/api/traffic/forecast`.
- **The replay** is the evidence a reader can actually see. Accuracy and Brier
  are summary statistics; neither shows that the forecast tracked reality.
  So the held-out window is rebuilt hour by hour as it would have been
  forecast `REPLAY_HZ` (3) hours in advance, recording for each hour the
  model's *expected* number of congested exits — the sum of the 20 calibrated
  chances, which is how a probability is totalled — against how many actually
  were. The card plots the two as one chart. Current run: 164 hours,
  correlation 0.82, the two lines 1.85 exits apart on average out of 20, and
  65.9% of individual exit-hours given the exact right state. The payload also
  carries the closest call on a busy hour and the widest miss, so a presenter
  has a concrete example rather than only an average.

Each run is transactional: the served forecast is deleted and rewritten in one
transaction, so a run that is interrupted rolls back and the previous forecast
stays in place rather than leaving the map empty. A missed hour therefore costs
freshness, not correctness, and the card badges the forecast as overdue once it
is more than two hours old.

Log of each scheduled run lands in `refresh_congestion.log` next to the
script (git-ignored). Current figures (18 Sep 2026, 168-hour model): XGBoost
64.1% against a 57.9% exit-hour-profile baseline, with persistence at 62.1%
for +1h and 42.5% by +12h. Per horizon: 65.9% at +1h, 65.5% at +12h, 64.4% at
+24h, 64.1% at +168h.
