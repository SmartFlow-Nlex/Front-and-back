import { z } from "zod";

export const IncidentQuerySchema = z.object({
  status: z.enum(["active", "resolved", "all"]).optional().default("active"),
  type: z.string().optional()
});

export const WeatherCorrelationQuerySchema = z.object({
  weather_condition: z.string().optional()
});
