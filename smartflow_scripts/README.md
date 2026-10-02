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
| hourly traffic (source of truth) | `gold.fact_traffic_hourly`, `gold.fact_traffic_hourly_origin` | 2022–2025: `1_data_loading/traffic/build_fact.mjs` → `load_fact.js`, `build_origin.mjs` → `load_origin.js`. 2026: uploaded on the dashboard's Data Management page (`toll_hourly`, `Back-End/src/etl/toll-hourly.ts`), which replaces only the days in the file and also extends the daily series and `gold.fact_emissions_hourly`. The record ends on `RECORD_END` (2026-06-30, the end of the incident and emissions records); rows after it are held back, so move that date when the record is meant to grow. **Re-running `load_fact.js` or `load_origin.js` drops every year they do not read, 2026 included: upload the 2026 file again afterwards.** |
| Descriptive traffic tab | `public.nlex_traffic_volume` (materialized view) | `1_data_loading/traffic/rebuild_descriptive.js` |
| exit km-posts, segments | `gold.exit_km_post`, `gold.exit_segment_km` | `2_reference_tables/build_km_table.js`, `build_emissions.js` |
| hourly emissions | `gold.fact_emissions_hourly` | `2_reference_tables/build_emissions.js` |
| volume forecast + metrics | `gold.ml_predictive_volume`, `gold.ml_model_metrics` (`Total Traffic`) | `3_training_testing/traffic_volume/retrain_honest.py` |
| volume 90-day future + horizon accuracy | `gold.ml_predictive_volume`, `gold.ml_horizon_accuracy` | `3_training_testing/traffic_volume/extend_future_volume.py` |
| congestion map | `gold.ml_predictive_congestion`, `gold.ml_congestion_horizon_accuracy`, metrics `Congestion` | `3_training_testing/congestion/train_congestion_horizon.py` (see note below) |
| CO₂ forecast | `gold.ml_predictive_emissions`, metrics `Corridor CO2` | `3_training_testing/emissions/train_emissions.py`. Candidates: GBR, Polynomial, LSTM and **Derived** (volume Prophet × CO₂ per vehicle by weekday), all scored by the served day-by-day procedure since 2026-10-02 (before, GBR/Polynomial saw each window's actual lags, so their holdout was a next-day score). `4_studies_audits/co2_derived_forecast_study.py` is the read-only comparison that prompted it. |
| event surge | `gold.ml_event_surge_forecast`; metrics `Event Surge` | `3_training_testing/event_surge/build_event_surge.py`; `eval_event_surge.py` |
| incident forecast, severity, spatial risk, weather-speed | `public.ml_predictive_incidents`, `public.ml_daily_actuals`, `public.ml_training_metadata`, `gold.ml_incident_*`, `gold.ml_weather_speed_*` | `Back-End/incident_model_scripts/` (stays there: the incident services and the clearance panel refer to that path) |
| uploads on the Data Management page | every layout's bronze table, then its silver table (or the gold traffic record) | `Back-End/src/etl/`: one transaction per upload; rows already loaded are skipped by their natural key; dated record rows after `RECORD_END` (2026-06-30) are held back; "Check only" runs it all and rolls back. **No need to re-run the medallion SQL after an upload any more** — `publish.ts` applies the same silver rules to the rows it wrote. |
| every model's holdout metrics, in one place | `gold.model_evaluation` (a read-only view over the rows above: metric, strongest baseline, holdout window) | `Back-End/scripts/medallion/11-gold-model-evaluation.sql`; re-run it only if a trainer changes what it writes |
| weekly retrain record (Data Management page) | `gold.ml_batch_runs`, `gold.ml_batch_watermarks`, last backups in schema `ml_backup` | `3_training_testing/weekly_retrain/weekly_retrain.py`, every Sunday 22:00 (see Open item 1) |

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

1. **Retraining is a weekly batch, every Sunday at 22:00.** This is the
   schedule agreed with the adviser. Uploads never retrain anything; the next
   Sunday batch picks them up. `3_training_testing/weekly_retrain/weekly_retrain.py`
   handles each model group in turn:
   - It checks whether the group's input tables changed since it was last
     trained, by row count, latest date and a column total. Groups with no new
     data are skipped.
   - It backs the group's outputs up to `ml_backup`.
   - It clears the prediction caches: they are keyed on row count and last
     date only, so a corrected upload would otherwise reuse old results.
   - It runs the trainers **one at a time**, retrying a failed trainer once.
     Two at once ran this machine out of memory.
   - It tests the result (Gate 5): every trainer finished and wrote results;
     no negative or implausible forecasts; and per target, the champion still
     beats its baseline, MASE stays < 1 where it was, and the main metric is
     not more than 25% worse (or 0.05 lower for scores).
   - If the group fails, it restores last week's outputs.

   Commands, from `3_training_testing/weekly_retrain/`:
   - Register the Sunday task once: `powershell -ExecutionPolicy Bypass -File register_weekly_task.ps1`
   - Read-only preview: `python weekly_retrain.py --plan`
   - Run now: `python weekly_retrain.py`, adding `--force` to retrain unchanged groups and `--only volume,emissions` to limit it.
   - Undo the latest retrain of a group: `python weekly_retrain.py --restore <group>`.

   What it cannot do on this PC:
   - Windows Application Control blocks `torch`'s DLLs, so the incident
     hotspot (`train_incident_spatial_models.py`) and weather-speed models are
     reported as "cannot run here" and keep their current results.
   - The breakdown-response model (`gold.ml_breakdown_response_*`, written
     2026-09-30) has no trainer in this repo, so it is not in the batch.

   Fixed on 2026-10-02 while retraining: `extend_future_volume.py` read the
   models' `(forecast, fitted)` pair as one array; `train_fleet_mix.py` read
   credentials from a path that no longer exists.
2. **The congestion forecast runs hourly, from outside this repo.** The
   Scheduled Task "SmartFlow congestion refresh" (since 2026-09-17) runs
   `Front-and-back-ForDSU-Push-Kia/All_Scripts/Predictive_Modeling/train_congestion_horizon.py --fast`.
   That copy has 660 lines; `3_training_testing/congestion/` has a 460-line
   one, so the two differ. It only runs while this PC is on. The card marks the
   forecast expired once `base_ts` is more than a day old.
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
