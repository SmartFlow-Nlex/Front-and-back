# Congestion State Map — refreshing the forecast

The Predictive tab's "Predictive Congestion State Map" is served from two
warehouse tables that only change when `train_congestion_horizon.py` is run:

| Table | What the card reads from it |
|---|---|
| `gold.ml_predictive_congestion` | one row per exit × hour ahead (20 × 12): state, probability, and `base_ts`, the last complete hour of Waze ingestion the forecast counts from |
| `gold.ml_congestion_horizon_accuracy` | accuracy per horizon for every candidate, plus the persistence benchmark |
| `gold.ml_model_metrics` (`target = 'Congestion'`) | the leaderboard the card's model badge and the accepted/rejected verdicts come from |

The card shows an **expired** badge once `base_ts` is more than a day behind
the clock, so the script has to run at least daily for the map to mean
anything.

## Run it

```
cd All_Scripts/Predictive_Modeling
python train_congestion_horizon.py --dry-run   # train + score, print, write nothing
python train_congestion_horizon.py             # same, then overwrite the three tables
```

Connection details are read from `Back-End/.env` (`PG_HOST`, `PG_PORT`,
`PG_DATABASE`, `PG_USER`, `PG_PASSWORD`). Nothing is hard-coded in the script.

Dependencies: `pandas numpy psycopg2 scikit-learn xgboost statsmodels`.
`tensorflow` is optional; without it the GRU candidate is skipped and the
leaderboard is XGBoost, QRF and SARIMAX.

Runtime is a few minutes; SARIMAX (refit at rolling origins for 20 exits) is
most of it.

## What it does

- Builds an exit × hour grid from `silver.fact_waze_jams`, trimming trailing
  hours whose record count is under 25% of the norm for that hour of day, so
  an ingestion gap is not read as an empty corridor.
- Labels each cell from the length-weighted jam speed: Severe under 30 km/h,
  Heavy 30–60, Clear when no jam was reported. In practice 96% of reported
  jams are under 30 km/h, so Heavy is rare.
- For each horizon 1–12 h the target is the state *h hours later*; features
  are only what is knowable at the origin hour: hour, weekday, the same hour
  one and two days earlier, and the last 1/2/3/6 hours plus 6 h and 24 h
  rolling means (the short lags were added in Sep 2026; the original set knew
  only lag-24 and lag-48).
- Holds out the last 7 days, scores every candidate per horizon against the
  persistence and exit-hour-profile baselines, and accepts only models that
  beat the best baseline.
- Serves the champion's forecast from the newest complete hour.
