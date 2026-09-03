import { z } from "zod";

export const IncidentQuerySchema = z.object({
  status: z.enum(["active", "resolved", "all"]).optional().default("active"),
  type: z.string().optional()
});

export const WeatherCorrelationQuerySchema = z.object({
  weather_condition: z.string().optional()
});

// ---------------------------------------------------------------------------
// Predictive tab (Incident → Predictive Analytics)
// ---------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const IncidentPredictiveWeatherSchema = z.enum(["all", "dry", "wet"]);
export const IncidentPredictiveMonthsSchema = z.enum(["3", "12", "all"]);
export const IncidentModelKeySchema = z.enum([
  "XGBoost",
  "RandomForest",
  "LSTM",
  "GRU",
  "Poisson_GLM",
  "NegBinomial_GLM",
  "SARIMAX",
]);

export type IncidentPredictiveDataBounds = { minDate: string; maxDate: string };

/**
 * Request schema is built per-request rather than module-level because
 * `from`/`to` are refined against live data bounds (earliest observed date,
 * latest forecast date) that only the DB knows. A static schema can't express
 * that. Bookmarked URLs and direct API calls bypass any client-side date
 * picker restriction, so this check has to live here, not just in the UI.
 */
export function buildIncidentPredictiveQuerySchema(bounds: IncidentPredictiveDataBounds) {
  return z
    .object({
      months: IncidentPredictiveMonthsSchema.optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      weather: IncidentPredictiveWeatherSchema.optional().default("all"),
      // Volume/Weather toggle state — which trained variant (primary /
      // volume-free / weather-free) the chart and its metrics table are
      // showing. Distinct from `weather` above (the wet/dry accuracy split).
      volumeToggle: z.enum(["on", "off"]).optional().default("on"),
      weatherToggle: z.enum(["on", "off"]).optional().default("on"),
      // The chart's Future control (1wk/2wk/1mo) — syncs corridorForecast's
      // total to the same window the chart itself is currently drawing.
      // Absent means "the whole published horizon".
      futureDays: z.coerce.number().int().positive().optional(),
      // The Models toolbar's first active pill — which model corridorForecast
      // apportions. Absent (or a model with no stored data) falls back to the
      // champion, same as before this existed.
      forecastModel: IncidentModelKeySchema.optional(),
    })
    .refine((q) => !q.from || !q.to || q.from < q.to, {
      message: "`from` must be earlier than `to`",
      path: ["from"],
    })
    .refine((q) => !q.from || q.from >= bounds.minDate, {
      message: `\`from\` cannot be earlier than the earliest available data (${bounds.minDate})`,
      path: ["from"],
    })
    .refine((q) => !q.to || q.to <= bounds.maxDate, {
      message: `\`to\` cannot be later than the latest available data (${bounds.maxDate})`,
      path: ["to"],
    });
}

export type IncidentPredictiveQuery = z.infer<ReturnType<typeof buildIncidentPredictiveQuerySchema>>;

const IncidentPredictiveDailyPointSchema = z.object({
  date: isoDate,
  actual: z.number().nullable(),
  predicted: z.number().nullable(),
  // "train" = in-sample fitted values over the training period. Accepted so a
  // backfill of past predictions (which gives the hourly drill-down model
  // curves on a past day) does not fail this schema and 500 the whole endpoint.
  // The daily chart still draws model lines for validation/future only.
  predictionType: z.enum(["train", "validation", "future"]).nullable(),
  sameDayLastYear: z.number().nullable(),
  rainfallMm: z.number().nullable(),
  isWet: z.boolean().nullable(),
  /**
   * Daily vehicle volume — observed where the warehouse has it, the traffic
   * module's forecast across the Future band. Null on uncovered days so the
   * chart's exposure overlay breaks instead of drawing a misleading zero.
   */
  volume: z.number().nullable().optional(),
  models: z.record(z.string(), z.number().nullable()),
  /**
   * The same models refit without the volume features. Present only when the
   * pipeline stored a volume-free twin, which is what lets the dashboard's
   * Volume toggle switch the forecast rather than only the overlay.
   */
  modelsNoVolume: z.record(z.string(), z.number().nullable()).optional(),
  /**
   * The same models refit without rain_mm. Present only when the pipeline
   * stored a weather-free twin, which is what lets the dashboard's Weather
   * toggle switch the forecast rather than only the rainfall overlay.
   */
  modelsNoWeather: z.record(z.string(), z.number().nullable()).optional(),
});

const IncidentModelMetricSchema = z.object({
  model: z.string(),
  MAE: z.number().nullable(),
  RMSE: z.number().nullable(),
  WMAPE: z.number().nullable(),
  MASE: z.number().nullable(),
  R2: z.number().nullable(),
  Adjusted_R2: z.number().nullable(),
  Train_R2: z.number().nullable(),
  Gap: z.number().nullable(),
  Diagnosis: z.string().nullable(),
  isChampion: z.boolean(),
  // "window": computed live from the rows inside the resolved Range/Weather
  // slice. "holdout": that slice had zero scored rows, so this row falls back
  // to the pipeline's full-holdout numbers from ml_training_metadata instead
  // of showing an empty row.
  source: z.enum(["window", "holdout"]),
  n: z.number().int().nonnegative(),
});

const IncidentPredictiveWeatherMetricsSchema = z
  .object({
    weather: IncidentPredictiveWeatherSchema,
    days: z.number().int().nonnegative(),
    models: z.array(
      z.object({
        model: z.string(),
        MAE: z.number(),
        RMSE: z.number(),
        R2: z.number().nullable(),
        isChampion: z.boolean(),
      })
    ),
  })
  .nullable();

export const IncidentPredictiveResponseSchema = z.object({
  summary: z.object({
    totalPredictedNext7Days: z.number(),
    peakRiskDate: isoDate.nullable(),
    championModel: z.string().nullable(),
  }),
  daily: z.array(IncidentPredictiveDailyPointSchema),
  modelMetrics: z.array(IncidentModelMetricSchema),
  featureImportance: z.array(z.object({ feature: z.string(), importance: z.number() })),
  modelInfo: z.object({
    championModel: z.string().nullable(),
    forecastHorizon: z.number().int().nonnegative(),
    trainedAt: z.string().nullable(),
    metrics: z.record(z.string(), z.unknown()).nullable(),
    scoredDays: z.number().nullable(),
  }),
  weatherMetrics: IncidentPredictiveWeatherMetricsSchema,
  /**
   * Predicted incidents per exit/corridor, for the "predicted incidents by
   * exit" card. This is an APPORTIONMENT of summary.totalPredictedNext7Days
   * by each exit's historical share of incidents in the current Range — there
   * is no separately trained per-location model behind it. Null when the
   * corridor's exit list or usable location data wasn't available to build it.
   */
  corridorForecast: z
    .array(
      z.object({
        exitId: z.number().int(),
        exitName: z.string(),
        km: z.number(),
        historicalCount: z.number().int().nonnegative(),
        historicalShare: z.number().min(0).max(1),
        predictedIncidents: z.number().nonnegative(),
      })
    )
    .nullable(),
  // Fraction of the Range's incidents whose location text matched neither a
  // km figure nor a known exit name — so the corridor card can disclose its
  // own coverage instead of silently pretending every incident was placed.
  unclassifiedLocationShare: z.number().min(0).max(1).nullable(),
  // How many of the published future days corridorForecast was apportioned
  // over — echoes the request's futureDays (clamped to what's actually
  // published), so the card can label its axis honestly even if the chart's
  // Future control and this total were ever to disagree.
  corridorForecastDays: z.number().int().nonnegative(),
  // Which model corridorForecast was actually apportioned from — echoes a
  // valid request's forecastModel, or the champion when that was absent/
  // invalid/unavailable, so the card can label its basis honestly rather than
  // assuming the toolbar's selection and this total agree. Null only when
  // corridorForecast itself is null (nothing was computed).
  corridorForecastModel: z.string().nullable(),
  // The row set every "window"-sourced row in modelMetrics was actually
  // scored against — for the metrics card's caption. Null exactly when every
  // model fell back to source:"holdout" (nothing to score against).
  scoringWindow: z.object({ start: isoDate, end: isoDate, n: z.number().int().positive() }).nullable(),
  // True iff scoringWindow !== null — whether the Weather control has any
  // scored rows to filter for the current Range. The frontend uses this to
  // disable the Weather chips rather than let them refetch to an identical
  // holdout-fallback row every time.
  weatherApplicable: z.boolean(),
  // Earliest observed date and latest forecast date across the whole series
  // (not the resolved window) — the frontend uses this to cap the custom date
  // picker so the user can't pick a "to" beyond what the model actually covers.
  dataBounds: z.object({ minDate: isoDate, maxDate: isoDate }),
  // The resolved Past/Present/Future band boundaries for THIS request's
  // window, echoed back so the chart positions markAreas from these exact
  // values instead of re-deriving them from `daily`. validationStart/
  // futureStart are nullable — a pipeline that has never scored a holdout (or
  // never produced a forecast) has nothing to report there.
  windowBounds: z.object({
    windowStart: isoDate,
    validationStart: isoDate.nullable(),
    futureStart: isoDate.nullable(),
    windowEnd: isoDate,
  }),
  appliedFilters: z.object({
    months: IncidentPredictiveMonthsSchema.nullable(),
    weather: IncidentPredictiveWeatherSchema,
    contextFrom: isoDate.nullable(),
    contextTo: isoDate.nullable(),
  }),
});

export type IncidentPredictiveResult = z.infer<typeof IncidentPredictiveResponseSchema>;

// ---------------------------------------------------------------------------
// Feature-evidence panels — "Does weather predict incidents?" / "Does traffic
// volume predict incidents?" Same response shape for both (correlations +
// modelComparison), so one Zod schema and one frontend component cover both.
// The traffic module's own equivalent endpoint (weather-evidence) has no Zod
// schema at all; this one is validated to match the rest of the incident
// module's established convention instead.
// ---------------------------------------------------------------------------

export const IncidentFeatureEvidenceResponseSchema = z.object({
  correlations: z.array(
    z.object({
      variable: z.string(),
      label: z.string(),
      pearson: z.number().nullable(),
      spearman: z.number().nullable(),
      days: z.number().int().nonnegative(),
    })
  ),
  modelComparison: z.array(
    z.object({
      model: z.string(),
      withFeature: z.number().nullable(),
      withoutFeature: z.number().nullable(),
      deltaPts: z.number().nullable(),
    })
  ),
});

export type IncidentFeatureEvidenceResult = z.infer<typeof IncidentFeatureEvidenceResponseSchema>;
