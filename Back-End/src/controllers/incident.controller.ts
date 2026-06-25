import type { Request, Response } from "express";
import { IncidentQuerySchema } from "../validators/incident.validator.js";
import { getIncidentListFromDb, getIncidentMetricsFromDb, getWeatherCorrelationFromDb } from "../services/incident.service.js";

// [DEV-01] GET /api/v1/incident/list
export const getIncidentList = async (req: Request, res: Response) => {
  const query = IncidentQuerySchema.parse(req.query);
  
  const dbRows = await getIncidentListFromDb(query.status);
  if (dbRows) {
    return res.json({ success: true, source: "database", data: dbRows });
  }

  // Fallback Mock
  res.json({ success: true, source: "mock", data: [
    { incident_id: "INC-992", type: "Traffic Jam", severity: "High" }
  ]});
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
