import { z } from "zod";

export const TrafficQuerySchema = z.object({
  direction: z.enum(["NB", "SB"]).optional(),
});

export const IncidentQuerySchema = z.object({
  activeOnly: z.enum(["true", "false"]).optional(),
});

export const ForecastQuerySchema = z.object({
  horizon: z.enum(["30m", "60m", "2h"]).optional().default("30m"),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const AnalyticsQuerySchema = z.object({
  months: z.enum(["3", "12", "all"]).optional().default("12"),
  from: isoDate.optional(), // custom range start — with `to`, overrides months
  to: isoDate.optional(),
  plazas: z.string().optional(), // comma-separated plaza names
  direction: z.enum(["NB", "SB"]).optional(),
  vehicleClass: z.enum(["Class 1", "Class 2", "Class 3"]).optional(),
});

// Response Schemas for Documentation and Type Checking
export const RealtimeTrafficSchema = z.object({
  segmentId: z.string(),
  name: z.string(),
  direction: z.enum(["NB", "SB"]),
  status: z.enum(["Light", "Moderate", "Heavy", "Severe"]),
  avgSpeedKmh: z.number(),
  volumePerMin: z.number(),
  lastUpdated: z.string(),
});

export const IncidentSchema = z.object({
  incidentId: z.string(),
  type: z.string(),
  kmMarker: z.number(),
  direction: z.enum(["NB", "SB"]),
  severity: z.enum(["Low", "Medium", "High", "Critical"]),
  reportedAt: z.string(),
});

export const ForecastSchema = z.object({
  horizon: z.string(),
  mlConfidence: z.number(),
  segments: z.array(
    z.object({
      segmentId: z.string(),
      predictedCongestion: z.enum(["Low", "Medium", "High"]),
      estimatedTravelTimeMins: z.number(),
    })
  ),
});
