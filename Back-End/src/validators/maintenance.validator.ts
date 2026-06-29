import { z } from "zod";

export const MaintenanceScheduleSchema = z.object({
  segmentId: z.string().min(1),
  description: z.string().min(1),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
});
