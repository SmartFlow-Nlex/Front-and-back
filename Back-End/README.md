# SmartFlow Back-End

## Run
1. Copy `.env.example` to `.env` and fill in the database password
2. Install dependencies: `npm install`
3. Dev server: `npm run dev`

The front-end needs the same treatment — copy `Front-End-Dashboard/.env.example`
to `Front-End-Dashboard/.env.local`. From the repo root, `start_project.bat`
launches both servers together.

Default URL: `http://localhost:4000`

## API Routes
- `GET /api/health`
- `GET /api/dashboard`
- `GET /api/traffic`
- `GET /api/incident`
- `GET /api/emissions`
- `GET /api/map-comparison`
- `GET /api/ai-sandbox`
- `GET /api/data-management`
- `GET /api/audit-log`

## Incident predictive model

The forecast on `/dashboard/incident` is served from three tables that already
hold committed results — **you do not need to train anything to see the graphs**,
just point `.env` at the shared database and run the app.

| Table | Holds |
| --- | --- |
| `ml_daily_actuals` | observed daily incident counts (2020-01-01 onward) |
| `ml_predictive_incidents` | validation + future predictions, one column per model (`pred_xgboost`, `pred_lstm`, …) |
| `ml_training_metadata` | champion, full 7-model comparison, evaluation protocol |

Source data is the union of `nlex_road_crashes`, `nlex_motorcycle_crashes` and
`nlex_stalled_vehicles` — the same three logs the rest of the incident dashboard
reads. Do **not** point it at `bronze.nlex_incidents`: that table omits stalled
vehicles entirely (~85% of incident volume).

### Re-running the pipeline

Only needed when the source data changes. It **overwrites** all three tables, so
everyone sees the new numbers immediately.

```bash
# One-time setup. Use a SHORT venv path — TensorFlow's headers exceed the
# Windows 260-character limit if the venv sits inside this repo.
python -m venv C:/Users/<you>/.venvs/nlex-ml
C:/Users/<you>/.venvs/nlex-ml/Scripts/python.exe -m pip install -r incident_model_scripts/requirements.txt

cd incident_model_scripts
# Compare all 7 models and write model_results.txt — no DB writes:
C:/Users/<you>/.venvs/nlex-ml/Scripts/python.exe train_incident_models.py
# Same, plus publish the champion + every model's predictions:
C:/Users/<you>/.venvs/nlex-ml/Scripts/python.exe train_incident_models.py --write-db
```

Useful flags: `--protocol walk-forward` (harder 3-fold test), `--holdout-days N`
(scoring window; under ~60 makes R² unstable on this series), `--select-by mae`,
`--champion <Model>`.

Each run rewrites `incident_model_scripts/model_results.txt` with per-model
metrics (MAE, RMSE, MAPE, sMAPE, WMAPE, Poisson deviance, MASE, RMSSE, R²,
Adjusted R², train/val split and diagnosis). That file is committed, so the
current results are readable without a database connection.

## Structure
- `src/config`: env + db setup
- `src/routes`: route definitions
- `src/controllers`: request handlers
- `src/services`: business logic stubs
- `src/middleware`: error + validation middleware
- `src/validators`: zod schemas
- `src/types`: shared API types

## PostGIS Integration Notes
Use `src/services/*.service.ts` for DB queries. For geospatial data, query with `ST_AsGeoJSON`, `ST_Transform`, and return FeatureCollection JSON.
