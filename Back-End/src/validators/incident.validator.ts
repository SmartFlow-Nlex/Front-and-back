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
  models: z.record(z.string(), z.number().nullable()),
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
