import type { Request, Response } from "express";
import { createMaintenanceScheduleInDb, getMaintenanceSchedulesFromDb, deleteMaintenanceScheduleInDb } from "../services/maintenance.service.js";
import { MaintenanceScheduleSchema } from "../validators/maintenance.validator.js";

// [DEV-01] POST /api/v1/maintenance/schedule
export const createSchedule = async (req: Request, res: Response) => {
  const parsed = MaintenanceScheduleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid parameters" });

  const dbRow = await createMaintenanceScheduleInDb(parsed.data);
  if (dbRow) {
    return res.json({ success: true, source: "database", data: dbRow });
  }

  res.json({ success: true, source: "mock", data: { id: 999, ...parsed.data, status: "scheduled" } });
};

// [DEV-02] GET /api/v1/maintenance/list
export const listSchedules = async (_req: Request, res: Response) => {
  const dbRows = await getMaintenanceSchedulesFromDb();
  if (dbRows) {
    return res.json({ success: true, source: "database", data: dbRows });
  }

  res.json({ success: true, source: "mock", data: [
    { id: 1, segment_id: "NB-01", description: "Pothole repair", status: "scheduled" }
  ]});
};

// [DEV-03] DELETE /api/v1/maintenance/:id
export const deleteSchedule = async (req: Request, res: Response) => {
  const success = await deleteMaintenanceScheduleInDb(req.params.id);
  if (success) {
    return res.json({ success: true, source: "database", message: "Deleted" });
  }

  res.json({ success: true, source: "mock", message: `Mock deleted schedule ${req.params.id}` });
};
