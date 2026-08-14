import type { Request, Response } from "express";
import { z } from "zod";
import {
  IncidentQuerySchema,
  buildIncidentPredictiveQuerySchema,
  IncidentPredictiveResponseSchema,
} from "../validators/incident.validator.js";
import {
  getIncidentListFromDb,
  getIncidentMetricsFromDb,
  getWeatherCorrelationFromDb,
  getIncidentAnalyticsFromDb,
  getIncidentPredictiveFromDb,
  getIncidentPredictiveAnchors,
} from "../services/incident.service.js";

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
  const query = IncidentAnalyticsQuerySchema.parse(req.query);
  const data = await getIncidentAnalyticsFromDb(query);

  if (!data) {
    return res.status(503).json({ success: false, message: "Incident analytics unavailable: database not reachable" });
  }

  res.json({ success: true, source: "database", data });
};

// Same filter vocabulary as the descriptive tab so the one control strip above
// the page means the same thing on either. `months`/`from`/`to` set how much
// observed history is drawn behind the forecast; `weather` re-scores the models
// over just the wet or just the dry days of the validation window.
// No default on `months`: absent means "leave the chart geometry alone" and the
// service falls back to its original fixed context width. Defaulting to 12
// months here would silently rescale the chart for every existing caller.
//
// [ML-01] GET /api/incident/predictive — incident forecast. The champion is
// whichever model the pipeline last wrote to ml_training_metadata, not a fixed
// one; the response carries champion_model so callers never assume.
//
// Anchors (data bounds, walk-forward split dates, the fixed MASE denominator)
// are fetched once and used twice: to build a request-scoped Zod schema that
// refines `from`/`to` against the real min/max data dates — a query-string
// hack or a bookmarked URL can send an out-of-range date even though the UI
// picker never would — and again as the resolved-window input the service
// needs. One query, two consumers, instead of fetching them twice.
export const getIncidentPredictive = async (req: Request, res: Response) => {
  const anchors = await getIncidentPredictiveAnchors();
  if (!anchors) {
    return res.status(503).json({ success: false, message: "Predictive analytics unavailable: database not reachable" });
  }

  const query = buildIncidentPredictiveQuerySchema({
    minDate: anchors.minActualDate,
    maxDate: anchors.maxForecastDate,
  }).parse(req.query);

  const data = await getIncidentPredictiveFromDb(query, anchors);
  if (!data) {
    return res.status(503).json({ success: false, message: "Predictive analytics unavailable: database not reachable" });
  }

  // A malformed response here is a server-side bug, not a bad request from the
  // caller — route it to 500 rather than letting it fall into the ZodError ->
  // 400 branch in errorHandler, which is written for bad input, not bad output.
  let validated;
  try {
    validated = IncidentPredictiveResponseSchema.parse(data);
  } catch (err) {
    console.error("Predictive response failed schema validation:", err);
    return res.status(500).json({ success: false, message: "Predictive analytics response was malformed" });
  }

  res.json({ success: true, source: "database", data: validated });
};

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
