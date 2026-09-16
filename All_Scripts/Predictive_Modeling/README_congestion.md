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
- For each horizon 1–12 h the target is the state *h hours later*; features
  are only what is knowable at the origin hour: hour, weekday, the same hour
  one and two days earlier, and the last 1/2/3/6 hours plus 6 h and 24 h
  rolling means (the short lags were added in Sep 2026; the original set knew
  only lag-24 and lag-48).
- Holds out the last 7 days, scores every candidate per horizon against the
  persistence and exit-hour-profile baselines, and accepts only models that
  beat the best baseline.
- Serves the champion's forecast from the newest complete hour.
