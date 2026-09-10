import type { Request, Response } from "express";
import { TrafficQuerySchema, IncidentQuerySchema, ForecastQuerySchema, HourlyForecastQuerySchema, AnalyticsQuerySchema } from "../validators/traffic.validator.js";
import { getTrafficVolumesFromDb, getDirectionalFlowFromDb, getVehicleClassDistributionFromDb, getTrafficAnalyticsFromDb, getMLPredictiveVolume, getMLPredictiveVolumeHourly, getMLPredictiveCongestion, getMLEventSurge, getUpcomingEventSurge, getMLModelMetrics, getWeatherEvidenceFromDb, getSplitSummary, getCongestionModel,
  getHorizonAccuracy,
  getCongestionHorizonAccuracy,
  getEventSurgeMetrics
} from "../services/traffic.service.js";

// GET /api/traffic/analytics — descriptive dashboard aggregates
export const getTrafficAnalytics = async (req: Request, res: Response) => {
  const query = AnalyticsQuerySchema.parse(req.query);
  const data = await getTrafficAnalyticsFromDb({
    months: query.months,
    from: query.from,
    to: query.to,
    plazas: query.plazas ? query.plazas.split(",").map((p) => p.trim()).filter(Boolean) : undefined,
    direction: query.direction,
    vehicleClass: query.vehicleClass,
    weather: query.weather,
  });

  if (!data) {
    return res.status(503).json({ success: false, message: "Traffic analytics unavailable: database not reachable" });
  }

  res.json({ success: true, source: "database", data });
};

// [REQ-01] GET /api/v1/traffic/realtime
export const getRealtimeTraffic = async (req: Request, res: Response) => {
  const query = TrafficQuerySchema.parse(req.query);
  
  // Try fetching from the PostgreSQL DB
  const dbRows = await getTrafficVolumesFromDb(query.direction);
  
  if (dbRows && dbRows.length > 0) {
    // Map DB rows to response schema
    const mappedData = dbRows.map(row => ({
      segmentId: row.segmentId,
      name: `NLEX Segment ${row.segmentId}`, // Or join with a segments table
      direction: row.segmentId.startsWith("NB") ? "NB" : "SB",
      status: row.avgSpeedKmh < 30 ? "Heavy" : row.avgSpeedKmh < 60 ? "Moderate" : "Light",
      avgSpeedKmh: row.avgSpeedKmh,
      volumePerMin: row.volumePerMin,
      lastUpdated: new Date().toISOString()
    }));
    return res.json({ success: true, source: "database", data: mappedData });
  }

  // Graceful Mock Fallback if DB is unavailable
  const mockData = [
    { segmentId: "NB-01", name: "Balintawak - Mindanao Ave", direction: "NB", status: "Moderate", avgSpeedKmh: 65, volumePerMin: 42, lastUpdated: new Date().toISOString() },
    { segmentId: "SB-01", name: "Mindanao Ave - Balintawak", direction: "SB", status: "Light", avgSpeedKmh: 80, volumePerMin: 25, lastUpdated: new Date().toISOString() },
    { segmentId: "NB-02", name: "Mindanao Ave - Valenzuela", direction: "NB", status: "Heavy", avgSpeedKmh: 20, volumePerMin: 85, lastUpdated: new Date().toISOString() }
  ];

  const filtered = query.direction ? mockData.filter(d => d.direction === query.direction) : mockData;
  res.json({ success: true, source: "mock", data: filtered });
};

// [REQ-01] GET /api/v1/traffic/incidents
export const getIncidents = async (req: Request, res: Response) => {
  const _query = IncidentQuerySchema.parse(req.query);

  // Mock data representing Waze Reports
  const mockData = [
    { incidentId: "INC-992", type: "Traffic Jam", kmMarker: 14.5, direction: "NB", severity: "High", reportedAt: new Date().toISOString() },
    { incidentId: "INC-993", type: "Construction", kmMarker: 26.2, direction: "SB", severity: "Medium", reportedAt: new Date().toISOString() },
    { incidentId: "INC-994", type: "Accident", kmMarker: 12.0, direction: "NB", severity: "Critical", reportedAt: new Date().toISOString() }
  ];

  res.json({ success: true, source: "mock", data: mockData });
};

// [REQ-01] GET /api/v1/traffic/forecast
export const getForecast = async (req: Request, res: Response) => {
  const query = ForecastQuerySchema.parse(req.query);
  
  // Fetch real ML predictions from AWS PostgreSQL DB
  const [volumes, congestion, events, modelMetrics, congestionModel, split, horizonAccuracy, congestionHorizon, eventMetrics, upcomingEvents] = await Promise.all([
    getMLPredictiveVolume({ months: query.months, from: query.from, to: query.to, split: query.split }),
    getMLPredictiveCongestion(),
    getMLEventSurge(query.eventDate),
    getMLModelMetrics(query.split),
    getCongestionModel(),
    // Counted over the full table, NOT the windowed rows above, so the chart can
    // distinguish "what was trained on" from "what is currently drawn".
    getSplitSummary(query.split),
    // What each stretch of the projection is actually worth. The headline
    // metrics are h=14; the chart now draws up to 90 days.
    getHorizonAccuracy("Total Traffic"),
    getCongestionHorizonAccuracy(),
    getEventSurgeMetrics(),
    // The next Arena event days with a dated per-exit surge forecast each,
    // so the Prescriptive tab can plan for a real date rather than "an event".
    getUpcomingEventSurge()
  ]);

  if (!volumes && !congestion && !events) {
    return res.status(503).json({ success: false, message: "ML Predictions unavailable: database not reachable" });
  }

  // Confidence follows the best ACCEPTED model's wMAPE rather than a constant.
  // It used to be hardcoded at 0.89, which stayed put through every retrain.
  const champion = (modelMetrics ?? []).find((m) => m.accepted && m.wmape !== null);
  const mlConfidence = champion?.wmape != null
    ? Number((1 - champion.wmape / 100).toFixed(4))
    : null;

  res.json({
    success: true,
    data: {
      horizon: query.horizon,
      mlConfidence,
      championModel: champion?.model ?? null,
      split: split ?? null,
      // Which arm produced everything above, so the UI can label it and the
      // toggle knows what it is currently showing.
      splitLabel: query.split,
      congestionModel: congestionModel ?? null,
      horizonAccuracy: horizonAccuracy ?? [],
      congestionHorizonAccuracy: congestionHorizon ?? [],
      eventSurgeMetrics: eventMetrics ?? [],
      modelMetrics: modelMetrics ?? [],
      volumes: volumes || [],
      congestion: congestion || [],
      events: events || [],
      upcomingEvents: upcomingEvents || []
    }
  });
};

// GET /api/traffic/forecast/hourly?date=YYYY-MM-DD&model=LSTM
// Drill-down for a single point on the predictive volume chart.
export const getForecastHourly = async (req: Request, res: Response) => {
  const query = HourlyForecastQuerySchema.parse(req.query);

  const data = await getMLPredictiveVolumeHourly(query.date, query.model, query.weather, query.split);

  if (!data) {
    return res.status(404).json({ success: false, message: `No forecast found for ${query.date}` });
  }

  res.json({ success: true, data });
};

// [REQ-01, DEV-01, DEV-02, DEV-03] GET /api/v1/traffic/volume-adt
export const getVolumeAdt = async (_req: Request, res: Response) => {
  
  // Try fetching from the PostgreSQL DB
  const [flowRows, classRows] = await Promise.all([
    getDirectionalFlowFromDb(),
    getVehicleClassDistributionFromDb()
  ]);

  if (flowRows && classRows && flowRows.length > 0) {
    let totalAdt = 0;
    flowRows.forEach(r => totalAdt += Number(r.total));

    const classDistribution = { class1: 0, class2: 0, class3: 0 };
    classRows.forEach(r => {
      if (r.class_type === 1) classDistribution.class1 = Number(r.count);
      if (r.class_type === 2) classDistribution.class2 = Number(r.count);
      if (r.class_type === 3) classDistribution.class3 = Number(r.count);
    });

    return res.json({ 
      success: true, 
      source: "database",
      data: {
        date: new Date().toISOString().split('T')[0],
        totalAdt,
        directionalFlow: flowRows,
        classDistribution
      } 
    });
  }

  // Graceful Mock Fallback
  const mockData = {
    date: new Date().toISOString().split('T')[0],
    totalAdt: 350000,
    directionalFlow: [
      { direction: "NB", total: 180000 },
      { direction: "SB", total: 170000 }
    ],
    classDistribution: {
      class1: 280000, // Cars
      class2: 50000,  // Buses/Light Trucks
      class3: 20000   // Heavy Trucks
    }
  };

  res.json({ success: true, source: "mock", data: mockData });
};


// GET /api/traffic/weather-evidence
// Whether weather predicts traffic on this corridor — correlations computed live,
// plus the controlled with/without model comparison from the last training run.
export const getWeatherEvidence = async (_req: Request, res: Response) => {
  const data = await getWeatherEvidenceFromDb();
  if (!data) {
    return res.status(503).json({ success: false, message: "Weather evidence unavailable: database not reachable" });
  }
  res.json({ success: true, source: "database", data });
};
