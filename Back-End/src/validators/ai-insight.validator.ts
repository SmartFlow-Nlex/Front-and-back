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
