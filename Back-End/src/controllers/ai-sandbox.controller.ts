import type { Request, Response } from "express";
import { getAiSandboxData } from "../services/ai-sandbox.service.js";

export async function aiSandboxController(_req: Request, res: Response) {
  const data = await getAiSandboxData();
  res.json({ success: true, data });
}
