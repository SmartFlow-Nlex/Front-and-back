import type { Request, Response } from "express";
import {
  saveAuditEventInDb,
  getAuditLogsFromDb,
  getAuditStatsFromDb,
} from "../services/audit-log.service.js";
import { AuditEventSchema, AuditQuerySchema } from "../validators/audit-log.validator.js";

// [DEV-01] POST /api/v1/audit-log/event
export const writeAuditEvent = async (req: Request, res: Response) => {
  const parsed = AuditEventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid parameters" });

  const dbRow = await saveAuditEventInDb(parsed.data);
  if (dbRow) {
    return res.json({ success: true, source: "database", data: dbRow });
  }

  res.json({ success: true, source: "mock", data: { id: 1, ...parsed.data, timestamp: new Date().toISOString() } });
};

// [DEV-02] GET /api/v1/audit-log/list
export const listAuditLogs = async (req: Request, res: Response) => {
  const parsed = AuditQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid filters" });

  const dbRows = await getAuditLogsFromDb(parsed.data);
  if (dbRows) {
    return res.json({ success: true, source: "database", data: dbRows });
  }

  res.json({ success: true, source: "mock", data: [
    { id: 1, user_id: "admin_01", action: "maintenance.schedule_created", target_resource: "maintenance:1", module: "maintenance", severity: "info", timestamp: new Date().toISOString(), details: { title: "Demo Schedule" } },
    { id: 2, user_id: "admin_01", action: "upload.file_received", target_resource: "upload:traffic_dataset.csv", module: "upload", severity: "info", timestamp: new Date().toISOString(), details: { filename: "traffic_dataset.csv", records: 5400 } },
    { id: 3, user_id: "admin_01", action: "ai.simulation_run", target_resource: "ai:SIM-DEMO01", module: "ai", severity: "info", timestamp: new Date().toISOString(), details: { simId: "SIM-DEMO01" } },
    { id: 4, user_id: "admin_01", action: "maintenance.status_changed", target_resource: "maintenance:1", module: "maintenance", severity: "warning", previous_status: "scheduled", new_status: "cancelled", timestamp: new Date().toISOString(), details: { title: "Demo Schedule", to: "cancelled", reason: "Weather" } },
  ]});
};

// [DEV-03] GET /api/v1/audit-log/export
export const exportAuditLogs = async (req: Request, res: Response) => {
  const parsed = AuditQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid filters" });

  const dbRows = await getAuditLogsFromDb({ ...parsed.data, limit: 500 });
  const dataToExport = dbRows ?? [{ id: 1, action: "mock_export_event" }];

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="audit_export_${new Date().toISOString().split("T")[0]}.json"`);
  res.send(JSON.stringify(dataToExport, null, 2));
};

// [DEV-04] GET /api/v1/audit-log/stats
export const getAuditStats = async (_req: Request, res: Response) => {
  const stats = await getAuditStatsFromDb();
  if (stats) {
    return res.json({ success: true, source: "database", data: stats });
  }

  // Mock fallback so the frontend analytics panel shows something meaningful
  res.json({
    success: true,
    source: "mock",
    data: {
      eventsPerModule: [
        { module: "maintenance", total: "42", warnings: "5" },
        { module: "upload", total: "18", warnings: "1" },
        { module: "ai", total: "11", warnings: "0" },
        { module: "incident", total: "7", warnings: "2" },
        { module: "traffic", total: "5", warnings: "0" },
        { module: "emissions", total: "3", warnings: "0" },
      ],
      topUsers: [
        { user_id: "admin_01", total: "38" },
        { user_id: "dashboard", total: "28" },
        { user_id: "analyst_02", total: "12" },
        { user_id: "operator_03", total: "8" },
      ],
      topActions: [
        { action: "maintenance.schedule_created", total: "20" },
        { action: "maintenance.status_changed", total: "15" },
        { action: "upload.file_received", total: "12" },
        { action: "maintenance.schedule_edited", total: "7" },
        { action: "ai.simulation_run", total: "6" },
        { action: "ai.lanes_configured", total: "5" },
        { action: "incident.viewed", total: "4" },
        { action: "maintenance.schedule_deleted", total: "3" },
      ],
      recentWarnings: [
        { id: 4, timestamp: new Date().toISOString(), user_id: "admin_01", action: "maintenance.status_changed", target_resource: "maintenance:1", severity: "warning", details: { to: "cancelled", reason: "Weather" } },
      ],
      dailyTrend: Array.from({ length: 14 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (13 - i));
        return { day: d.toISOString().split("T")[0], total: String(Math.floor(Math.random() * 15) + 1) };
      }),
    },
  });
};
