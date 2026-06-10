import type { Request, Response } from "express";
import { z } from "zod";
import { calculateCarbonEmissionBatch, calculateCarbonEmissionData, getEmissionsData } from "../services/emissions.service.js";

const carbonCalculationSchema = z.object({
  time_reported: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  time_cleared: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  daily_volume: z.coerce.number().int().nonnegative(),
});

const carbonBatchSchema = z.object({
  rows: z.array(carbonCalculationSchema).min(1),
});

export async function emissionsController(_req: Request, res: Response) {
  const data = await getEmissionsData();
  res.json({ success: true, data });
}

export async function carbonEmissionController(req: Request, res: Response) {
  const parsed = carbonCalculationSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Invalid request body",
    });
  }

  try {
    const data = await calculateCarbonEmissionData(parsed.data);
    return res.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to calculate carbon emissions";
    return res.status(502).json({ success: false, message });
  }
}

export async function carbonEmissionBatchController(req: Request, res: Response) {
  const parsed = carbonBatchSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Invalid request body",
    });
  }

  try {
    const data = await calculateCarbonEmissionBatch(parsed.data.rows);
    return res.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to calculate carbon emissions";
    return res.status(502).json({ success: false, message });
  }
}
