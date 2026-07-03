import type { Request, Response } from "express";
import { getEmissionsIndexFromDb, getPeakPenaltyFromDb, getClimateResilienceFromDb } from "../services/emissions.service.js";

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
