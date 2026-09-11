import { z } from "zod";

export const MapCompQuerySchema = z.object({
  source: z.enum(["waze", "ai", "sensor"]).optional(),
});

// An absent or empty query lists the whole corridor, which is what the exit
// dropdown needs; a non-empty one filters.
export const ExitSearchSchema = z.object({
  query: z.string().optional().default("")
});
