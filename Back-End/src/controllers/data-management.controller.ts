import type { Request, Response } from "express";
import { getDataManagementData } from "../services/data-management.service.js";

export async function dataManagementController(_req: Request, res: Response) {
  const data = await getDataManagementData();
  res.json({ success: true, data });
}
