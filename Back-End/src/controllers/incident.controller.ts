import type { Request, Response } from "express";
import { cached } from "../utils/ttl-cache.js";
import { z } from "zod";
import {
  IncidentQuerySchema,
  buildIncidentPredictiveQuerySchema,
  IncidentPredictiveResponseSchema,
  ClearanceProtocolQuerySchema,
  ClearanceProtocolResponseSchema,
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
import { getEventBreakdownFromDb } from "../services/incident-events.service.js";
import { getBreakdownResponseFromDb } from "../services/breakdown-response.service.js";
import { getClearanceProtocolFromDb } from "../services/clearance-protocol.service.js";

const IncidentAnalyticsQuerySchema = z.object({
  months: z.enum(["3", "12", "all"]).optional().default("12"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // "road"/"moto"/"stalled" retired with the nlex_road_crashes/etc. source
  // tables — the client tables only distinguish accident vs. breakdown.
  source: z.enum(["all", "accident", "breakdown"]).optional().default("all"),
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
  // Anchors are three cheap reads that every call repeated; ten minutes.
  const anchors = await cached("incident:anchors", 10 * 60_000, getIncidentPredictiveAnchors);
  if (!anchors) {
    // Matches getIncidentSpatial/getIncidentSeverity's phrasing below rather
    // than asserting "not reachable" outright -- the service's own console.warn/
    // error (see getIncidentPredictiveAnchors) already distinguishes the two
    // causes for whoever is diagnosing this; this message just stops
    // overclaiming to the client which one it was.
    return res.status(503).json({
      success: false,
      message: "Predictive analytics unavailable: database not reachable or the pipeline hasn't written yet",
    });
  }

  const query = buildIncidentPredictiveQuerySchema({
    minDate: anchors.minActualDate,
    maxDate: anchors.maxForecastDate,
  }).parse(req.query);

  /* Eight parallel queries and a large response assembly, measured at
     1.8-4.1 s, over tables that change only on retrain. Keyed by the parsed
     query so each Range/Weather combination caches separately. */
  const data = await cached(`incident:predictive:${JSON.stringify(query)}`, 10 * 60_000, () =>
    getIncidentPredictiveFromDb(query, anchors));
  if (!data) {
    return res.status(503).json({
      success: false,
      message: "Predictive analytics unavailable: database not reachable or the pipeline hasn't written yet",
    });
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

// GET /api/incident/breakdown-response — the model from
// train_breakdown_response_models.py: Cox PH vs XGBoost competing on a
// breakdown deployment's response_time_min, reported as Actual vs Predicted
// median response minutes by cause and by service — the trained-model
// counterpart to /event-breakdown's descriptive-only numbers. Single
// "as of the last training run" snapshot, same as /spatial and /severity.
// Optional dow (0 = Sunday .. 6) and block (0 = 12-3 AM .. 7 = 9 PM-12 AM) cut the group medians to the
// held-out dispatches reported in that day and time (19 Oct 2026, testers IN-12). Without them the
// response is the whole-holdout snapshot it always was.
const BreakdownResponseQuerySchema = z.object({
  dow: z.coerce.number().int().min(0).max(6).optional(),
  block: z.coerce.number().int().min(0).max(7).optional(),
});

export const getIncidentBreakdownResponse = async (req: Request, res: Response) => {
  const parsed = BreakdownResponseQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    });
  }
  const data = await getBreakdownResponseFromDb(parsed.data);
  if (!data) {
    return res.status(503).json({
      success: false,
      message: "Breakdown response-time model unavailable: database not reachable or the pipeline hasn't written yet",
    });
  }
  res.json({ success: true, source: "database", data });
};

// GET /api/incident/clearance-protocol — the Prescriptive tab's Clearance
// Response Protocol: a Kaplan-Meier clearance-time curve and the escalation
// rule read off it (still open at P50 -> chance of running past P80). Data
// only; see clearance-protocol.service.ts's module doc comment.
export const getClearanceProtocol = async (req: Request, res: Response) => {
  const parsed = ClearanceProtocolQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    });
  }

  const data = await getClearanceProtocolFromDb(parsed.data);
  if (!data) {
    return res.status(503).json({ success: false, message: "Clearance protocol unavailable: database not reachable" });
  }

  const validated = ClearanceProtocolResponseSchema.parse(data);
  res.json({ success: true, source: "database", data: validated });
};

// GET /api/incident/event-breakdown — descriptive analytics over the
// breakdown_data event table: breakdown cause counts, and per-service/
// per-cause response-time stats from its deployments records. A live SQL
// aggregation (like /analytics), not a trained-model snapshot, so the 503
// message doesn't mention a pipeline.
// Same filter vocabulary as /analytics (months/from/to), no source/weather —
// this endpoint's tables don't carry either dimension.
const EventBreakdownQuerySchema = z.object({
  months: z.enum(["3", "12", "all"]).optional().default("12"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const getEventBreakdown = async (req: Request, res: Response) => {
  const query = EventBreakdownQuerySchema.parse(req.query);
  const data = await getEventBreakdownFromDb(query);
  if (!data) {
    return res.status(503).json({ success: false, message: "Event breakdown analytics unavailable: database not reachable" });
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
