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
 * POST /api/ai-insight/ranking-narrative
 *
 * Shared by the incident tab's two ranked-list cards -- Predicted Incidents
 * Ranking and Secondary Incident Risk -- because both reduce to the same
 * shape (a location label + one magnitude + an optional evidence count),
 * unlike model-narrative/congestion-narrative/event-surge-narrative, which
 * are genuinely different error/accuracy/uplift measures and need their own
 * prompts. What the magnitude actually MEANS travels with the request
 * (metricLabel/metricUnit/metricDescription) instead of being assumed, so
 * this one route can't accidentally describe a risk probability as an
 * incident count or vice versa.
 */
export const RankingNarrativeSchema = z.object({
  cardTitle: z.string().min(1).max(120),
  groupBy: z.enum(["exit", "segment"]),
  metricLabel: z.string().min(1).max(60),
  metricUnit: z.enum(["count", "percent"]),
  metricDescription: z.string().min(1).max(400),
  horizonDays: z.number().int().min(1).max(365).nullable().optional(),
  totalLabel: z.string().max(120).nullable().optional(),
  // Capped at 30: the largest corridor grouping in the system is ~20
  // segments/exits, so anything beyond this is a malformed client rather
  // than a real ranking, and each row costs prompt tokens.
  rows: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        value: z.number(),
        sharePct: z.number().min(0).max(100).nullable().optional(),
        n: z.number().int().nonnegative().nullable().optional(),
      }),
    )
    .min(1)
    .max(30),
});
