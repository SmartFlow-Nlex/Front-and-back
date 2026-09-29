import { z } from "zod";

/**
 * POST /api/ai-insight/model-narrative
 *
 * The metric rows come from the client because the dashboard has already
 * filtered them to the window, weather variant and model selection the reader
 * is looking at. Re-deriving that server-side would mean the prose could
 * describe a different slice than the chart above it.
 */
const MetricRowSchema = z.object({
  model: z.string().min(1).max(80),
  wmape: z.number().nullable().optional(),
  mae: z.number().nullable().optional(),
  rmse: z.number().nullable().optional(),
  r2: z.number().nullable().optional(),
  mase: z.number().nullable().optional(),
  rank: z.number().nullable().optional(),
  accepted: z.boolean().nullable().optional(),
  rejectedReason: z.string().max(400).nullable().optional(),
  diagnosis: z.string().max(400).nullable().optional(),
});

export const ModelNarrativeSchema = z.object({
  quantity: z.enum(["volume", "incidents", "emissions"]),
  // Capped at 12: the largest roster in the system is the incident module's
  // seven, so anything beyond this is a malformed client rather than a real
  // selection, and each row costs prompt tokens.
  metrics: z.array(MetricRowSchema).min(1).max(12),
  horizonDays: z.number().int().min(1).max(365),
  scoredDays: z.number().int().nullable().optional(),
  windowStart: z.string().max(40).nullable().optional(),
  windowEnd: z.string().max(40).nullable().optional(),
  weatherMode: z.enum(["with", "without"]).nullable().optional(),
});

/**
 * POST /api/ai-insight/congestion-narrative
 *
 * The congestion model is a CLASSIFIER, not a forecaster of a quantity: it
 * labels each exit-hour Clear / Heavy / Severe and is scored by accuracy
 * against a "nothing changes" benchmark, per hour ahead. None of the error
 * measures the model-narrative endpoint reasons about (WMAPE, MASE, R2) apply,
 * so it gets its own schema and its own prompt rather than having accuracy
 * squeezed into a field that means something else.
 */
export const CongestionNarrativeSchema = z.object({
  models: z
    .array(
      z.object({
        model: z.string().min(1).max(80),
        accuracy: z.number().min(0).max(1).nullable().optional(),
        accepted: z.boolean().nullable().optional(),
        rejectedReason: z.string().max(400).nullable().optional(),
      }),
    )
    .min(1)
    .max(8),
  baseline: z
    .object({ model: z.string().min(1).max(80), accuracy: z.number().min(0).max(1).nullable() })
    .nullable()
    .optional(),
  // One row per hour ahead. Capped at 24: the served map covers 12.
  horizons: z
    .array(
      z.object({
        horizon: z.number().int().min(1).max(24),
        accuracy: z.number().min(0).max(1).nullable(),
        persistence: z.number().min(0).max(1).nullable(),
        n: z.number().int().nonnegative().nullable().optional(),
      }),
    )
    .max(24)
    .optional(),
  /** What the map currently shows, so the read-out can speak to it. */
  situation: z
    .object({
      exitsTotal: z.number().int().min(0).max(200),
      exitsSevere: z.number().int().min(0).max(200),
      hoursCovered: z.number().int().min(1).max(24),
      neverPredictsHeavy: z.boolean().optional(),
    })
    .optional(),
});

/**
 * POST /api/ai-insight/event-surge-narrative
 *
 * The event-surge card does not forecast a time series: it estimates an UPLIFT
 * — how much more traffic an exit takes on a Philippine Arena event day than on
 * a matched normal day — fitted on earlier events and scored on later ones the
 * fit never saw. The honest benchmark is doing nothing at all ("ignoring the
 * event"), which is a row of its own rather than a seasonal-naive baseline. It
 * therefore gets its own schema and prompt.
 */
export const EventSurgeNarrativeSchema = z.object({
  models: z
    .array(
      z.object({
        model: z.string().min(1).max(80),
        wmape: z.number().min(0).max(1000).nullable().optional(),
        accepted: z.boolean().nullable().optional(),
        diagnosis: z.string().max(400).nullable().optional(),
      }),
    )
    .min(1)
    .max(8),
  /** The do-nothing benchmark: predict the normal day and ignore the event. */
  noAdjustment: z
    .object({ model: z.string().min(1).max(80), wmape: z.number().min(0).max(1000).nullable() })
    .nullable()
    .optional(),
  coverage: z
    .object({
      eventDays: z.number().int().min(0).max(10000).nullable().optional(),
      firstEvent: z.string().max(40).nullable().optional(),
      lastEvent: z.string().max(40).nullable().optional(),
    })
    .optional(),
  /** What the card is showing right now, so the read-out speaks to it. */
  situation: z
    .object({
      mode: z.enum(["observed", "upcoming"]),
      eventTitle: z.string().max(200).nullable().optional(),
      eventDate: z.string().max(40).nullable().optional(),
      venue: z.string().max(200).nullable().optional(),
      exitsMaterial: z.number().int().min(0).max(200),
      exitsTotal: z.number().int().min(0).max(200),
      totalAdded: z.number().min(0).max(10_000_000),
      upliftPct: z.number().min(-100).max(10000).nullable().optional(),
      topExit: z.string().max(120).nullable().optional(),
      topAdded: z.number().min(0).max(10_000_000).nullable().optional(),
      topSharePct: z.number().min(0).max(100).nullable().optional(),
      top2SharePct: z.number().min(0).max(100).nullable().optional(),
    })
    .optional(),
});

/**
 * POST /api/ai-insight/explain
 *
 * Unlike the narrative endpoint, no data is accepted from the client — only the
 * name of a feature. The service fetches its own rows so two callers cannot get
 * briefings describing different corridors.
 */
export const ExplainSchema = z.object({
  feature: z.enum([
    "overview",
    "traffic_analytics",
    "emissions_analytics",
    "corridor_status",
    "maintenance",
  ]),
  months: z.enum(["3", "12", "all"]).optional().default("12"),
});

/**
 * POST /api/ai-insight/incident-models-narrative
 *
 * The incident module's OTHER three models, which the forecast endpoint cannot
 * describe because none of them forecasts a quantity:
 *
 *   - a severity CLASSIFIER, scored by accuracy and by an ordinal MAE (how many
 *     severity steps out it lands when it is wrong — being one step out on a
 *     three-step scale is not the same as being two),
 *   - a Cox proportional-hazards clearance model, scored by CONCORDANCE INDEX
 *     (the share of incident pairs whose relative clearance order it gets
 *     right), which is not an error at all, and
 *   - a secondary-incident risk model, scored by AUC, which is only meaningful
 *     read against the base rate it is trying to beat.
 *
 * Three different scales, none of them WMAPE. Hence its own schema.
 */
export const IncidentModelsNarrativeSchema = z.object({
  severity: z.object({
    champion: z.string().min(1).max(80).nullable().optional(),
    models: z
      .array(
        z.object({
          model: z.string().min(1).max(80),
          accuracy: z.number().min(0).max(1).nullable().optional(),
          maeOrdinal: z.number().min(0).max(10).nullable().optional(),
          n: z.number().int().nonnegative().nullable().optional(),
        }),
      )
      .max(8)
      .optional(),
    breakdown: z
      .array(
        z.object({
          label: z.string().min(1).max(60),
          actualCount: z.number().int().nonnegative(),
          predictedCount: z.number().int().nonnegative(),
        }),
      )
      .max(8)
      .optional(),
  }),
  clearance: z
    .object({
      concordanceIndex: z.number().min(0).max(1).nullable().optional(),
      maeMinutes: z.number().min(0).max(100000).nullable().optional(),
      n: z.number().int().nonnegative().nullable().optional(),
      medianMin: z.number().min(0).max(100000).nullable().optional(),
      meanMin: z.number().min(0).max(100000).nullable().optional(),
    })
    .optional(),
  secondaryRisk: z
    .object({
      auc: z.number().min(0).max(1).nullable().optional(),
      baseRate: z.number().min(0).max(1).nullable().optional(),
      n: z.number().int().nonnegative().nullable().optional(),
      kmRadius: z.number().min(0).max(200).nullable().optional(),
      avgRisk: z.number().min(0).max(1).nullable().optional(),
    })
    .optional(),
  /** Worst few locations already on the operator's screen. Capped so the
   *  prompt stays short — the panel itself ranks the full list. */
  hotspots: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        km: z.number().nullable().optional(),
        n: z.number().int().nonnegative().nullable().optional(),
        avgRisk: z.number().min(0).max(1).nullable().optional(),
        actualSecondaryCount: z.number().int().nonnegative().nullable().optional(),
      }),
    )
    .max(8)
    .optional(),
});

/**
 * POST /api/ai-insight/clearance-narrative
 *
 * The "Time to Clear" survival curves. Not a forecast and not a classifier: a
 * distribution per incident type, read as "half of these are still blocking the
 * road after N minutes". The raw curve is ~100 points per group, which is both
 * too long for a prompt and the wrong shape to reason over, so the client sends
 * the derived per-group figures its own chart already computes.
 */
export const ClearanceNarrativeSchema = z.object({
  dimension: z.string().min(1).max(40),
  groups: z
    .array(
      z.object({
        group: z.string().min(1).max(80),
        n: z.number().int().nonnegative().nullable().optional(),
        medianMin: z.number().min(0).max(100000).nullable().optional(),
        /** Share still unresolved at the 60- and 120-minute marks. */
        stillOpen60: z.number().min(0).max(1).nullable().optional(),
        stillOpen120: z.number().min(0).max(1).nullable().optional(),
        isBaseline: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(10),
  trainedAt: z.string().max(40).nullable().optional(),
});

/**
 * POST /api/ai-insight/incident-priority-narrative
 *
 * The prescriptive cross: each incident type's measured median clearance time
 * against how many of that type are forecast, giving expected lane-minutes lost.
 * The dispatch package per tier is operational doctrine, not a model output, and
 * is labelled as such in the prompt so the reader is never told the system
 * predicted it.
 */
export const IncidentPriorityNarrativeSchema = z.object({
  horizonDays: z.number().int().min(1).max(365),
  totalPredicted: z.number().min(0).max(1000000).nullable().optional(),
  forecastModel: z.string().max(80).nullable().optional(),
  types: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        medianClearanceMin: z.number().min(0).max(100000).nullable().optional(),
        predictedCount: z.number().min(0).max(1000000).nullable().optional(),
        expectedLaneMinutes: z.number().min(0).max(100000000).nullable().optional(),
        sharePct: z.number().min(0).max(100).nullable().optional(),
        dispatch: z.string().max(200).nullable().optional(),
      }),
    )
    .min(1)
    .max(10),
});

/**
 * POST /api/ai-insight/corridor-risk-narrative
 *
 * Both halves are optional because the panel renders whichever of the two
 * spatial models has written output; the service rejects the case where
 * neither did, so an empty body cannot reach the model.
 */
export const CorridorRiskNarrativeSchema = z.object({
  gwr: z
    .object({
      bandwidth: z.number().min(0).max(100000).nullable().optional(),
      mae: z.number().min(0).max(100000).nullable().optional(),
      loocvMae: z.number().min(0).max(100000).nullable().optional(),
      loocvN: z.number().int().min(0).max(100000).nullable().optional(),
      poissonDeviance: z.number().min(0).max(1000000).nullable().optional(),
      n: z.number().int().min(0).max(100000).nullable().optional(),
      variables: z.array(z.string().max(80)).max(20).optional(),
      coefficients: z
        .array(
          z.object({
            exitName: z.string().min(1).max(120),
            km: z.number().min(-100).max(100000).nullable().optional(),
            variable: z.string().min(1).max(80),
            coefficient: z.number().min(-1000000).max(1000000),
            tValue: z.number().min(-100000).max(100000).nullable().optional(),
            significant: z.boolean().nullable().optional(),
          }),
        )
        .max(30)
        .optional(),
    })
    .nullable()
    .optional(),
  spatialLstm: z
    .object({
      mae: z.number().min(0).max(100000).nullable().optional(),
      poissonDeviance: z.number().min(0).max(1000000).nullable().optional(),
      n: z.number().int().min(0).max(10000000).nullable().optional(),
      epochs: z.number().int().min(0).max(100000).nullable().optional(),
      seqLen: z.number().int().min(0).max(10000).nullable().optional(),
      nNeighbors: z.number().int().min(0).max(1000).nullable().optional(),
      forecastDate: z.string().max(40).nullable().optional(),
      topExits: z
        .array(
          z.object({
            exitName: z.string().min(1).max(120),
            km: z.number().min(-100).max(100000).nullable().optional(),
            rank: z.number().int().min(1).max(10000),
            predictedIncidents: z.number().min(0).max(1000000),
            lastObservedCount: z.number().min(0).max(1000000).nullable().optional(),
          }),
        )
        .max(30)
        .optional(),
    })
    .nullable()
    .optional(),
  trainedAt: z.string().max(60).nullable().optional(),
});

/**
 * POST /api/ai-insight/high-incident-day-narrative
 *
 * The scenario curves are capped well above what the panel plots so a future
 * finer-grained curve does not start failing validation, but not so high that
 * an accidental full-history dump could be posted through here.
 */
export const HighIncidentDayNarrativeSchema = z.object({
  auc: z.number().min(0).max(1).nullable().optional(),
  baseRate: z.number().min(0).max(1).nullable().optional(),
  n: z.number().int().min(0).max(10000000).nullable().optional(),
  rainSignificant: z.boolean().nullable().optional(),
  rainPValue: z.number().min(0).max(1).nullable().optional(),
  topDriver: z
    .object({
      feature: z.string().min(1).max(80),
      effectSize: z.number().min(-1000000).max(1000000),
    })
    .nullable()
    .optional(),
  rainScenarios: z
    .array(
      z.object({
        rainMm: z.number().min(0).max(10000),
        probability: z.number().min(0).max(1),
      }),
    )
    .max(40)
    .optional(),
  volumeScenarios: z
    .array(
      z.object({
        volume: z.number().min(0).max(100000000),
        probability: z.number().min(0).max(1),
      }),
    )
    .max(40)
    .optional(),
  trainedAt: z.string().max(60).nullable().optional(),
});
