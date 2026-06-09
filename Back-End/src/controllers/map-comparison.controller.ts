import type { Request, Response } from "express";
import { getMapComparisonData } from "../services/map-comparison.service.js";

export async function mapComparisonController(_req: Request, res: Response) {
  const data = await getMapComparisonData();
  res.json({ success: true, data });
}
