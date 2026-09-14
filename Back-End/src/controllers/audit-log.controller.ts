import type { Request, Response } from "express";
import { getAuditAnalyticsFromDb, saveAuditEventInDb, getAuditLogsFromDb } from "../services/audit-log.service.js";
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
    { id: 1, user_id: "admin_01", action: "UPDATE_CONFIG", target_resource: "ai-sandbox", timestamp: new Date().toISOString() }
  ]});
};

// [DEV-03] GET /api/v1/audit-log/export
export const exportAuditLogs = async (req: Request, res: Response) => {
  // Same fetching logic as list, but would format as CSV/JSON string and return as file download
  const parsed = AuditQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid filters" });

  const dbRows = await getAuditLogsFromDb(parsed.data);
  const dataToExport = dbRows || [{ id: 1, action: "mock_export_event" }];

  // In a real scenario, convert dataToExport to CSV
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="audit_export.json"');
  res.send(JSON.stringify(dataToExport, null, 2));
};


// GET /api/audit-log/analytics?module=maintenance
export const getAuditAnalytics = async (req: Request, res: Response) => {
  const mod = typeof req.query.module === "string" ? req.query.module : undefined;
  const data = await getAuditAnalyticsFromDb(mod);
  if (!data) {
    return res.status(503).json({ success: false, message: "Audit analytics unavailable: database not reachable" });
  }
  res.json({ success: true, source: "database", data });
};
