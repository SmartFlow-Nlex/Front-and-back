import type { Request, Response } from "express";
import {
  createMaintenanceScheduleInDb,
  getMaintenanceSchedulesFromDb,
  updateMaintenanceScheduleInDb,
  updateMaintenanceStatusInDb,
  deleteMaintenanceScheduleInDb,
} from "../services/maintenance.service.js";
import {
  MaintenanceScheduleSchema,
  MaintenanceStatusSchema,
  MaintenanceListQuerySchema,
} from "../validators/maintenance.validator.js";
import { saveAuditEventInDb } from "../services/audit-log.service.js";

// Fire-and-forget audit entry; never blocks or fails the actual operation.
const audit = (req: Request, action: string, targetId: string, details: Record<string, unknown>) => {
  void saveAuditEventInDb({
    user_id: req.header("x-user") ?? "dashboard",
    action,
    target_resource: `maintenance:${targetId}`,
    details,
  });
};

// NOTE: these endpoints are also consumed by the mobile app — no mock fallbacks;
// a database failure must surface as an error, never as fake success.

// POST /api/maintenance/schedule
export const createSchedule = async (req: Request, res: Response) => {
  const parsed = MaintenanceScheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? "Invalid parameters" });
  }

  const dbRow = await createMaintenanceScheduleInDb(parsed.data);
  if (!dbRow) {
    return res.status(503).json({ success: false, message: "Could not save schedule: database not reachable" });
  }
  audit(req, "maintenance.schedule_created", dbRow.id, {
    title: parsed.data.title,
    startKm: parsed.data.startKm,
    endKm: parsed.data.endKm,
    direction: parsed.data.direction,
    startsAt: parsed.data.startsAt,
    endsAt: parsed.data.endsAt,
  });
  res.status(201).json({ success: true, source: "database", data: dbRow });
};

// GET /api/maintenance/list?status=scheduled|in_progress|completed|cancelled|all
export const listSchedules = async (req: Request, res: Response) => {
  const query = MaintenanceListQuerySchema.parse(req.query);
  const dbRows = await getMaintenanceSchedulesFromDb(query.status);
  if (!dbRows) {
    return res.status(503).json({ success: false, message: "Could not load schedules: database not reachable" });
  }
  res.json({ success: true, source: "database", data: dbRows });
};

// PUT /api/maintenance/:id — edit a schedule's details (full replace)
export const updateSchedule = async (req: Request, res: Response) => {
  const parsed = MaintenanceScheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? "Invalid parameters" });
  }

  const result = await updateMaintenanceScheduleInDb(req.params.id, parsed.data);
  if (!result) {
    return res.status(503).json({ success: false, message: "Could not update schedule: database not reachable" });
  }
  if ("error" in result) {
    return res.status(404).json({ success: false, message: "Schedule not found" });
  }
  audit(req, "maintenance.schedule_edited", req.params.id, {
    title: parsed.data.title,
    startKm: parsed.data.startKm,
    endKm: parsed.data.endKm,
    startsAt: parsed.data.startsAt,
    endsAt: parsed.data.endsAt,
  });
  res.json({ success: true, source: "database", data: result.row });
};

// PATCH /api/maintenance/:id/status
export const updateScheduleStatus = async (req: Request, res: Response) => {
  const parsed = MaintenanceStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? "Invalid parameters" });
  }

  const result = await updateMaintenanceStatusInDb(req.params.id, parsed.data.status, parsed.data.reason);
  if (!result) {
    return res.status(503).json({ success: false, message: "Could not update status: database not reachable" });
  }
  if ("error" in result) {
    if (result.error === "not_found") {
      return res.status(404).json({ success: false, message: "Schedule not found" });
    }
    const from = "from" in result && result.from ? String(result.from) : "";
    const toLabel = parsed.data.status.replace("_", " ");
    return res.status(409).json({
      success: false,
      message:
        from === parsed.data.status
          ? `This schedule is already ${toLabel}`
          : `A ${from.replace("_", " ") || "finished"} schedule can no longer be changed to ${toLabel}`,
    });
  }
  audit(req, "maintenance.status_changed", req.params.id, {
    to: parsed.data.status,
    title: result.row.title,
    ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
  });
  res.json({ success: true, source: "database", data: result.row });
};

// DELETE /api/maintenance/:id
export const deleteSchedule = async (req: Request, res: Response) => {
  const success = await deleteMaintenanceScheduleInDb(req.params.id);
  if (!success) {
    return res.status(503).json({ success: false, message: "Could not delete schedule: database not reachable" });
  }
  audit(req, "maintenance.schedule_deleted", req.params.id, {});
  res.json({ success: true, source: "database", message: "Deleted" });
};
