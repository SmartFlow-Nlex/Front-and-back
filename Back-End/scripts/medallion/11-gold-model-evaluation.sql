-- GOLD: model_evaluation — every model's holdout metrics, in one place.
--
-- One row per model per thing it predicts: volume, emissions (CO2 and fleet
-- mix), congestion, event surge and incidents. Each row carries the metric
-- its pipeline ranks or accepts on, the usual error measures where they
-- exist, and the HOLDOUT WINDOW it was scored on: the dates, how many days
-- or rows, and the protocol in words.
--
-- A VIEW, and read-only. Every trainer keeps writing its own tables exactly as
-- before; this only reads them. Nothing here is copied or recomputed, except
-- where a figure is a plain count over a trainer's own holdout predictions
-- (the windows, and the severity model's majority-class baseline).
--
-- WHERE EACH PART COMES FROM
--   gold.ml_model_metrics            volume (both splits), corridor CO2, fleet
--                                    mix, congestion state, event surge
--   holdout windows                  is_holdout rows of gold.ml_predictive_volume,
--                                    _emissions, _fleet_mix; the eval payloads of
--                                    congestion and event surge
--   public.ml_training_metadata(_accident)   daily incident counts
--   gold.ml_incident_severity_metadata       severity, clearance time, secondary risk
--   gold.ml_breakdown_response_metadata      breakdown response time
--   gold.ml_incident_spatial_metadata        incidents per exit
--   gold.ml_weather_speed_metadata           speed, gridlock and incident days under weather
--   gold.congestion_jam_profile_eval         queue length and delay at a jam
--
-- Left out on purpose: gold.ml_model_metrics_split8020 / _split9010 (copies of
-- the volume rows, which ml_model_metrics holds with split_label), and the
-- per-horizon tables gold.ml_horizon_accuracy and
-- gold.ml_congestion_horizon_accuracy, which break a model's score down by
-- horizon rather than adding models.
--
-- READING IT
--   primary_metric / primary_value   what the pipeline ranks or gates on
--   best_baseline(_value)            the strongest baseline scored on the same
--                                    target and window, where one exists
--   beats_best_baseline              whether a model does better than it
--   holdout_from / holdout_to        null only for leave-one-out evaluation,
--                                    which holds out places, not dates
--
-- Idempotent: CREATE OR REPLACE.

CREATE OR REPLACE VIEW gold.model_evaluation AS
WITH
vol_h AS (
  SELECT split_label, MIN(forecast_date)::date AS lo, MAX(forecast_date)::date AS hi, COUNT(*)::int AS n
    FROM gold.ml_predictive_volume WHERE is_holdout GROUP BY split_label
),
co2_h AS (
  SELECT MIN(forecast_date)::date AS lo, MAX(forecast_date)::date AS hi, COUNT(*)::int AS n
    FROM gold.ml_predictive_emissions WHERE is_holdout
),
fleet_h AS (
  SELECT MIN(forecast_date)::date AS lo, MAX(forecast_date)::date AS hi, COUNT(*)::int AS n
    FROM gold.ml_predictive_fleet_mix WHERE is_holdout
),
-- The congestion trainer scores its last test_days days of exit-hours. The
-- window starts on the first day of its replay series; test_days says where
-- it ends, which the series' last timestamp would overshoot by the horizon.
cong_h AS (
  SELECT lo, (lo + (days - 1))::date AS hi, n, days
    FROM (SELECT (SELECT MIN((e->>'t')::timestamp)::date FROM jsonb_array_elements(payload->'replay'->'series') e) AS lo,
                 (payload->>'test_days')::int AS days,
                 (payload->>'test_rows')::int AS n
            FROM gold.ml_congestion_eval ORDER BY updated_at DESC LIMIT 1) c
),
-- Event surge: the evaluation states its own window in its metrics' diagnosis
-- ("held out 9 of 29 event days chronologically (2025-10-20 to 2026-03-26);
-- 171 exit-days scored", eval_event_surge.py). gold.ml_event_surge_eval holds
-- the replay behind the dashboard card, written by an older build script, so it
-- can describe an earlier evaluation; it is only the fallback.
es_diag AS (
  SELECT diagnosis AS t FROM gold.ml_model_metrics
   WHERE target = 'Event Surge' AND diagnosis ~ 'exit-days scored'
   ORDER BY rank NULLS LAST, updated_at DESC LIMIT 1
),
es_pay AS (
  SELECT (payload->>'test_from')::date AS lo,
         (SELECT MAX((e->>'t')::date) FROM jsonb_array_elements(payload->'series') e) AS hi,
         (payload->>'exit_days_scored')::int AS n,
         (payload->>'events_test')::int AS events_test,
         (payload->>'events_train')::int AS events_train
    FROM gold.ml_event_surge_eval ORDER BY updated_at DESC LIMIT 1
),
es_h AS (
  SELECT COALESCE(substring(d.t FROM '\((\d{4}-\d{2}-\d{2}) (?:to|onward)')::date, p.lo) AS lo,
         COALESCE(substring(d.t FROM '\(\d{4}-\d{2}-\d{2} to (\d{4}-\d{2}-\d{2})\)')::date, p.hi) AS hi,
         COALESCE(replace(substring(d.t FROM '([\d,]+) exit-days scored'), ',', '')::int, p.n) AS n,
         COALESCE(substring(d.t FROM 'held out (\d+) of')::int, p.events_test) AS events_test,
         COALESCE(substring(d.t FROM 'held out \d+ of (\d+)')::int - substring(d.t FROM 'held out (\d+) of')::int, p.events_train) AS events_train
    FROM es_pay p FULL JOIN es_diag d ON true
),
mm AS (
  SELECT m.*,
         row_number() OVER (PARTITION BY m.target, m.split_label
                            ORDER BY (m.rank IS NULL), m.accepted DESC, m.rank) AS served_order
    FROM gold.ml_model_metrics m
),
inc AS (
  SELECT 'Daily incidents (accidents and breakdowns)'::text AS target, metadata_json AS meta, created_at,
         'public.ml_training_metadata'::text AS src
    FROM public.ml_training_metadata
  UNION ALL
  SELECT 'Daily accidents', metadata_json, created_at, 'public.ml_training_metadata_accident'
    FROM public.ml_training_metadata_accident
),
sev AS (SELECT metadata_json AS meta, created_at FROM gold.ml_incident_severity_metadata ORDER BY created_at DESC LIMIT 1),
sev_h AS (
  SELECT MIN(incident_date)::date AS lo, MAX(incident_date)::date AS hi, COUNT(*)::int AS n,
         (SELECT MAX(k)::float8 / NULLIF(SUM(k), 0)
            FROM (SELECT COUNT(*) AS k FROM gold.ml_incident_severity_predictions GROUP BY actual_severity_code) z) AS majority_share
    FROM gold.ml_incident_severity_predictions
),
resp AS (SELECT metadata_json AS meta, created_at FROM gold.ml_breakdown_response_metadata ORDER BY created_at DESC LIMIT 1),
resp_h AS (
  SELECT MIN(event_date)::date AS lo, MAX(event_date)::date AS hi, COUNT(*)::int AS n
    FROM gold.ml_breakdown_response_predictions
),
spat AS (SELECT metadata_json AS meta, created_at FROM gold.ml_incident_spatial_metadata ORDER BY created_at DESC LIMIT 1),
-- The spatial LSTM holds out the last 60 days before its panel ends, both
-- ends inclusive (61 dates); its forecast is for the day after the panel.
spat_h AS (
  SELECT (MAX(forecast_date) - 61)::date AS lo, (MAX(forecast_date) - 1)::date AS hi
    FROM gold.ml_incident_segment_risk
),
ws AS (SELECT metadata_json AS meta, created_at FROM gold.ml_weather_speed_metadata ORDER BY created_at DESC LIMIT 1),
ws_h AS (
  SELECT MIN(forecast_date)::date AS lo, MAX(forecast_date)::date AS hi, COUNT(*)::int AS n
    FROM gold.ml_weather_speed_forecast
),
jam AS (SELECT payload AS p, updated_at FROM gold.congestion_jam_profile_eval ORDER BY updated_at DESC LIMIT 1),

base AS (
  /* 1. gold.ml_model_metrics: volume, corridor CO2, fleet mix, congestion state, event surge. */
  SELECT
    CASE m.target WHEN 'Total Traffic' THEN 'Volume' WHEN 'Corridor CO2' THEN 'Emissions' WHEN 'Fleet Mix' THEN 'Emissions'
                  WHEN 'Congestion' THEN 'Congestion' WHEN 'Event Surge' THEN 'Event surge' ELSE m.target END AS domain,
    CASE m.target
      WHEN 'Total Traffic' THEN 'Daily corridor volume, ' || replace(m.split_label, '_', '/') || ' split'
      WHEN 'Corridor CO2' THEN 'Daily corridor CO2'
      WHEN 'Fleet Mix' THEN 'Daily fleet mix (class shares)'
      WHEN 'Congestion' THEN 'Congestion state per exit-hour, 1 to 168 h ahead'
      WHEN 'Event Surge' THEN 'Exit volume on Philippine Arena event days'
      ELSE m.target END AS target,
    m.model_name,
    CASE WHEN m.rank IS NULL THEN 'baseline' ELSE 'model' END AS role,
    m.rank,
    m.accepted,
    (m.rank IS NOT NULL AND m.served_order = 1) AS is_champion,
    -- Congestion is a classifier: the trainer writes its accuracy into r2 and its log loss into mae.
    CASE WHEN m.target = 'Congestion' THEN 'accuracy' ELSE 'WMAPE %' END AS primary_metric,
    CASE WHEN m.target = 'Congestion' THEN m.r2 ELSE m.wmape END AS primary_value,
    (m.target = 'Congestion') AS higher_is_better,
    CASE WHEN m.target = 'Congestion' THEN NULL ELSE m.mae END AS mae,
    m.rmse,
    m.wmape AS wmape_pct,
    m.mase,
    CASE WHEN m.target = 'Congestion' THEN NULL ELSE m.r2 END AS r2,
    CASE WHEN m.target = 'Congestion' THEN m.r2 END AS accuracy,
    NULL::float8 AS auc,
    NULL::float8 AS concordance,
    CASE m.target WHEN 'Total Traffic' THEN 'vehicles/day' WHEN 'Corridor CO2' THEN 'tonnes CO2/day'
                  WHEN 'Fleet Mix' THEN 'percentage points of class share' WHEN 'Event Surge' THEN 'vehicles per exit-day' END AS error_unit,
    CASE m.target WHEN 'Total Traffic' THEN vh.n WHEN 'Corridor CO2' THEN (SELECT n FROM co2_h) WHEN 'Fleet Mix' THEN (SELECT n FROM fleet_h)
                  WHEN 'Congestion' THEN (SELECT n FROM cong_h) WHEN 'Event Surge' THEN (SELECT n FROM es_h) END AS n_scored,
    CASE m.target WHEN 'Total Traffic' THEN vh.lo WHEN 'Corridor CO2' THEN (SELECT lo FROM co2_h) WHEN 'Fleet Mix' THEN (SELECT lo FROM fleet_h)
                  WHEN 'Congestion' THEN (SELECT lo FROM cong_h) WHEN 'Event Surge' THEN (SELECT lo FROM es_h) END AS holdout_from,
    CASE m.target WHEN 'Total Traffic' THEN vh.hi WHEN 'Corridor CO2' THEN (SELECT hi FROM co2_h) WHEN 'Fleet Mix' THEN (SELECT hi FROM fleet_h)
                  WHEN 'Congestion' THEN (SELECT hi FROM cong_h) WHEN 'Event Surge' THEN (SELECT hi FROM es_h) END AS holdout_to,
    CASE m.target
      WHEN 'Total Traffic' THEN 'chronological ' || replace(m.split_label, '_', '/') || ' split: the last '
                                || (100 - split_part(m.split_label, '_', 1)::int) || '% of days'
      WHEN 'Corridor CO2' THEN 'chronological: the days after training'
      WHEN 'Fleet Mix' THEN 'rolling origin: 42 seven-day forecasts, each from the data before it'
      WHEN 'Congestion' THEN 'chronological: the last ' || (SELECT days FROM cong_h) || ' days of Waze exit-hours, at every horizon'
      WHEN 'Event Surge' THEN 'chronological: the ' || (SELECT events_test FROM es_h) || ' Arena event days from '
                              || (SELECT lo FROM es_h) || ', trained on the ' || (SELECT events_train FROM es_h) || ' before'
    END AS holdout,
    -- Some trainers write a missing note as the text 'NaN'; and a baseline's
    -- diagnosis can repeat its rejected_reason word for word.
    NULLIF(concat_ws('; ',
      CASE m.target WHEN 'Fleet Mix' THEN 'WMAPE is on the heavy-vehicle share; MASE is skill against persistence'
                    WHEN 'Congestion' THEN 'accuracy averaged over horizons; per-horizon in gold.ml_congestion_horizon_accuracy' END,
      NULLIF(m.rejected_reason, 'NaN'),
      CASE WHEN m.target <> 'Congestion' AND m.diagnosis IS DISTINCT FROM m.rejected_reason
           THEN NULLIF(m.diagnosis, 'NaN') END), '') AS notes,
    'gold.ml_model_metrics'::text AS source,
    m.updated_at AS evaluated_at
  FROM mm m
  LEFT JOIN vol_h vh ON m.target = 'Total Traffic' AND vh.split_label = m.split_label

  UNION ALL
  /* 2. Daily incident counts, all incidents and accidents only. Selected on R2. */
  SELECT 'Incidents', i.target, e->>'model', 'model', NULL::int, NULL::boolean,
    (e->>'model') = (i.meta->>'champion_model'),
    'R2', (e->>'R2')::float8, true,
    (e->>'MAE')::float8, (e->>'RMSE')::float8, (e->>'WMAPE')::float8, (e->>'MASE')::float8, (e->>'R2')::float8,
    NULL::float8, NULL::float8, NULL::float8,
    'incidents/day',
    (i.meta->'evaluation'->>'scored_days')::int,
    (i.meta->'evaluation'->'holdout_window'->>0)::date,
    (i.meta->'evaluation'->'holdout_window'->>1)::date,
    'chronological: the last ' || (i.meta->'evaluation'->>'holdout_days') || ' days',
    NULLIF(concat_ws('; ',
      'diagnosis ' || lower(e->>'Diagnosis') || ' (train R2 ' || round((e->>'Train_R2')::numeric, 3) || ')',
      (SELECT 'not scored: ' || string_agg((x->>'date') || ' (' || lower(split_part(x->>'reason', ':', 1)) || ')', ', ')
         FROM jsonb_array_elements(i.meta->'evaluation'->'excluded_from_scoring') x)), ''),
    i.src, i.created_at
  FROM inc i CROSS JOIN LATERAL jsonb_array_elements(i.meta->'model_comparison') e

  UNION ALL
  /* 3. Incident severity: the classifiers, and the baseline they have to beat. */
  SELECT 'Incidents', 'Incident severity class', k.key, 'model', NULL::int, NULL::boolean,
    k.key = (s.meta->'severity'->>'champion'),
    'accuracy', (k.value->>'accuracy')::float8, true,
    (k.value->>'MAE_ordinal')::float8, NULL::float8, NULL::float8, NULL::float8, NULL::float8,
    (k.value->>'accuracy')::float8, NULL::float8, NULL::float8,
    'severity classes',
    (k.value->>'n')::int, h.lo, h.hi,
    'chronological: the last ' || round((s.meta->>'holdout_fraction')::numeric * 100) || '% of accidents by date',
    NULL::text,
    'gold.ml_incident_severity_metadata', (s.meta->>'trained_at')::timestamptz
  FROM sev s CROSS JOIN sev_h h CROSS JOIN LATERAL jsonb_each(s.meta->'severity'->'metrics') k
  UNION ALL
  SELECT 'Incidents', 'Incident severity class', 'Majority class (always the most common severity)', 'baseline', NULL::int, NULL::boolean, false,
    'accuracy', h.majority_share, true,
    NULL::float8, NULL::float8, NULL::float8, NULL::float8, NULL::float8, h.majority_share, NULL::float8, NULL::float8,
    'severity classes', h.n, h.lo, h.hi,
    'chronological: the last ' || round((s.meta->>'holdout_fraction')::numeric * 100) || '% of accidents by date',
    'derived here: the commonest class''s share of the holdout',
    'gold.ml_incident_severity_predictions', (s.meta->>'trained_at')::timestamptz
  FROM sev s CROSS JOIN sev_h h

  UNION ALL
  /* 4. Clearance time and secondary-incident risk, from the same accident holdout. */
  SELECT 'Incidents', 'Incident clearance time', 'Cox proportional hazards', 'model', NULL::int, NULL::boolean, true,
    'MAE', (s.meta->'cox_ph'->>'mae_minutes')::float8, false,
    (s.meta->'cox_ph'->>'mae_minutes')::float8, NULL::float8, NULL::float8, NULL::float8, NULL::float8,
    NULL::float8, NULL::float8, (s.meta->'cox_ph'->>'concordance_index')::float8,
    'minutes', (s.meta->'cox_ph'->>'n')::int, h.lo, h.hi,
    'chronological: the last ' || round((s.meta->>'holdout_fraction')::numeric * 100) || '% of accidents by date',
    'mean clearance ' || round((s.meta->'cox_ph'->>'mean_clearance_minutes')::numeric, 1) || ' min',
    'gold.ml_incident_severity_metadata', (s.meta->>'trained_at')::timestamptz
  FROM sev s CROSS JOIN sev_h h
  UNION ALL
  SELECT 'Incidents',
    'Secondary incident within ' || trim_scale((s.meta->>'secondary_km_radius')::numeric) || ' km and '
      || trim_scale((s.meta->>'secondary_buffer_min')::numeric) || ' min',
    'Logistic regression (ridge)', 'model', NULL::int, NULL::boolean, true,
    'AUC', (s.meta->'secondary_risk'->>'auc')::float8, true,
    NULL::float8, NULL::float8, NULL::float8, NULL::float8, NULL::float8,
    NULL::float8, (s.meta->'secondary_risk'->>'auc')::float8, NULL::float8,
    NULL::text, (s.meta->'secondary_risk'->>'n')::int, h.lo, h.hi,
    'chronological: the last ' || round((s.meta->>'holdout_fraction')::numeric * 100) || '% of accidents by date',
    'base rate ' || round((s.meta->'secondary_risk'->>'base_rate')::numeric * 100, 1) || '%; AUC 0.5 is chance',
    'gold.ml_incident_severity_metadata', (s.meta->>'trained_at')::timestamptz
  FROM sev s CROSS JOIN sev_h h

  UNION ALL
  /* 5. Breakdown response time. */
  SELECT 'Incidents', 'Breakdown response time', 'Cox proportional hazards', 'model', NULL::int, NULL::boolean,
    (r.meta->>'champion') = 'CoxPH',
    'MAE', (r.meta->'cox_ph'->>'mae_minutes')::float8, false,
    (r.meta->'cox_ph'->>'mae_minutes')::float8, NULL::float8, NULL::float8, NULL::float8, NULL::float8,
    NULL::float8, NULL::float8, (r.meta->'cox_ph'->>'concordance_index')::float8,
    'minutes', (r.meta->'cox_ph'->>'n')::int, h.lo, h.hi,
    'chronological: the last ' || round((r.meta->>'holdout_fraction')::numeric * 100) || '% of breakdowns by date',
    NULL::text, 'gold.ml_breakdown_response_metadata', (r.meta->>'trained_at')::timestamptz
  FROM resp r CROSS JOIN resp_h h
  UNION ALL
  SELECT 'Incidents', 'Breakdown response time', 'XGBoost', 'model', NULL::int, NULL::boolean,
    (r.meta->>'champion') = 'XGBoost',
    'MAE', (r.meta->'xgboost'->>'mae_minutes')::float8, false,
    (r.meta->'xgboost'->>'mae_minutes')::float8, NULL::float8, NULL::float8, NULL::float8, (r.meta->'xgboost'->>'r2')::float8,
    NULL::float8, NULL::float8, NULL::float8,
    'minutes', (r.meta->'xgboost'->>'n')::int, h.lo, h.hi,
    'chronological: the last ' || round((r.meta->>'holdout_fraction')::numeric * 100) || '% of breakdowns by date',
    NULL::text, 'gold.ml_breakdown_response_metadata', (r.meta->>'trained_at')::timestamptz
  FROM resp r CROSS JOIN resp_h h

  UNION ALL
  /* 6. Incidents per exit. GWR is scored leave-one-exit-out, so it holds out places, not dates. */
  SELECT 'Incidents', 'Average daily incidents per exit', 'Geographically weighted regression', 'model', NULL::int, NULL::boolean, true,
    'MAE', (sp.meta->'gwr'->'metrics'->>'loocv_mae')::float8, false,
    (sp.meta->'gwr'->'metrics'->>'loocv_mae')::float8, NULL::float8, NULL::float8, NULL::float8, NULL::float8,
    NULL::float8, NULL::float8, NULL::float8,
    'incidents per exit-day', (sp.meta->'gwr'->'metrics'->>'loocv_n')::int, NULL::date, NULL::date,
    'leave-one-exit-out: each of the ' || (sp.meta->'gwr'->'metrics'->>'loocv_n') || ' exits predicted from the others',
    'in-sample MAE ' || round((sp.meta->'gwr'->'metrics'->>'MAE')::numeric, 3),
    'gold.ml_incident_spatial_metadata', (sp.meta->>'trained_at')::timestamptz
  FROM spat sp
  UNION ALL
  SELECT 'Incidents', 'Daily incidents per exit', b.name, b.role, NULL::int, NULL::boolean, b.role = 'model',
    'MAE', b.mae, false,
    b.mae, NULL::float8, NULL::float8, NULL::float8, NULL::float8, NULL::float8, NULL::float8, NULL::float8,
    'incidents per exit-day', (sp.meta->'spatial_lstm'->'metrics'->>'n')::int, h.lo, h.hi,
    'chronological: the last 61 days, all ' || (sp.meta->'spatial_lstm'->'metrics'->>'n_exits') || ' exits',
    NULL::text, 'gold.ml_incident_spatial_metadata', (sp.meta->>'trained_at')::timestamptz
  FROM spat sp CROSS JOIN spat_h h
  CROSS JOIN LATERAL (VALUES
    ('Spatial LSTM', 'model', (sp.meta->'spatial_lstm'->'metrics'->>'MAE')::float8),
    ('Zero (no incidents)', 'baseline', (sp.meta->'spatial_lstm'->'metrics'->>'baseline_mae_zero')::float8),
    ('Per-exit mean', 'baseline', (sp.meta->'spatial_lstm'->'metrics'->>'baseline_mae_per_exit_mean')::float8)
  ) AS b(name, role, mae)

  UNION ALL
  /* 7. The weather pipeline. Its source's speed and volume columns are synthetic, and every row says so. */
  SELECT 'Congestion', 'Daily corridor speed under weather', k.key, 'model', NULL::int, NULL::boolean,
    k.key = (w.meta->'speed'->>'champion'),
    'MAE', (k.value->>'MAE')::float8, false,
    (k.value->>'MAE')::float8, (k.value->>'RMSE')::float8, NULL::float8, NULL::float8, (k.value->>'R2')::float8,
    NULL::float8, NULL::float8, NULL::float8,
    'km/h (the warehouse''s speed metric)', (k.value->>'n')::int, h.lo, h.hi,
    'chronological: the last ' || (w.meta->>'holdout_days') || ' days',
    'scored on bronze.nlex_traffic_volume, whose speed column is synthetic capstone data (train_incident_weather_speed_models.py)',
    'gold.ml_weather_speed_metadata', (w.meta->>'trained_at')::timestamptz
  FROM ws w CROSS JOIN ws_h h CROSS JOIN LATERAL jsonb_each(w.meta->'speed'->'metrics') k
  UNION ALL
  SELECT 'Congestion', 'Daily corridor speed under weather', 'Naive (no change)', 'baseline', NULL::int, NULL::boolean, false,
    'MAE', (w.meta->'speed'->>'naive_mae')::float8, false,
    (w.meta->'speed'->>'naive_mae')::float8, NULL::float8, NULL::float8, NULL::float8, NULL::float8,
    NULL::float8, NULL::float8, NULL::float8,
    'km/h (the warehouse''s speed metric)', h.n, h.lo, h.hi,
    'chronological: the last ' || (w.meta->>'holdout_days') || ' days',
    'scored on bronze.nlex_traffic_volume, whose speed column is synthetic capstone data (train_incident_weather_speed_models.py)',
    'gold.ml_weather_speed_metadata', (w.meta->>'trained_at')::timestamptz
  FROM ws w CROSS JOIN ws_h h
  UNION ALL
  SELECT 'Congestion', 'Hourly speed per exit under weather', 'XGBoost (exit-hour)', 'model', NULL::int, NULL::boolean, true,
    'MAE', (w.meta->'contour'->'metrics'->>'MAE')::float8, false,
    (w.meta->'contour'->'metrics'->>'MAE')::float8, NULL::float8, NULL::float8, NULL::float8, (w.meta->'contour'->'metrics'->>'R2')::float8,
    NULL::float8, NULL::float8, NULL::float8,
    'km/h (the warehouse''s speed metric)', (w.meta->'contour'->'metrics'->>'n')::int, h.lo, h.hi,
    'chronological: the last ' || (w.meta->>'holdout_days') || ' days, every exit-hour',
    'scored on bronze.nlex_traffic_volume, whose speed column is synthetic capstone data (train_incident_weather_speed_models.py)',
    'gold.ml_weather_speed_metadata', (w.meta->>'trained_at')::timestamptz
  FROM ws w CROSS JOIN ws_h h
  UNION ALL
  SELECT x.domain, x.target, 'Logistic regression', 'model', NULL::int, NULL::boolean, true,
    'AUC', x.auc, true,
    NULL::float8, NULL::float8, NULL::float8, NULL::float8, NULL::float8, NULL::float8, x.auc, NULL::float8,
    NULL::text, x.n, h.lo, h.hi,
    'chronological: the last ' || (w.meta->>'holdout_days') || ' days',
    'base rate ' || round(x.base_rate::numeric * 100, 1) || '%; AUC 0.5 is chance; '
      || 'scored on bronze.nlex_traffic_volume, whose speed and volume columns are synthetic capstone data',
    'gold.ml_weather_speed_metadata', (w.meta->>'trained_at')::timestamptz
  FROM ws w CROSS JOIN ws_h h
  CROSS JOIN LATERAL (VALUES
    ('Congestion', 'Gridlock day under weather', (w.meta->'road_closure'->>'auc')::float8,
       (w.meta->'road_closure'->>'n')::int, (w.meta->'road_closure'->>'base_rate')::float8),
    ('Incidents', 'Incident day under weather', (w.meta->'weather_incident_risk'->>'auc')::float8,
       (w.meta->'weather_incident_risk'->>'n')::int, (w.meta->'weather_incident_risk'->>'base_rate')::float8)
  ) AS x(domain, target, auc, n, base_rate)
  UNION ALL
  SELECT 'Volume', 'Daily corridor volume, weather pipeline', w.meta->>'volume_refit_of', 'model', NULL::int, NULL::boolean, false,
    'MAE', (w.meta->'volume_metrics'->>'MAE')::float8, false,
    (w.meta->'volume_metrics'->>'MAE')::float8, (w.meta->'volume_metrics'->>'RMSE')::float8, NULL::float8, NULL::float8,
    (w.meta->'volume_metrics'->>'R2')::float8, NULL::float8, NULL::float8, NULL::float8,
    'vehicles/day', (w.meta->'volume_metrics'->>'n')::int, h.lo, h.hi,
    'chronological: the last ' || (w.meta->>'holdout_days') || ' days',
    'NOT comparable with the volume rows above: scored on bronze.nlex_traffic_volume, synthetic capstone data padded past the real record',
    'gold.ml_weather_speed_metadata', (w.meta->>'trained_at')::timestamptz
  FROM ws w CROSS JOIN ws_h h

  UNION ALL
  /* 8. Queue length and delay at a jam: the served exit x day-type x hour profile against flatter averages. */
  SELECT 'Congestion', t.target, t.model, t.role, NULL::int, NULL::boolean, t.role = 'model',
    'MAE', t.mae, false,
    t.mae, NULL::float8, NULL::float8, NULL::float8, NULL::float8, NULL::float8, NULL::float8, NULL::float8,
    t.unit, (j.p->>'test_exit_hours')::int, (j.p->>'test_from')::date, (j.p->>'test_to')::date,
    'chronological: jam hours from ' || (j.p->>'test_from') || ', profiles built on ' || (j.p->>'history_from') || ' to ' || (j.p->>'history_to'),
    t.note, 'gold.congestion_jam_profile_eval', j.updated_at
  FROM jam j
  CROSS JOIN LATERAL (VALUES
    ('Queue length at a jam', 'Exit x day-type x hour profile', 'model', (j.p->'queue'->>'profile_mae_m')::float8, 'metres',
       'median error ' || (j.p->'queue'->>'profile_median_err_m') || ' m'),
    ('Queue length at a jam', 'Per-exit average', 'baseline', (j.p->'queue'->>'exit_mae_m')::float8, 'metres', NULL),
    ('Queue length at a jam', 'Corridor average', 'baseline', (j.p->'queue'->>'corridor_mae_m')::float8, 'metres',
       'median error ' || (j.p->'queue'->>'corridor_median_err_m') || ' m'),
    ('Delay at a jam', 'Exit x day-type x hour profile', 'model', (j.p->'delay'->>'profile_mae_s')::float8, 'seconds',
       'median error ' || (j.p->'delay'->>'profile_median_err_s') || ' s'),
    ('Delay at a jam', 'Per-exit average', 'baseline', (j.p->'delay'->>'exit_mae_s')::float8, 'seconds', NULL),
    ('Delay at a jam', 'Corridor average', 'baseline', (j.p->'delay'->>'corridor_mae_s')::float8, 'seconds',
       'median error ' || (j.p->'delay'->>'corridor_median_err_s') || ' s')
  ) AS t(target, model, role, mae, unit, note)
)
SELECT
  b.domain, b.target, b.model_name, b.role, b.rank, b.accepted, b.is_champion,
  b.primary_metric, b.primary_value, b.higher_is_better,
  bl.model_name AS best_baseline,
  bl.primary_value AS best_baseline_value,
  CASE WHEN b.role = 'model' AND b.primary_value IS NOT NULL AND bl.primary_value IS NOT NULL
       THEN CASE WHEN b.higher_is_better THEN b.primary_value > bl.primary_value ELSE b.primary_value < bl.primary_value END
  END AS beats_best_baseline,
  b.mae, b.rmse, b.wmape_pct, b.mase, b.r2, b.accuracy, b.auc, b.concordance, b.error_unit,
  b.n_scored, b.holdout_from, b.holdout_to,
  (b.holdout_to - b.holdout_from + 1) AS holdout_days,
  b.holdout, b.notes, b.source, b.evaluated_at
FROM base b
LEFT JOIN LATERAL (
  SELECT x.model_name, x.primary_value
    FROM base x
   WHERE x.role = 'baseline' AND x.target = b.target AND x.primary_metric = b.primary_metric
     AND x.primary_value IS NOT NULL
   ORDER BY CASE WHEN x.higher_is_better THEN -x.primary_value ELSE x.primary_value END
   LIMIT 1
) bl ON true;

COMMENT ON VIEW gold.model_evaluation IS
  'Every model''s holdout metrics in one place: volume, emissions (CO2, fleet mix), congestion, event surge, incidents. One row per model per target, with the metric its pipeline ranks or gates on, the strongest baseline on the same window, and the holdout window (dates, size, protocol). Read-only over each trainer''s own tables; see Back-End/scripts/medallion/11-gold-model-evaluation.sql.';
COMMENT ON COLUMN gold.model_evaluation.primary_metric IS 'The metric the pipeline ranks or gates on for this target.';
COMMENT ON COLUMN gold.model_evaluation.best_baseline IS 'The strongest baseline scored on the same target, metric and window; null where the pipeline scores none.';
COMMENT ON COLUMN gold.model_evaluation.holdout IS 'How the holdout was chosen, in words. holdout_from/holdout_to are null only for leave-one-out evaluation, which holds out places rather than dates.';
COMMENT ON COLUMN gold.model_evaluation.n_scored IS 'What the metric was averaged over: days, exit-days, exit-hours or events, as the holdout column says.';
