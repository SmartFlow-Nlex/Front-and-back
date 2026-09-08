import type { Request, Response } from "express";
import { z } from "zod";
import { getEmissionsIndexFromDb, getPeakPenaltyFromDb, getClimateResilienceFromDb, getEmissionsAnalyticsFromDb } from "../services/emissions.service.js";
import { getEmissionForecast, getHorizonAccuracy } from "../services/traffic.service.js";

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

const EmissionForecastQuerySchema = z.object({
  months: z.enum(["3", "6", "12", "all"]).optional().default("all"),
});

/**
 * GET /api/emissions/forecast — the served 7-day corridor CO2 forecast.
 *
 * Public, matching /analytics: it is the predictive half of the same panel and
 * carries no more sensitivity than the descriptive half already exposed.
 */
export const getEmissionsForecast = async (req: Request, res: Response) => {
  const { months } = EmissionForecastQuerySchema.parse(req.query);

  let data;
  let horizon;
  try {
    [data, horizon] = await Promise.all([
      getEmissionForecast(months === "all" ? undefined : Number(months)),
      // What each stretch of the 90-day projection is worth. The headline
      // metrics are h=7; the panel now draws far beyond that.
      getHorizonAccuracy("Corridor CO2"),
    ]);
  } catch (error) {
    const kind = (error as { kind?: string }).kind;
    // 503 says "try again"; 500 says "this will not fix itself". Sending 503 for
    // a broken query told the client to retry something that could never succeed.
    return res.status(kind === "connectivity" ? 503 : 500).json({
      success: false,
      retryable: kind === "connectivity",
      message:
        kind === "connectivity"
          ? "Emission forecast temporarily unavailable: the database did not respond in time"
          : "Emission forecast failed: the stored forecast could not be read",
    });
  }

  if (!data) {
    return res.status(503).json({ success: false, retryable: true, message: "Emission forecast unavailable: no database connection is configured" });
  }
  if (!data.series.length) {
    return res.status(404).json({ success: false, message: "No emission forecast has been trained yet" });
  }

  const champion = data.metrics.find((m) => m.model === data.championModel) ?? null;
  // Models the trainer marked indistinguishable from the leader. Naming one a
  // winner when the gap is smaller than the run-to-run jitter would be false
  // precision, so the API reports the whole tied set.
  const coChampions = data.metrics
    .filter((m) => m.accepted && typeof m.diagnosis === "string" && m.diagnosis.startsWith("tied with"))
    .map((m) => m.model);
  res.json({
    success: true,
    source: "database",
    data: {
      ...data,
      // Horizon differs from the volume module's 14 days, so it is stated rather
      // than assumed by whoever reads the metrics next to it.
      horizonDays: 7,
      champion,
      coChampions,
      horizonAccuracy: horizon ?? [],
      // The forecast window is scored on day-of-year climatology, not observed
      // weather, so these figures are achievable in deployment.
      weatherAtForecastTime: "climatology",
    },
  });
};
