# smartflow_scripts

Every script used to build, train, test, audit and report on the SmartFlow NLEX
database, in one place. The dashboard app (`Back-End/`, `Front-End-Dashboard/`)
sits beside this folder; this is everything *around* it.

**Where these came from.**
- **The project root and `pipeline_scripts/`.** The originals were **moved** to
  `scratch/_script_backup_2026-09-11/`, so nothing was deleted.
- **Other folders:** `scratch/cleaned`, `scratch/nlex-emissions`,
  `predictive folder`, the Gemini session folder, Kia's repo copies, `Downloads`
  and `Desktop`. Their scripts were **copied**, and those folders were left as
  they were.
- **Merge into this system (2026-09-14).** This folder was brought into
  `Front-and-back-sandbox-updated-hans`.
  - The sandbox's own `All_Scripts/` is now
    `_archive_do_not_run/All_Scripts_folder_2026-09-11/`. Its scripts are the
    first-generation models and checks already archived here.
  - Its root `populate_redis.js` is `7_utilities/populate_redis.js`.

`_work/migration_manifest.json` records every file from the first
consolidation: its original location and every change made to it.

---

## Setup

```
cd smartflow_scripts
copy config\.env.example config\.env      # then fill it in
pip install -r requirements.txt
npm install
```

`config/.env` holds:
- the database login
- the three data locations outside this folder (raw toll CSVs, incident CSV,
  report output folder)
- the manuscript PDF path
- the Climatiq key

Every script reads it via `config/db.py` or `config/db.cjs`. **No script
contains a password, key or machine path any more.** Never commit or upload
`config/.env`. It is gitignored and left out of the zip.

---

## Folder map

| folder | what | touches the database |
|---|---|---|
| `1_data_loading/traffic` | raw hourly toll CSVs → `gold.fact_traffic_hourly` and the descriptive view | writes |
| `1_data_loading/incidents` | stalled-vehicle CSV → `public.nlex_stalled_vehicles` | writes |
| `2_reference_tables` | km-posts and exit segments | writes |
| `2_reference_tables/one_off_migrations` | renames and fixes, **already applied**; blocked unless `ALLOW_MIGRATION=1` | writes |
| `3_training_testing` | **current** trainers for traffic volume, congestion, emissions and event surge | writes |
| `4_studies_audits` | horizon studies, leakage audit, reconciliation checks | read-only |
| `4_studies_audits/exploratory` | one-off analyses behind decisions made on the dashboard | read-only |
| `5_reports_exports` | writes the `MODEL_EVALUATION_REPORT` run folders | reads DB, writes files |
| `6_etl_pipeline` | snapshot of the Back-End ETL, the original Python ETL, the warehouse schema | see below |
| `7_utilities` | Redis cache, Climatiq search, manuscript PDF text, dashboard screenshots, slide-deck generator | mostly no |
| `8_diagnostics` | small `check_*` / `inspect_*` probes | read-only |
| `_archive_do_not_run` | everything superseded; **every script has a hard stop at the top** | — |
| `_work` | caches, intermediate files, logs, outputs (gitignored) | — |

### What produced the numbers on the dashboard

| dashboard data | table(s) | script |
|---|---|---|
| hourly traffic (source of truth) | `gold.fact_traffic_hourly`, `gold.fact_traffic_hourly_origin` | `1_data_loading/traffic/build_fact.mjs` → `load_fact.js`, `build_origin.mjs` → `load_origin.js` |
| Descriptive traffic tab | `public.nlex_traffic_volume` (materialized view) | `1_data_loading/traffic/rebuild_descriptive.js` |
| exit km-posts, segments | `gold.exit_km_post`, `gold.exit_segment_km` | `2_reference_tables/build_km_table.js`, `build_emissions.js` |
| hourly emissions | `gold.fact_emissions_hourly` | `2_reference_tables/build_emissions.js` |
| volume forecast + metrics | `gold.ml_predictive_volume`, `gold.ml_model_metrics` (`Total Traffic`) | `3_training_testing/traffic_volume/retrain_honest.py` |
| volume 90-day future + horizon accuracy | `gold.ml_predictive_volume`, `gold.ml_horizon_accuracy` | `3_training_testing/traffic_volume/extend_future_volume.py` |
| congestion map | `gold.ml_predictive_congestion`, `gold.ml_congestion_horizon_accuracy`, metrics `Congestion` | `3_training_testing/congestion/train_congestion_horizon.py` (see note below) |
| CO₂ forecast | `gold.ml_predictive_emissions`, metrics `Corridor CO2` | `3_training_testing/emissions/train_emissions.py` |
| event surge | `gold.ml_event_surge_forecast`; metrics `Event Surge` | `3_training_testing/event_surge/build_event_surge.py`; `eval_event_surge.py` |
| incident forecast, severity, spatial risk, weather-speed | `public.ml_predictive_incidents`, `public.ml_daily_actuals`, `public.ml_training_metadata`, `gold.ml_incident_*`, `gold.ml_weather_speed_*` | `Back-End/incident_model_scripts/` (stays there: the incident services and the clearance panel refer to that path) |

**The congestion trainer is Kiarra's Sep 11 version.**
- It is the Sep 8 script plus short-lag features (`lag1`–`lag6`, 6h and 24h
  rolling state) and `--dry-run`.
- It is the run that wrote the congestion results live in the database:
  2026-09-11, XGBoost 82.08% vs best baseline 75.97%.
- The Sep 8 version is in `_archive_do_not_run/older_versions/`.

**Live Waze ingestion** runs inside the Back-End ETL
(`Back-End/src/etl/extractors/waze.extractor.ts`), not here.

---

## Rebuild order

Each step depends on the ones above it.

1. `1_data_loading/traffic/drop_lingunan.py`: removes the Lingunan exit from
   the 2025 CSV. It writes `nlex_traffic_hourly_2025_clean.csv`.
2. `build_fact.mjs` → `load_fact.js`: produces **`gold.fact_traffic_hourly`**.
   Exit names are resolved by the ETL's own `Back-End/src/etl/canonical-exit.ts`,
   which is compiled on each run, so the two cannot drift.
3. `build_origin.mjs` → `load_origin.js`, then `rebuild_descriptive.js`.
4. `2_reference_tables/build_km_table.js` → `build_emissions.js`.
5. `3_training_testing/` and `Back-End/incident_model_scripts/`: any order.
   Each trainer owns its own rows.
6. `4_studies_audits/`, `5_reports_exports/`: whenever needed.

---

## Safety rules built in

- **Traffic-volume trainer runs one arm at a time.** `retrain_honest.py` runs
  the 80/20 arm (the one the dashboard serves) by default. Run
  `SPLIT=90_10 python retrain_honest.py` for the other.
  - It replaces **only its own arm's rows**.
  - This was checked against the live tables inside a transaction that was
    rolled back: the other arm kept all its rows.
  - The old version truncated the whole table and wrote no `split_label`, so a
    re-run would have emptied the volume panel.
- **Congestion trainer dry run.** `python train_congestion_horizon.py --dry-run`
  trains and scores but writes nothing.
- **One-off migrations** refuse to run unless `ALLOW_MIGRATION=1`.
- **Everything in `_archive_do_not_run/`** stops immediately with a message
  saying why it was archived.
  - The exception is `All_Scripts_folder_2026-09-11/`, kept exactly as it was in
    the team repo.

---

## Open items — read before re-running

1. **The volume forecast still has the weather leak in the database.**
   - The bug: `retrain_honest.py` scored Prophet, SARIMAX and LSTM using the
     *observed* weather of the days being forecast.
   - The code is fixed. The forecast window now uses day-of-year climatology
     from the training data only, the same fix as emissions.
   - **It has not been re-run.** The volume metrics shown today come from the
     old code and are slightly optimistic.
   - To refresh:
     1. `python retrain_honest.py`
     2. `SPLIT=90_10 python retrain_honest.py`
     3. `python extend_future_volume.py`
2. **The congestion forecast goes stale.** It covers the 12 hours after the
   latest Waze data, and nothing schedules `train_congestion_horizon.py`. The
   card marks it expired once `base_ts` is more than a day old.
3. **The source files are named `synthetic`.** This applies to
   `synthetic-nlex-data/`, `synthetic_data_varying/` and `*_synthetic.csv`.
   Confirm whether they are real client exports before describing them as real
   data in the manuscript.
4. **`6_etl_pipeline/backend_etl_snapshot/` is a copy.** The ETL the app runs
   lives in `Back-End/src/etl` and `Back-End/scripts`. Edit it there.
5. **The descriptive traffic total is 2× the predictive one.**
   - `4_studies_audits/sot_check.js` shows the two sources cover the same
     1,461 days with correlation r = 1.0000.
   - The descriptive view counts each trip at both its entry and its exit
     plaza.
   - This audit had been failing since the descriptive table became a
     materialized view. It is fixed.

---

## Scripts that were changed while moving

All first-consolidation changes are listed per file in
`_work/migration_manifest.json`. The ones that change behaviour:

- `retrain_honest.py` — split-safe writes, weather-leak fix, 90-day future,
  checkpoint in `_work/cache`
- `train_congestion_horizon.py` — replaced with Kiarra's Sep 11 version; its
  connection now comes from `config/.env`, and results go to `_work/outputs`
- `sot_check.js` — reads column names from `pg_attribute`, so it works on the
  materialized view
- `search_codebase.cjs`, `populate_redis.js` — paths relative to this folder
- `test_resolver.mjs` — takes the names list as an argument; its old temp
  input no longer exists
