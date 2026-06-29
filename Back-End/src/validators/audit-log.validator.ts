import { z } from "zod";

export const AuditEventSchema = z.object({
  user_id: z.string().min(1),
  action: z.string().min(1),
  target_resource: z.string().optional(),
  details: z.any().optional()
});

export const AuditQuerySchema = z.object({
  user_id: z.string().optional(),
  action: z.string().optional(),
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional()
});
