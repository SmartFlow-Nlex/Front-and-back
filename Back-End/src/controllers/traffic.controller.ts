import type { Request, Response } from "express";
import { getTrafficData } from "../services/traffic.service.js";

export async function trafficController(_req: Request, res: Response) {
  const data = await getTrafficData();
  res.json({ success: true, data });
}
