import { z } from "zod";

/** A full entry, for trusted writers (the authenticated /event endpoint). The user comes from the token, not from here. */
export const AuditEventSchema = z.object({
  user_id: z.string().min(1).optional(),
  action: z.string().min(1).max(80),
  target_resource: z.string().max(200).optional(),
  module: z.string().max(40).optional(),
  entity_type: z.string().max(40).optional(),
  entity_id: z.string().max(120).optional(),
  from_status: z.string().max(40).optional(),
  to_status: z.string().max(40).optional(),
  outcome: z.string().max(40).optional(),
  duration_ms: z.number().int().min(0).optional(),
  details: z.any().optional(),
});

/**
 * What any page may report about itself, signed in or not. A short allow-list,
 * so a page can say "this was viewed" or "I exported" but can never write an
 * entry that claims a data change ("upload.loaded"): those are recorded by the
 * backend itself, where the change happens.
 */
export const ActivitySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page.viewed"), path: z.string().regex(/^\/[A-Za-z0-9/_-]{0,120}$/) }),
  z.object({ type: z.literal("session.login") }),
  z.object({ type: z.literal("session.logout") }),
  z.object({ type: z.literal("audit.exported"), rows: z.number().int().min(0).max(1_000_000), format: z.enum(["json", "csv"]) }),
]);

export const AuditQuerySchema = z.object({
  user_id: z.string().optional(),
  action: z.string().optional(),
  module: z.string().optional(),
  /** Page views are left out of the list unless asked for: they would bury every other entry. */
  include_views: z.enum(["0", "1"]).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
});

export const AuditSummarySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});
