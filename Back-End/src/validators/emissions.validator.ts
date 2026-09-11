import { z } from "zod";

export const EmissionsQuerySchema = z.object({
  timeframe: z.enum(["daily", "weekly", "monthly"]).optional().default("daily"),
});
