import { z } from "zod";

export const AuditEventSchema = z.object({
  user_id: z.string().min(1),
  action: z.string().min(1),
  target_resource: z.string().optional(),
  details: z.record(z.unknown()).optional(),
  severity: z.enum(["info", "warning", "critical"]).optional().default("info"),
  module: z.string().optional(),
  previous_status: z.string().optional(),
  new_status: z.string().optional(),
});

export const AuditQuerySchema = z.object({
  user_id: z.string().optional(),
  action: z.string().optional(),
  module: z.string().optional(),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});
