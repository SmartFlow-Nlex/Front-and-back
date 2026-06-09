import type { Request, Response } from "express";
import { getIncidentData } from "../services/incident.service.js";

export async function incidentController(_req: Request, res: Response) {
  const data = await getIncidentData();
  res.json({ success: true, data });
}
