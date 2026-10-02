import type { Request, Response } from "express";
import { getAuditLogsFromDb } from "../services/audit-log.service.js";
import { getAuditInsights } from "../services/audit-insights.service.js";
import { actorOf, audit, requestIdOf, writeAudit, type AuditModule } from "../services/audit.js";
import { db } from "../config/db.js";
import { ActivitySchema, AuditEventSchema, AuditQuerySchema, AuditSummarySchema } from "../validators/audit-log.validator.js";

// POST /api/audit-log/event — a full entry from a trusted writer (authenticated data analysts only).
// The user and role come from the verified token, never from the body.
export const writeAuditEvent = async (req: Request, res: Response) => {
  const parsed = AuditEventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid parameters" });
  const e = parsed.data;
  const row = await writeAudit(await actorOf(req), {
    action: e.action,
    module: (e.module ?? "audit_log") as AuditModule,
    entityType: e.entity_type,
    entityId: e.entity_id,
    target: e.target_resource,
    fromStatus: e.from_status,
    toStatus: e.to_status,
    outcome: e.outcome,
    durationMs: e.duration_ms,
    details: e.details && typeof e.details === "object" ? e.details : undefined,
  }, requestIdOf(req)).catch(() => null);
  if (!row) return res.status(503).json({ success: false, error: "Audit log unavailable: database not reachable." });
  res.json({ success: true, source: "database", data: row });
};

// POST /api/audit-log/activity — what a page reports about itself: viewed, signed in, signed out, exported.
export const recordActivity = async (req: Request, res: Response) => {
  const parsed = ActivitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Not an activity this endpoint records." });
  const a = parsed.data;
  switch (a.type) {
    case "page.viewed":
      audit(req, { action: "page.viewed", module: "navigation", entityType: "page", entityId: a.path, target: a.path, outcome: "success" });
      break;
    case "session.login":
      audit(req, { action: "session.login", module: "session", entityType: "session", outcome: "success" });
      break;
    case "session.logout": {
      // Awaited: the page signs out once this answers, and the token has to still be valid to name the user.
      // How long the session lasted: since this user's last sign-in.
      const actor = await actorOf(req);
      const last = db
        ? (await db.query(`SELECT max("timestamp") AS at FROM audit_logs WHERE action = 'session.login' AND user_id = $1`, [actor.user]).catch(() => ({ rows: [] }))).rows[0]?.at
        : null;
      await writeAudit(actor, {
        action: "session.logout", module: "session", entityType: "session", outcome: "success",
        durationMs: last ? Date.now() - new Date(last).getTime() : null,
      }, requestIdOf(req)).catch(() => null);
      break;
    }
    case "audit.exported":
      audit(req, { action: "audit.exported", module: "audit_log", entityType: "audit_log", outcome: "success", details: { rows: a.rows, format: a.format } });
      break;
  }
  res.status(202).json({ success: true });
};

// GET /api/audit-log/list?module=&action=&user_id=&include_views=1&limit=
export const listAuditLogs = async (req: Request, res: Response) => {
  const parsed = AuditQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid filters" });
  const rows = await getAuditLogsFromDb(parsed.data);
  if (!rows) return res.status(503).json({ success: false, message: "Audit log unavailable: database not reachable." });
  res.json({ success: true, source: "database", data: rows });
};

// GET /api/audit-log/summary?days=30 — usage, where the maintenance flow waits, uploads, retraining.
export const getAuditSummary = async (req: Request, res: Response) => {
  const parsed = AuditSummarySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid range" });
  try {
    const data = await getAuditInsights(parsed.data.days);
    if (!data) return res.status(503).json({ success: false, message: "Audit log unavailable: database not reachable." });
    res.json({ success: true, source: "database", data });
  } catch (e: any) {
    console.error("[audit] summary failed:", e);
    res.status(500).json({ success: false, message: `Audit summary failed: ${e.message}` });
  }
};

// GET /api/audit-log/export — every entry matching the filters, as a JSON file.
export const exportAuditLogs = async (req: Request, res: Response) => {
  const parsed = AuditQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid filters" });
  const rows = await getAuditLogsFromDb({ ...parsed.data, limit: parsed.data.limit ?? 2000 });
  if (!rows) return res.status(503).json({ success: false, message: "Audit log unavailable: database not reachable." });
  audit(req, { action: "audit.exported", module: "audit_log", entityType: "audit_log", outcome: "success", details: { rows: rows.length, format: "json" } });
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", 'attachment; filename="audit_export.json"');
  res.send(JSON.stringify(rows, null, 2));
};
