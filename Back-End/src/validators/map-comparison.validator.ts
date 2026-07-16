import { z } from "zod";

export const MapCompQuerySchema = z.object({
  source: z.enum(["waze", "ai", "sensor"]).optional(),
});

export const ExitSearchSchema = z.object({
  query: z.string().min(1)
});
