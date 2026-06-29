import type { Request, Response } from "express";
import {
  hasIncidentData,
  getIncidentSummary,
  getIncidentCounts,
  getAvgClearanceTime,
  getCauseDistribution,
  getWeatherCorrelation as getWeatherCorrelationFromDb,
  getSeverityDistribution,
  getStalledVehicleCauses,
  getViolationDistribution,
} from "../services/incident.service.js";

// ─────────────────────────────────────────────────────────
// GET /api/incident/summary — Full incident analytics
// ─────────────────────────────────────────────────────────
export const getIncidentOverview = async (_req: Request, res: Response) => {
  const hasData = await hasIncidentData();

  if (hasData) {
    const summary = await getIncidentSummary();
    return res.json({ success: true, source: "database", data: summary });
  }

  // Mock fallback
  res.json({
    success: true,
    source: "mock",
    noData: true,
    message: "No incident data uploaded yet. Upload CSV datasets via Data Management.",
    data: {
      counts: { road_crashes: 0, motorcycle_crashes: 0, stalled_vehicles: 0, apprehensions: 0 },
      avgClearance: 12.3,
      causes: [
        { cause: "Driver Error", count: 245 },
        { cause: "Miscalculation", count: 188 },
        { cause: "Road/Equipment Conditions", count: 156 },
      ],
      weather: [
        { weather_condition: "Fair", incident_count: 350 },
        { weather_condition: "Light Rain", incident_count: 72 },
        { weather_condition: "Heavy Rain", incident_count: 28 },
      ],
      severity: [
        { severity: "Minor", count: 282 },
        { severity: "Moderate", count: 134 },
        { severity: "Severe", count: 36 },
      ],
      stalledCauses: [
        { vehicle_cause: "Overheat", count: 200 },
        { vehicle_cause: "Flat Tire", count: 180 },
        { vehicle_cause: "Fuel Pump", count: 120 },
      ],
      violations: [
        { violation: "Disregarding Traffic Sign", count: 245 },
        { violation: "Speeding", count: 188 },
        { violation: "Reckless Driving", count: 131 },
      ],
    },
  });
};

// ─────────────────────────────────────────────────────────
// GET /api/incident/list — backward compat
// ─────────────────────────────────────────────────────────
export const getIncidentList = async (_req: Request, res: Response) => {
  const counts = await getIncidentCounts();
  if (counts) {
    return res.json({ success: true, source: "database", data: counts });
  }
  res.json({ success: true, source: "mock", data: { road_crashes: 0, motorcycle_crashes: 0, stalled_vehicles: 0, apprehensions: 0 } });
};

// ─────────────────────────────────────────────────────────
// GET /api/incident/metrics
// ─────────────────────────────────────────────────────────
export const getIncidentMetrics = async (_req: Request, res: Response) => {
  const [avgClearance, severity] = await Promise.all([
    getAvgClearanceTime(),
    getSeverityDistribution(),
  ]);

  if (avgClearance || severity) {
    return res.json({ success: true, source: "database", data: { avgClearance, severity } });
  }
  res.json({ success: true, source: "mock", data: { avgClearance: 12.3, severity: [] } });
};

// ─────────────────────────────────────────────────────────
// GET /api/incident/weather-correlation
// ─────────────────────────────────────────────────────────
export const getWeatherCorrelation = async (_req: Request, res: Response) => {
  const weather = await getWeatherCorrelationFromDb();
  if (weather) {
    return res.json({ success: true, source: "database", data: weather });
  }
  res.json({ success: true, source: "mock", data: [] });
};
