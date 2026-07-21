import type { Request, Response } from "express";
import { z } from "zod";
import { getEmissionsIndexFromDb, getPeakPenaltyFromDb, getClimateResilienceFromDb, getEmissionsAnalyticsFromDb } from "../services/emissions.service.js";
import { saveAuditEventInDb } from "../services/audit-log.service.js";

// Fire-and-forget audit entry; never blocks or fails the actual operation.
const audit = (req: Request, action: string, targetId: string, details: Record<string, unknown>) => {
  void saveAuditEventInDb({
    user_id: req.header("x-user") ?? "dashboard",
    action,
    target_resource: `emissions:${targetId}`,
    module: "emissions",
    severity: "info",
    details,
  });
};

const EmissionsAnalyticsQuerySchema = z.object({
  months: z.enum(["3", "12", "all"]).optional().default("12"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// GET /api/emissions/analytics — descriptive dashboard aggregates
export const getEmissionsAnalytics = async (req: Request, res: Response) => {
  const query = EmissionsAnalyticsQuerySchema.parse(req.query);
  const data = await getEmissionsAnalyticsFromDb(query);

  if (!data) {
    return res.status(503).json({ success: false, message: "Emissions analytics unavailable: database not reachable" });
  }

  audit(req, "emissions.analytics_viewed", "analytics", { months: query.months });
  res.json({ success: true, source: "database", data });
};

// [DEV-01] GET /api/v1/emissions/index
export const getEmissionsIndex = async (_req: Request, res: Response) => {
  const dbRow = await getEmissionsIndexFromDb();
  if (dbRow) {
    return res.json({ success: true, source: "database", data: dbRow });
  }

  res.json({ success: true, source: "mock", data: { aqi_level: 45, co2_emissions_tons: 120.5 } });
};

// [DEV-01] GET /api/v1/emissions/peak-penalty
export const getPeakPenalty = async (_req: Request, res: Response) => {
  const dbRow = await getPeakPenaltyFromDb();
  if (dbRow) {
    return res.json({ success: true, source: "database", data: dbRow });
  }

  res.json({ success: true, source: "mock", data: { penalty_count: 1, excess_emissions: 450.2 } });
};

// [DEV-02] GET /api/v1/emissions/resilience
export const getClimateResilience = async (_req: Request, res: Response) => {
  const dbRows = await getClimateResilienceFromDb();
  if (dbRows) {
    return res.json({ success: true, source: "database", data: dbRows });
  }

  res.json({ success: true, source: "mock", data: [{ weather_condition: "Clear", preventable_incidents: 2 }] });
};
