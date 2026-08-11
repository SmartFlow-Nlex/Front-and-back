import { db } from "../config/db.js";

// ---------------------------------------------------------------------------
// Incident analytics for the descriptive dashboard.
// Sources: nlex_road_crashes, nlex_motorcycle_crashes, nlex_stalled_vehicles
// (operations logs with Km-post locations), plus hourly_weather for exposure.
// ---------------------------------------------------------------------------

export type IncidentSource = "all" | "road" | "moto" | "stalled";

export type IncidentWeather = "all" | "dry" | "wet";

export type IncidentAnalyticsFilters = {
  months: "3" | "12" | "all";
  from?: string;
  to?: string;
  source?: IncidentSource;
  weather?: IncidentWeather;
};

type CacheEntry = { at: number; data: unknown };
const incidentCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000;

// Unified incident log. Dates are stored as text in two formats.
// Response minutes are computed mod 24h to survive midnight wrap, capped at 120.
const INCIDENTS_CTE = `
  incidents AS (
    SELECT CASE WHEN date LIKE '%/%' THEN to_date(date, 'MM/DD/YYYY') ELSE date::date END AS d, reported_time AS rt, response_time AS resp,
           location, cause_of_accident AS cause, type_of_accident AS itype,
           weather_condition,
           COALESCE(injuries_male, 0) + COALESCE(injuries_female, 0) AS inj,
           COALESCE(fatalities_male, 0) + COALESCE(fatalities_female, 0) AS fat,
           'road' AS src
    FROM nlex_road_crashes WHERE date IS NOT NULL
    UNION ALL
    SELECT CASE WHEN date LIKE '%/%' THEN to_date(date, 'MM/DD/YYYY') ELSE date::date END, reported_time, response_time,
           location, cause_of_accident, type_of_accident, weather_condition,
           COALESCE(injuries_male, 0) + COALESCE(injuries_female, 0),
           COALESCE(fatalities_male, 0) + COALESCE(fatalities_female, 0),
           'moto'
    FROM nlex_motorcycle_crashes WHERE date IS NOT NULL
    UNION ALL
    SELECT CASE WHEN date LIKE '%/%' THEN to_date(date, 'MM/DD/YYYY') ELSE date::date END, reported_time, responded_time,
           location, vehicle_cause, 'Stalled vehicle', NULL, 0, 0, 'stalled'
    FROM nlex_stalled_vehicles WHERE date IS NOT NULL
  )`;

const RESPONSE_MIN = `
  CASE WHEN rt IS NOT NULL AND resp IS NOT NULL THEN
    MOD((EXTRACT(EPOCH FROM (resp::time - rt::time)) / 60)::int + 1440, 1440)
  END`;

const HOUR_OF = `EXTRACT(hour FROM rt::time)::int`;
const KM_OF = `(regexp_match(location, 'Km\\s*(\\d+)'))[1]::int`;

export async function getIncidentAnalyticsFromDb(filters: IncidentAnalyticsFilters) {
  if (!db) return null;

  const cacheKey = JSON.stringify(filters);
  const cached = incidentCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  try {
    const bounds = await db.query(
      `SELECT min(CASE WHEN date LIKE '%/%' THEN to_date(date, 'MM/DD/YYYY') ELSE date::date END)::text AS lo, max(CASE WHEN date LIKE '%/%' THEN to_date(date, 'MM/DD/YYYY') ELSE date::date END)::text AS hi FROM nlex_road_crashes`
    );
    const minDate: string = bounds.rows[0].lo;
    const maxDate: string = bounds.rows[0].hi;

    let lo: string;
    let hi: string;
    if (filters.from && filters.to) {
      const [f, t] = filters.from <= filters.to ? [filters.from, filters.to] : [filters.to, filters.from];
      lo = f < minDate ? minDate : f;
      hi = t > maxDate ? maxDate : t;
    } else {
      // Month ranges anchor at the default year (2025), clamped to available data:
      // "12 mo" opens as calendar 2025, "3 mo" as Jan-Apr 2025.
      const anchor = "2025-01-01";
      lo = anchor < minDate ? minDate : anchor > maxDate ? minDate : anchor;
      hi =
        filters.months === "all"
          ? maxDate
          : (
              await db.query(`SELECT LEAST(($1::date + ($2 || ' months')::interval)::date, $3::date)::text AS hi`, [lo, filters.months, maxDate]))
              .rows[0].hi;
    }

    const src = filters.source && filters.source !== "all" ? filters.source : null;
    const wx = filters.weather && filters.weather !== "all" ? filters.weather : null;
    // $1=lo $2=hi $3=src (nullable) $4=weather (nullable: 'wet'|'dry')
    const params = [lo, hi, src, wx];

    // Hour-level wet/dry classification (expressway-avg rainfall > 0.3 mm), spanning
    // the previous period too so the KPI comparison stays weather-filtered.
    const WXALL_CTE = `
      wxall AS (
        SELECT (timestamp_utc + interval '8 hours')::date AS d,
               EXTRACT(hour FROM timestamp_utc + interval '8 hours')::int AS h,
               AVG(rainfall) > 0.3 AS wet
        FROM hourly_weather
        WHERE (timestamp_utc + interval '8 hours')::date BETWEEN $1::date - ($2::date - $1::date + 1) AND $2
        GROUP BY 1, 2
      )`;
    const WEATHER_OK = `($4::text IS NULL OR (rt IS NOT NULL AND EXISTS (
      SELECT 1 FROM wxall w WHERE w.d = incidents.d AND w.h = ${HOUR_OF} AND w.wet = ($4 = 'wet'))))`;
    const WHERE = `d BETWEEN $1 AND $2 AND ($3::text IS NULL OR src = $3) AND ${WEATHER_OK}`;

    // Local time = UTC+8 for weather join
    const WX_CTE = `
      wx AS (
        SELECT (timestamp_utc + interval '8 hours')::date AS d,
               EXTRACT(hour FROM timestamp_utc + interval '8 hours')::int AS h,
               AVG(rainfall) AS rain
        FROM hourly_weather
        WHERE (timestamp_utc + interval '8 hours')::date BETWEEN $1 AND $2
        GROUP BY 1, 2
      )`;

    const [trend, hotspot, heatmap, causes, types, weatherExposure, weatherIncidents, jamSpeedWx, kpi] =
      await Promise.all([
        // Daily counts by source (client rolls up to weekly/monthly)
        db.query(
          `WITH ${INCIDENTS_CTE}, ${WXALL_CTE}
           SELECT d::text, COUNT(*) FILTER (WHERE src = 'road')::int AS road,
                  COUNT(*) FILTER (WHERE src = 'moto')::int AS moto,
                  COUNT(*) FILTER (WHERE src = 'stalled')::int AS stalled
           FROM incidents WHERE ${WHERE} GROUP BY 1 ORDER BY 1`,
          params
        ),
        // Hotspots: 5-km bins from the Km-post in the location field
        db.query(
          `WITH ${INCIDENTS_CTE}, ${WXALL_CTE}
           SELECT (FLOOR(${KM_OF} / 5) * 5)::int AS km_bin, COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE src = 'road')::int AS road,
                  COUNT(*) FILTER (WHERE src = 'moto')::int AS moto,
                  COUNT(*) FILTER (WHERE src = 'stalled')::int AS stalled,
                  SUM(inj)::int AS injuries, SUM(fat)::int AS fatalities
           FROM incidents
           WHERE ${WHERE} AND location ~ 'Km\\s*\\d+'
           GROUP BY 1 ORDER BY 2 DESC`,
          params
        ),
        // Hour x day-of-week frequency
        db.query(
          `WITH ${INCIDENTS_CTE}, ${WXALL_CTE}
           SELECT EXTRACT(dow FROM d)::int AS dow, ${HOUR_OF} AS hour, COUNT(*)::int AS v
           FROM incidents WHERE ${WHERE} AND rt IS NOT NULL
           GROUP BY 1, 2 ORDER BY 1, 2`,
          params
        ),
        // Top causes with severity
        db.query(
          `WITH ${INCIDENTS_CTE}, ${WXALL_CTE}
           SELECT cause AS label, COUNT(*)::int AS total, SUM(inj)::int AS injuries, SUM(fat)::int AS fatalities
           FROM incidents WHERE ${WHERE} AND cause IS NOT NULL
           GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
          params
        ),
        // Top accident types with severity (crashes only — stalled vehicles have no type)
        db.query(
          `WITH ${INCIDENTS_CTE}, ${WXALL_CTE}
           SELECT itype AS label, COUNT(*)::int AS total, SUM(inj)::int AS injuries, SUM(fat)::int AS fatalities
           FROM incidents WHERE ${WHERE} AND itype IS NOT NULL AND src <> 'stalled'
           GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
          params
        ),
        // Weather exposure: wet vs dry hours in range (expressway-wide avg rainfall)
        db.query(
          `WITH ${WX_CTE}
           SELECT COUNT(*) FILTER (WHERE rain > 0.3)::int AS wet_hours,
                  COUNT(*) FILTER (WHERE rain <= 0.3)::int AS dry_hours
           FROM wx`,
          [lo, hi]
        ),
        // Incidents on wet vs dry hours, by source
        db.query(
          `WITH ${INCIDENTS_CTE}, ${WX_CTE}
           SELECT (w.rain > 0.3) AS wet, i.src, COUNT(*)::int AS n
           FROM incidents i JOIN wx w ON w.d = i.d AND w.h = EXTRACT(hour FROM i.rt::time)::int
           WHERE i.d BETWEEN $1 AND $2 AND ($3::text IS NULL OR i.src = $3) AND i.rt IS NOT NULL
             AND ($4::text IS NULL OR (w.rain > 0.3) = ($4 = 'wet'))
           GROUP BY 1, 2`,
          params
        ),
        // Traffic impact: avg jam speed on wet vs dry hours
        db.query(
          `WITH ${WX_CTE}
           SELECT (w.rain > 0.3) AS wet,
                  ROUND(AVG(j.avg_speed_kmh)::numeric, 1)::float AS speed,
                  ROUND(AVG(j.avg_jam_level)::numeric, 2)::float AS jam_level
           FROM fact_hourly_jams j JOIN wx w ON w.d = j.date_day AND w.h = j.hour_of_day
           WHERE j.date_day BETWEEN $1 AND $2
           GROUP BY 1`,
          [lo, hi]
        ),
        // KPI: current vs previous period + severity + response time + rain share
        db.query(
          `WITH ${INCIDENTS_CTE}, ${WXALL_CTE}
           SELECT
             COUNT(*) FILTER (WHERE ${WHERE})::int AS cur_total,
             COUNT(*) FILTER (WHERE d >= $1::date - ($2::date - $1::date + 1) AND d < $1::date AND ($3::text IS NULL OR src = $3) AND ${WEATHER_OK})::int AS prev_total,
             SUM(inj) FILTER (WHERE ${WHERE})::int AS injuries,
             SUM(fat) FILTER (WHERE ${WHERE})::int AS fatalities,
             ROUND(AVG(${RESPONSE_MIN}) FILTER (WHERE ${WHERE} AND ${RESPONSE_MIN} BETWEEN 0 AND 120)::numeric, 1)::float AS avg_response_min,
             COUNT(*) FILTER (WHERE ${WHERE} AND weather_condition = 'Rainy')::int AS rainy_crashes,
             COUNT(*) FILTER (WHERE ${WHERE} AND weather_condition IS NOT NULL)::int AS weather_known
           FROM incidents`,
          params
        ),
      ]);

    const wxInc = { wet: { road: 0, moto: 0, stalled: 0 }, dry: { road: 0, moto: 0, stalled: 0 } };
    for (const r of weatherIncidents.rows) {
      const bucket = r.wet ? wxInc.wet : wxInc.dry;
      bucket[r.src as "road" | "moto" | "stalled"] = r.n;
    }
    const jamWx = { wet: null as { speed: number; jam_level: number } | null, dry: null as { speed: number; jam_level: number } | null };
    for (const r of jamSpeedWx.rows) {
      jamWx[r.wet ? "wet" : "dry"] = { speed: r.speed, jam_level: r.jam_level };
    }

    const data = {
      range: { from: lo, to: hi },
      meta: { minDate, maxDate },
      kpis: {
        totalIncidents: kpi.rows[0].cur_total,
        prevTotalIncidents: kpi.rows[0].prev_total,
        injuries: kpi.rows[0].injuries ?? 0,
        fatalities: kpi.rows[0].fatalities ?? 0,
        avgResponseMin: kpi.rows[0].avg_response_min,
        rainyCrashes: kpi.rows[0].rainy_crashes,
        weatherKnown: kpi.rows[0].weather_known,
      },
      dailyTrend: trend.rows,
      hotspots: hotspot.rows,
      heatmap: heatmap.rows,
      causes: causes.rows,
      types: types.rows,
      weather: {
        wetHours: weatherExposure.rows[0].wet_hours,
        dryHours: weatherExposure.rows[0].dry_hours,
        incidents: wxInc,
        jam: jamWx,
      },
    };

    incidentCache.set(cacheKey, { at: Date.now(), data });
    return data;
  } catch (error) {
    console.error("Database query failed for incident analytics:", error);
    return null;
  }
}

// [DEV-01] Get Incident List
export async function getIncidentListFromDb(status: string) {
  if (!db) return null;
  try {
    let query = `SELECT * FROM incidents_table`;
    if (status === "active") query += ` WHERE clearance_time_mins IS NULL`;
    if (status === "resolved") query += ` WHERE clearance_time_mins IS NOT NULL`;
    
    const { rows } = await db.query(query);
    return rows;
  } catch (error) {
    console.error("Database query failed for incidents:", error);
    return null;
  }
}

// [DEV-02] Get Incident Metrics (Rate, Severity, Clearance Time)
export async function getIncidentMetricsFromDb() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT 
        COUNT(*) as total_incidents,
        AVG(clearance_time_mins) as avg_clearance_time,
        severity, COUNT(severity) as severity_count
      FROM incidents_table
      GROUP BY severity
    `);
    return rows;
  } catch (error) {
    console.error("Database query failed for incident metrics:", error);
    return null;
  }
}

// [DEV-03] Get Weather Correlation
export async function getWeatherCorrelationFromDb() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT weather_condition, COUNT(*) as incident_count
      FROM incidents_table
      GROUP BY weather_condition
    `);
    return rows;
  } catch (error) {
    console.error("Database query failed for weather correlation:", error);
    return null;
  }
}

// [ML-01] Get Predictive Incident Forecast from Database
//
// Three tables, written together by the incident forecasting pipeline
// (Back-End/incident_model_scripts/run_predictive_pipeline.py), unqualified —
// they live in the default/public schema, not gold like the traffic ML tables:
//   ml_daily_actuals(d date, total float)                     — observed daily incident counts
//   ml_predictive_incidents(forecast_date date, prediction_type
//     'validation'|'future', predicted_incident_count float, champion_model text)
//   ml_training_metadata(metadata_json jsonb, created_at timestamptz) — most recent row wins
//
// An empty ml_training_metadata means the pipeline has never run, which we
// treat the same as "database not reachable" (null → 503 upstream).
type DailyActualRow = { date: string; total: string | number };
// The seven candidates, in the order the dashboard lists them. Keys match
// MODEL_NAMES in incident_model_scripts/train_incident_models.py; columns match
// PRED_COLUMN there.
export const INCIDENT_MODELS = [
  { key: "XGBoost", column: "pred_xgboost" },
  { key: "RandomForest", column: "pred_randomforest" },
  { key: "LSTM", column: "pred_lstm" },
  { key: "GRU", column: "pred_gru" },
  { key: "Poisson_GLM", column: "pred_poisson_glm" },
  { key: "NegBinomial_GLM", column: "pred_negbinomial_glm" },
  { key: "SARIMAX", column: "pred_sarimax" },
] as const;

type PredictiveIncidentRow = {
  date: string;
  prediction_type: "validation" | "future";
  predicted_incident_count: string | number;
  champion_model: string | null;
  // Observed count on the same weekday one year earlier — the year-over-year
  // term the model leans on most. Kept for reference; not plotted.
  same_day_last_year: string | number | null;
  // Rain (mm) behind this date's forecast — hourly_weather actuals, or an
  // Open-Meteo forecast for future dates beyond its coverage. See
  // fetch_future_rain in train_incident_models.py.
  rainfall_mm: string | number | null;
} & Partial<Record<(typeof INCIDENT_MODELS)[number]["column"], string | number | null>>;

export type IncidentPredictiveResult = {
  summary: {
    totalPredictedNext7Days: number;
    peakRiskDate: string | null;
    championModel: string | null;
  };
  daily: {
    date: string;
    actual: number | null;
    predicted: number | null;
    predictionType: "validation" | "future" | null;
    sameDayLastYear: number | null;
    // Rain (mm) for this date, aligned with the forecast so the chart can
    // overlay rainfall and incident count on the same timeline.
    rainfallMm: number | null;
    // One entry per candidate that has stored predictions, so the chart can
    // overlay several at once the way the traffic chart does.
    models: Record<string, number | null>;
  }[];
  // Per-model metrics for the comparison table, ranked as the pipeline ranked them.
  modelMetrics: {
    model: string;
    MAE: number | null;
    RMSE: number | null;
    WMAPE: number | null;
    MASE: number | null;
    R2: number | null;
    Adjusted_R2: number | null;
    Train_R2: number | null;
    Gap: number | null;
    Diagnosis: string | null;
    isChampion: boolean;
  }[];
  featureImportance: { feature: string; importance: number }[];
  modelInfo: {
    championModel: string | null;
    forecastHorizon: number;
    trainedAt: string | null;
    metrics: Record<string, unknown> | null;
    // Width of the window the metrics were actually computed on. Wider than the
    // validation band the chart draws, so the UI can say so rather than implying
    // the reported R² came from the ten days on screen.
    scoredDays: number | null;
  };
};

// Chart geometry, matched to the traffic walk-forward chart (Past 40 / Present 10
// / Future 15) so the two forecasts read as one family. Shipping all ~6.5 years of
// actuals made the response ~170 KB and squeezed 2,400 points into one line, which
// hid the validation and forecast windows entirely.
const PAST_CONTEXT_DAYS = 40;

// The model is SCORED on the full validation window — 90 days, recorded in
// ml_training_metadata.evaluation.holdout_days — because R² cannot be estimated
// reliably from a short window on this series. Drawing all 90 would let the
// Present band swallow the chart, so only the most recent slice is plotted.
// Reported metrics are unaffected: they come from the training metadata, not
// from this array.
const DISPLAY_VALIDATION_DAYS = 10;

export function buildIncidentPredictiveResponse(
  actuals: DailyActualRow[],
  predictions: PredictiveIncidentRow[],
  metadata: Record<string, unknown>,
  trainedAt: string | Date | null
): IncidentPredictiveResult {
  const actualByDate = new Map(actuals.map((r) => [r.date, Number(r.total)]));
  const predByDate = new Map(predictions.map((r) => [r.date, r]));
  const allDates = Array.from(new Set([...actualByDate.keys(), ...predByDate.keys()])).sort();

  // Only offer models the pipeline actually stored predictions for.
  const availableModels = INCIDENT_MODELS.filter((m) =>
    predictions.some((p) => p[m.column] != null)
  );

  const fullDaily = allDates.map((date) => {
    const pred = predByDate.get(date);
    const models: Record<string, number | null> = {};
    for (const m of availableModels) {
      const v = pred?.[m.column];
      models[m.key] = v != null ? Number(v) : null;
    }
    return {
      date,
      actual: actualByDate.has(date) ? actualByDate.get(date)! : null,
      predicted: pred ? Number(pred.predicted_incident_count) : null,
      predictionType: pred?.prediction_type ?? null,
      sameDayLastYear:
        pred?.same_day_last_year != null ? Number(pred.same_day_last_year) : null,
      rainfallMm: pred?.rainfall_mm != null ? Number(pred.rainfall_mm) : null,
      models,
    };
  });

  // Anchor the drawn "Present" band on the forecast boundary and walk back
  // DISPLAY_VALIDATION_DAYS, so the band width is stable no matter how wide the
  // scored window is.
  const firstPredIndex = fullDaily.findIndex((r) => r.predictionType != null);
  const firstFutureIndex = fullDaily.findIndex((r) => r.predictionType === "future");
  const presentStart =
    firstFutureIndex >= 0
      ? Math.max(Math.max(firstPredIndex, 0), firstFutureIndex - DISPLAY_VALIDATION_DAYS)
      : firstPredIndex;

  // Validation days older than the drawn band revert to plain history, so the
  // forecast line begins exactly at the Present boundary — the same shape the
  // traffic chart has, where no prediction is drawn across the Past band.
  const shaped = fullDaily.map((row, i) =>
    row.predictionType === "validation" && i < presentStart
      ? {
          ...row,
          predicted: null,
          predictionType: null,
          sameDayLastYear: null,
          models: Object.fromEntries(Object.keys(row.models).map((k) => [k, null])),
        }
      : row
  );

  const windowStart =
    presentStart < 0
      ? Math.max(0, shaped.length - PAST_CONTEXT_DAYS)
      : Math.max(0, presentStart - PAST_CONTEXT_DAYS);
  const daily = shaped.slice(windowStart);

  const futurePreds = predictions.filter((p) => p.prediction_type === "future");
  const totalPredictedNext7Days = futurePreds.reduce((sum, p) => sum + Number(p.predicted_incident_count), 0);
  const peak = futurePreds.reduce<PredictiveIncidentRow | null>(
    (best, p) => (!best || Number(p.predicted_incident_count) > Number(best.predicted_incident_count) ? p : best),
    null
  );
  const championModel = predictions.find((p) => p.champion_model)?.champion_model ?? (metadata.champion_model as string | undefined) ?? null;

  // The pipeline's own comparison table, reshaped for the UI. Ranked by R² to
  // match the champion criterion recorded in evaluation.selected_by.
  const rawComparison =
    (metadata.model_comparison as Record<string, unknown>[] | undefined) ?? [];
  const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const modelMetrics = rawComparison
    .map((r) => ({
      model: String(r.model),
      MAE: numOrNull(r.MAE),
      RMSE: numOrNull(r.RMSE),
      WMAPE: numOrNull(r.WMAPE),
      MASE: numOrNull(r.MASE),
      R2: numOrNull(r.R2),
      Adjusted_R2: numOrNull(r.Adjusted_R2),
      Train_R2: numOrNull(r.Train_R2),
      Gap: numOrNull(r.Gap),
      Diagnosis: typeof r.Diagnosis === "string" ? r.Diagnosis : null,
      isChampion: String(r.model) === championModel,
    }))
    .sort((a, b) => (b.R2 ?? -Infinity) - (a.R2 ?? -Infinity));

  return {
    summary: {
      totalPredictedNext7Days: Math.round(totalPredictedNext7Days),
      peakRiskDate: peak?.date ?? null,
      championModel,
    },
    daily,
    modelMetrics,
    featureImportance: (metadata.feature_importance as { feature: string; importance: number }[] | undefined) ?? [],
    modelInfo: {
      championModel,
      forecastHorizon: futurePreds.length,
      trainedAt: trainedAt ? new Date(trainedAt).toISOString() : null,
      metrics: (metadata.metrics as Record<string, unknown> | undefined) ?? null,
      scoredDays:
        (metadata.evaluation as { holdout_days?: number } | undefined)?.holdout_days ?? null,
    },
  };
}

export async function getIncidentPredictiveFromDb(): Promise<IncidentPredictiveResult | null> {
  if (!db) return null;
  try {
    const metaRes = await db.query(
      `SELECT metadata_json, created_at FROM ml_training_metadata ORDER BY created_at DESC LIMIT 1`
    );
    if (metaRes.rows.length === 0) return null;

    const [actualsRes, predsRes] = await Promise.all([
      db.query<DailyActualRow>(`SELECT d::text AS date, total FROM ml_daily_actuals ORDER BY d ASC`),
      db.query<PredictiveIncidentRow>(
        `SELECT forecast_date::text AS date, prediction_type, predicted_incident_count, champion_model,
                same_day_last_year, rainfall_mm, ${INCIDENT_MODELS.map((m) => m.column).join(", ")}
         FROM ml_predictive_incidents ORDER BY forecast_date ASC`
      ),
    ]);

    return buildIncidentPredictiveResponse(actualsRes.rows, predsRes.rows, metaRes.rows[0].metadata_json ?? {}, metaRes.rows[0].created_at);
  } catch (error) {
    console.error("Failed to fetch ML incident forecast:", error);
    return null;
  }
}
