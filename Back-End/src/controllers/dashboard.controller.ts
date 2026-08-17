import type { Request, Response } from "express";
import { getDashboardData, getDashboardOverview } from "../services/dashboard.service.js";

export async function dashboardController(_req: Request, res: Response) {
  const data = await getDashboardData();
  res.json({ success: true, data });
}

export async function dashboardOverviewController(req: Request, res: Response) {
  const raw = String(req.query.months ?? "12");
  // Anything unrecognised falls back to 12 rather than reaching the query.
  const months = raw === "3" || raw === "all" ? raw : "12";
  const data = await getDashboardOverview(months);
  res.json({ success: true, data });
}
