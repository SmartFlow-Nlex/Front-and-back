import type { Request, Response } from "express";
import { getAuditLogData } from "../services/audit-log.service.js";

export async function auditLogController(_req: Request, res: Response) {
  const data = await getAuditLogData();
  res.json({ success: true, data });
}
