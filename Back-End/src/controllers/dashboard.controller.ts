import type { Request, Response } from "express";
import { getDashboardData } from "../services/dashboard.service.js";

export async function dashboardController(_req: Request, res: Response) {
  const data = await getDashboardData();
  res.json({ success: true, data });
}
