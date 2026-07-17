import { z } from "zod";

export const MAINTENANCE_STATUSES = ["scheduled", "in_progress", "completed", "cancelled"] as const;
export const MAINTENANCE_DIRECTIONS = ["NB", "SB", "Both"] as const;
export const MAINTENANCE_LANE_CLOSURES = ["None", "Shoulder only", "1 lane", "2 lanes", "Full closure"] as const;

// POST /api/maintenance/schedule — consumed by the dashboard AND the mobile app;
// keep this shape stable.
export const MaintenanceScheduleSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    description: z.string().trim().max(2000).optional(),
    startKm: z.number().min(0).max(100),
    endKm: z.number().min(0).max(100),
    direction: z.enum(MAINTENANCE_DIRECTIONS).default("Both"),
    laneClosure: z.enum(MAINTENANCE_LANE_CLOSURES).default("Shoulder only"),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  });

// PATCH /api/maintenance/:id/status
export const MaintenanceStatusSchema = z
  .object({
    status: z.enum(MAINTENANCE_STATUSES),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.status !== "cancelled" || (v.reason && v.reason.length > 0), {
    message: "A reason is required when cancelling",
    path: ["reason"],
  });

export const MaintenanceListQuerySchema = z.object({
  status: z.enum([...MAINTENANCE_STATUSES, "all"]).optional().default("all"),
});
