import type { Request, Response } from "express";
import { z } from "zod";
import { IncidentQuerySchema } from "../validators/incident.validator.js";
import { getIncidentListFromDb, getIncidentMetricsFromDb, getWeatherCorrelationFromDb, getIncidentAnalyticsFromDb, getIncidentPredictiveFromDb, getIncidentSpatialFromDb } from "../services/incident.service.js";
import { saveAuditEventInDb } from "../services/audit-log.service.js";

// Fire-and-forget audit entry; never blocks or fails the actual operation.
const audit = (req: Request, action: string, targetId: string, details: Record<string, unknown>, severity: "info" | "warning" | "critical" = "info") => {
  void saveAuditEventInDb({
    user_id: req.header("x-user") ?? "dashboard",
    action,
    target_resource: `incident:${targetId}`,
    module: "incident",
    severity,
    details,
  });
};

const IncidentAnalyticsQuerySchema = z.object({
  months: z.enum(["3", "12", "all"]).optional().default("12"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source: z.enum(["all", "road", "moto", "stalled"]).optional().default("all"),
  weather: z.enum(["all", "dry", "wet"]).optional().default("all"),
});

// GET /api/incident/analytics — descriptive dashboard aggregates
// weather=dry|wet keeps only incidents whose hour had expressway-avg rainfall <=/> 0.3 mm
export const getIncidentAnalytics = async (req: Request, res: Response) => {
  try {
    const query = IncidentAnalyticsQuerySchema.parse(req.query);
    const data = await getIncidentAnalyticsFromDb(query);

    if (!data) {
      return res.status(503).json({ success: false, message: "Incident analytics unavailable: database not reachable" });
    }

    audit(req, "incident.analytics_viewed", "analytics", { months: query.months, source: query.source, weather: query.weather });
    res.json({ success: true, source: "database", data });
  } catch (err) {
    console.error("getIncidentAnalytics error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json({ success: false, message });
  }
};

// GET /api/incident/predictive — returns forecasting data
export const getIncidentPredictive = async (req: Request, res: Response) => {
  try {
    const data = await getIncidentPredictiveFromDb();

    if (!data) {
      return res.status(503).json({ success: false, message: "Predictive analytics unavailable: database not reachable" });
    }

    audit(req, "incident.predictive_viewed", "predictive", {});
    res.json({ success: true, source: "database_or_fallback", data });
  } catch (err) {
    console.error("getIncidentPredictive error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json({ success: false, message });
  }
};

// GET /api/incident/spatial — response time distribution + location hotspot analysis
export const getIncidentSpatial = async (req: Request, res: Response) => {
  try {
    const data = await getIncidentSpatialFromDb();

    if (!data) {
      return res.status(503).json({ success: false, message: "Spatial analytics unavailable: database not reachable or no qualifying data" });
    }

    audit(req, "incident.spatial_viewed", "spatial", {});
    res.json({ success: true, source: "database", data });
  } catch (err) {
    console.error("getIncidentSpatial error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json({ success: false, message });
  }
};

// [DEV-01] GET /api/v1/incident/list
export const getIncidentList = async (req: Request, res: Response) => {
  try {
    const query = IncidentQuerySchema.parse(req.query);
    
    const dbRows = await getIncidentListFromDb(query.status);
    if (dbRows) {
      audit(req, "incident.list_viewed", query.status ?? "all", { status: query.status ?? "all", resultCount: dbRows.length });
      return res.json({ success: true, source: "database", data: dbRows });
    }

    // Fallback Mock
    res.json({ success: true, source: "mock", data: [
      { incident_id: "INC-992", type: "Traffic Jam", severity: "High" }
    ]});
  } catch (err) {
    console.error("getIncidentList error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json({ success: false, message });
  }
};

// [DEV-02] GET /api/v1/incident/metrics
export const getIncidentMetrics = async (_req: Request, res: Response) => {
  const dbRows = await getIncidentMetricsFromDb();
  if (dbRows) {
    return res.json({ success: true, source: "database", data: dbRows });
  }

  res.json({ success: true, source: "mock", data: { total: 10, avgClearance: 45 } });
};

// [DEV-03] GET /api/v1/incident/weather-correlation
export const getWeatherCorrelation = async (_req: Request, res: Response) => {
  const dbRows = await getWeatherCorrelationFromDb();
  if (dbRows) {
    return res.json({ success: true, source: "database", data: dbRows });
  }

  res.json({ success: true, source: "mock", data: { clear: 5, rain: 20 } });
};
