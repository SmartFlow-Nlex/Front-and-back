import type { Request, Response } from "express";
import {
  hasEmissionsData,
  getSustainabilitySummary,
  getHighEmissionFleetIndex,
  getPeakVsOffPeakEmissions,
  getClimateResilience
} from "../services/emissions.service.js";

// ─────────────────────────────────────────────────────────
// GET /api/emissions/summary — Full sustainability analytics
// ─────────────────────────────────────────────────────────
export const getSustainabilityOverview = async (_req: Request, res: Response) => {
  const hasData = await hasEmissionsData();

  if (hasData) {
    const summary = await getSustainabilitySummary();
    return res.json({ success: true, source: "database", data: summary });
  }

  // Mock fallback
  res.json({
    success: true,
    source: "mock",
    noData: true,
    message: "No data uploaded yet. Upload CSV datasets via Data Management.",
    data: {
      fleetIndex: { current_index: 28.4, total_vehicles: 500000, class3_vehicles: 142000 },
      peakEmissions: { off_peak: 140, morning_rush: 315, midday: 172, evening_rush: 402 },
      maintenance: { preventable_count: 12800, total_stalled: 20000, percentage: 64 },
      climate: { fair_incidents: 350, rainy_incidents: 100, impact_factor: 2.95 }
    },
  });
};

// ─────────────────────────────────────────────────────────
// GET /api/emissions/index — backward compat
// ─────────────────────────────────────────────────────────
export const getEmissionsIndex = async (_req: Request, res: Response) => {
  const fleetIndex = await getHighEmissionFleetIndex();
  if (fleetIndex) {
    return res.json({ success: true, source: "database", data: fleetIndex });
  }
  res.json({ success: true, source: "mock", data: { aqi_level: 45, co2_emissions_tons: 120.5 } });
};

// ─────────────────────────────────────────────────────────
// GET /api/emissions/peak-penalty
// ─────────────────────────────────────────────────────────
export const getPeakPenalty = async (_req: Request, res: Response) => {
  const peak = await getPeakVsOffPeakEmissions();
  if (peak) {
    return res.json({ success: true, source: "database", data: peak });
  }
  res.json({ success: true, source: "mock", data: { penalty_count: 1, excess_emissions: 450.2 } });
};

// ─────────────────────────────────────────────────────────
// GET /api/emissions/resilience
// ─────────────────────────────────────────────────────────
export const getClimateResilienceEndpoint = async (_req: Request, res: Response) => {
  const resilience = await getClimateResilience();
  if (resilience) {
    return res.json({ success: true, source: "database", data: resilience });
  }
  res.json({ success: true, source: "mock", data: [{ weather_condition: "Clear", preventable_incidents: 2 }] });
};
