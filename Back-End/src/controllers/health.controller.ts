import type { Request, Response } from "express";
import { getHealth } from "../services/health.service.js";

export async function healthController(_req: Request, res: Response) {
  const data = await getHealth();
  res.json({ success: true, data });
}
