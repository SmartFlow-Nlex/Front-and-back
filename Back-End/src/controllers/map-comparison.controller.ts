import type { Request, Response } from "express";
import { getRealtimeMapDataFromDb, searchExitsInDb } from "../services/map-comparison.service.js";
import { ExitSearchSchema } from "../validators/map-comparison.validator.js";

// [DEV-01, DEV-03] GET /api/v1/map-comparison/real-time
export const getMapRealtime = async (_req: Request, res: Response) => {
  const dbData = await getRealtimeMapDataFromDb();
  if (dbData) {
    return res.json({ success: true, source: "database", data: dbData });
  }

  res.json({ success: true, source: "mock", data: { message: "Mock Realtime/Waze merged data" } });
};

// [DEV-02] GET /api/v1/map-comparison/forecast
export const getMapForecast = async (_req: Request, res: Response) => {
  // Usually this would call the AI Sandbox/Python service directly
  res.json({ success: true, source: "mock", data: { prediction: "Heavy congestion at 5pm", confidence: 0.92 } });
};

// [DEV-04] GET /api/v1/map-comparison/exits
export const searchExits = async (req: Request, res: Response) => {
  const query = ExitSearchSchema.safeParse(req.query);
  if (!query.success) return res.status(400).json({ success: false, error: "Missing query" });

  const dbRows = await searchExitsInDb(query.data.query);
  if (dbRows) {
    return res.json({ success: true, source: "database", data: dbRows });
  }

  res.json({ success: true, source: "mock", data: [{ exit: "Balintawak" }] });
};
