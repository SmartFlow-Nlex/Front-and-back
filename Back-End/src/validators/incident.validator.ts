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
  // Future rows only: the traffic module's volume forecast, the input the volume-aware models read (17 Oct 2026).
  volumeForecast: z.number().nullable().optional(),
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
    trainedDays: z.number().nullable(),
  }),
  weatherMetrics: IncidentPredictiveWeatherMetricsSchema,
  /** Every model scored over only the dry, and only the wet, holdout days (always present). */
  weatherSplit: z
    .object({
      dry: z.object({ days: z.number().int().nonnegative(), models: z.array(z.object({ model: z.string(), MAE: z.number(), RMSE: z.number(), R2: z.number().nullable(), isChampion: z.boolean() })) }),
      wet: z.object({ days: z.number().int().nonnegative(), models: z.array(z.object({ model: z.string(), MAE: z.number(), RMSE: z.number(), R2: z.number().nullable(), isChampion: z.boolean() })) }),
    })
    .optional(),
  /**
   * Legacy-source APPORTIONMENT of summary.totalPredictedNext7Days by each
   * exit's historical share of incidents in the current Range — no trained
   * per-location model behind it. No longer what the Predictive tab's Corridor
   * forecast card shows (that reads /api/incident/spatial); kept because
   * VmsAdvisoryPanel/PrescriptiveDeploymentPanel on the Prescriptive tab read
   * it. Null when the exit list or usable location data wasn't available.
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
  // Same apportionment as corridorForecast, grouped by exit-to-exit segments.
  // Null under the identical conditions corridorForecast is.
  kmSegmentForecast: z
    .array(
      z.object({
        segmentStart: z.number().nonnegative(),
        segmentEnd: z.number().nonnegative(),
        label: z.string(),
        historicalCount: z.number().int().nonnegative(),
        historicalShare: z.number().min(0).max(1),
        predictedIncidents: z.number().nonnegative(),
      })
    )
    .nullable(),
  // Fraction of the Range's incidents whose location text matched neither a
  // km figure nor a known exit name.
  unclassifiedLocationShare: z.number().min(0).max(1).nullable(),
  // How many published future days corridorForecast was apportioned over.
  corridorForecastDays: z.number().int().nonnegative(),
  // The logged-incident window corridorForecast's per-exit shares were counted over (17 Oct 2026).
  corridorShareWindow: z.object({ from: isoDate, to: isoDate.nullable() }).nullable().optional(),
  // Which model corridorForecast was apportioned from (always the champion
  // now). Null only when corridorForecast itself is null.
  corridorForecastModel: z.string().nullable(),
  /**
   * Dedicated accident-only forecast (train_incident_models.py --series
   * accident), alongside the blended one. Null until that series has been
   * trained, and null on any read failure — the blended chart must never
   * depend on it. Breakdowns are deliberately NOT a series here: a dedicated
   * breakdown model measured no better than the blended fit, so the client
   * derives them as blended total minus this accident forecast.
   */
  accidentSplit: z
    .object({
      championModel: z.string().nullable(),
      trainedAt: z.string().nullable(),
      metrics: z.record(z.string(), z.unknown()).nullable(),
      daily: z.array(
        z.object({
          date: isoDate,
          actual: z.number().nullable(),
          predicted: z.number().nullable(),
        })
      ),
    })
    .nullable(),
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
  /**
   * How the champion's error grows with how far ahead a day was — a separate
   * rolling-origin study (measure_incident_horizon_accuracy.py), not derived
   * from modelInfo.metrics, which is one-step-ahead only (see that script's
   * own doc comment). Empty array, not null, when the study hasn't been run
   * yet — the Future control still works, it just can't quote a bucketed
   * error figure until this exists. Mirrors traffic's own
   * HorizonAccuracy/gold.ml_horizon_accuracy exactly, one schema short of it
   * only in that there is no "target" dimension (this pipeline has one
   * series, not several).
   */
  horizonAccuracy: z.array(
    z.object({
      model: z.string(),
      hLo: z.number().int().positive(),
      hHi: z.number().int().positive(),
      n: z.number().int().nonnegative(),
      wmape: z.number().nullable(),
      mape: z.number().nullable(),
      mase: z.number().nullable(),
      mae: z.number().nullable(),
      baselineWmape: z.number().nullable(),
      usable: z.boolean(),
      note: z.string().nullable(),
    })
  ),
});

export type IncidentPredictiveResult = z.infer<typeof IncidentPredictiveResponseSchema>;

// ---------------------------------------------------------------------------
// Prescriptive tab (Incident → Clearance Response Protocol)
// ---------------------------------------------------------------------------

export const ClearanceProtocolQuerySchema = z.object({
  type: z.enum(["accident", "breakdown"]).optional().default("accident"),
  // PDO-dominated pooled curves are misleading for an escalation decision, so
  // this defaults to "injury" rather than "all" — see the panel's own hint.
  // Ignored entirely when type=breakdown (no severity column on that table).
  severity: z.enum(["all", "pdo", "injury", "fatal"]).optional().default("injury"),
  weather: IncidentPredictiveWeatherSchema.optional().default("all"),
  months: IncidentPredictiveMonthsSchema.optional().default("12"),
  from: isoDate.optional(),
  to: isoDate.optional(),
  // Data only since 2 Nov 2026: maxUnits, unitCostPerHour, delayCostPerVehHour, unitEffect, demandLevel and
  // deltaResponseMin were the MILP's assumed inputs and are gone. An old link that still sends them is not
  // rejected; zod drops unknown keys.
});
export type ClearanceProtocolQuery = z.infer<typeof ClearanceProtocolQuerySchema>;

const ChanceSchema = z.object({ p: z.number(), lo: z.number(), hi: z.number() });

export const ClearanceProtocolResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    rule: z.object({
      checkAtMinute: z.number(),
      pastMinute: z.number(),
      chance: ChanceSchema,
      openAtCheck: z.number().int(),
      text: z.string(),
    }),
    checkpoints: z.array(
      z.object({
        label: z.enum(["P25", "P50", "P80"]),
        minute: z.number(),
        stillOpen: z.number(),
        openCount: z.number().int(),
        medianRemainingMin: z.number().nullable(),
        pastP95: ChanceSchema,
      }),
    ),
    survivalCurve: z.array(z.object({ minute: z.number(), survival: z.number(), atRisk: z.number().int() })),
    quantiles: z.object({ p50: z.number(), p80: z.number(), p95: z.number() }),
    kpi: z.object({
      baselineMttr: z.number(),
      rag: z.enum(["green", "amber", "red"]),
      targets: z.object({ greenMax: z.number(), amberMax: z.number() }),
      metricLabel: z.string(),
      indicative: z.boolean(),
    }),
    method: z.array(z.string()),
    scoringWindow: z.object({ from: z.string(), to: z.string() }),
    sampleSize: z.number().int(),
    censoredCount: z.number().int(),
  }),
  z.object({
    status: z.literal("insufficient_data"),
    sampleSize: z.number().int(),
    scoringWindow: z.object({ from: z.string(), to: z.string() }),
    message: z.string(),
  }),
]);
export type ClearanceProtocolResult = z.infer<typeof ClearanceProtocolResponseSchema>;
