import type { Request, Response } from "express";
import { ModelNarrativeSchema, ExplainSchema } from "../validators/ai-insight.validator.js";
import { generateInsight } from "../services/ai-insight.service.js";
import { explain } from "../services/ai-explain.service.js";
import { isGlmConfigured, providerInfo, GlmError } from "../lib/glm.client.js";

/** GET /api/ai-insight/status — lets a panel hide its button when unconfigured. */
export const insightStatus = async (_req: Request, res: Response) => {
  res.json({ success: true, data: { configured: isGlmConfigured(), ...providerInfo() } });
};

/**
 * POST /api/ai-insight/model-narrative
 *
 * Read-only in every sense: it takes metrics the client already has, and
 * returns prose. Nothing is stored and nothing is applied.
 */
export const modelNarrative = async (req: Request, res: Response) => {
  const parsed = ModelNarrativeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Invalid request",
    });
  }

  try {
    const insight = await generateInsight(parsed.data);
    return res.json({ success: true, data: insight });
  } catch (err) {
    if (err instanceof GlmError) {
      const status = err.code === "bad_model_output" ? 502 : 503;
      return res.status(status).json({ success: false, code: err.code, message: err.message });
    }
    console.error("Model narrative generation failed:", err);
    return res
      .status(500)
      .json({ success: false, code: "internal", message: "Narrative generation failed." });
  }
};

/**
 * POST /api/ai-insight/explain
 *
 * Plain-language briefing for one of the non-forecast modules. Read-only: the
 * service reads the same rows the page shows and returns prose.
 */
export const explainFeature = async (req: Request, res: Response) => {
  const parsed = ExplainSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Invalid request",
    });
  }

  try {
    const data = await explain(parsed.data.feature, parsed.data.months);
    return res.json({ success: true, data });
  } catch (err) {
    if (err instanceof GlmError) {
      const status = err.code === "bad_model_output" ? 502 : 503;
      return res.status(status).json({ success: false, code: err.code, message: err.message });
    }
    console.error("Feature explanation failed:", err);
    return res
      .status(500)
      .json({ success: false, code: "internal", message: "Explanation failed." });
  }
};
