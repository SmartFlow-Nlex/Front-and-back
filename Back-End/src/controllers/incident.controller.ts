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
  getIncidentHourlyFromDb,
  getIncidentPredictiveFromDb,
  getIncidentPredictiveAnchors,
} from "../services/incident.service.js";
import { getIncidentSpatialFromDb } from "../services/incident-spatial.service.js";
import { getIncidentSeverityFromDb } from "../services/incident-severity.service.js";
import { getIncidentWeatherSpeedFromDb } from "../services/incident-weather-speed.service.js";

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

const IncidentHourlyQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
});

// GET /api/incident/hourly?date=YYYY-MM-DD — the 24-hour drill-down behind one
// point on the predictive forecast.
//
// Deliberately unfiltered by weather: the response carries every hour with its
// recorded rainfall and wet/dry flag, and the client's All/Dry/Wet chips slice
// that one payload. Filtering server-side would mean three round trips to show
// the same day three ways, and would also throw away the denominator — "4 of
// the day's 11 incidents fell in wet hours" needs all three numbers at once.
export const getIncidentHourly = async (req: Request, res: Response) => {
  const { date } = IncidentHourlyQuerySchema.parse(req.query);
  const data = await getIncidentHourlyFromDb(date);

  if (!data) {
    return res.status(503).json({ success: false, message: "Hourly breakdown unavailable: database not reachable" });
  }

  res.json({ success: true, source: "database", data });
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

// GET /api/incident/spatial — the two per-exit models from
// train_incident_spatial_models.py: GWR's local coefficients (feeds the
// coefficient map) and the Spatial LSTM's next-24h per-exit ranking (feeds
// the high-risk segment list). No query params: unlike /predictive, this is
// a single "as of the last training run" snapshot across all 20 exits, not
// a Range/Weather-scoped query.
export const getIncidentSpatial = async (_req: Request, res: Response) => {
  const data = await getIncidentSpatialFromDb();
  if (!data) {
    return res.status(503).json({
      success: false,
      message: "Spatial incident models unavailable: database not reachable or the pipeline hasn't written yet",
    });
  }
  res.json({ success: true, source: "database", data });
};

// GET /api/incident/severity — the per-incident models from
// train_incident_severity_models.py: severity (Ordinal Logistic vs
// XGBoost), Cox PH's clearance survival curve, and the secondary-incident
// risk score. Also a single "as of the last training run" snapshot, no
// query params.
export const getIncidentSeverity = async (_req: Request, res: Response) => {
  const data = await getIncidentSeverityFromDb();
  if (!data) {
    return res.status(503).json({
      success: false,
      message: "Severity/clearance models unavailable: database not reachable or the pipeline hasn't written yet",
    });
  }
  res.json({ success: true, source: "database", data });
};

// GET /api/incident/weather-speed — the models from
// train_incident_weather_speed_models.py: daily speed/volume forecast
// (SARIMAX/LSTM/GRU/XGBoost), the road-closure and weather-incident-risk
// logistic regressions, and the exit-hour contour map. Single snapshot, no
// query params, same as /spatial and /severity.
export const getIncidentWeatherSpeed = async (_req: Request, res: Response) => {
  const data = await getIncidentWeatherSpeedFromDb();
  if (!data) {
    return res.status(503).json({
      success: false,
      message: "Weather-adjusted speed models unavailable: database not reachable or the pipeline hasn't written yet",
    });
  }
  res.json({ success: true, source: "database", data });
};
