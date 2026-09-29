import type { Request, Response } from "express";
import {
  ModelNarrativeSchema,
  ExplainSchema,
  CongestionNarrativeSchema,
  EventSurgeNarrativeSchema,
  RankingNarrativeSchema,
} from "../validators/ai-insight.validator.js";
import {
  generateInsight,
  generateCongestionInsight,
  generateEventSurgeInsight,
  generateRankingInsight,
} from "../services/ai-insight.service.js";
import { explain } from "../services/ai-explain.service.js";
import { isGlmConfigured, providerInfo, GlmError } from "../lib/glm.client.js";
import {
  generateIncidentModelsInsight,
  generateClearanceInsight,
  generateIncidentPriorityInsight,
  generateCorridorRiskInsight,
  generateHighIncidentDayInsight,
} from "../services/ai-insight.incident.service.js";
import {
  IncidentModelsNarrativeSchema,
  ClearanceNarrativeSchema,
  IncidentPriorityNarrativeSchema,
  CorridorRiskNarrativeSchema,
  HighIncidentDayNarrativeSchema,
} from "../validators/ai-insight.validator.js";

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
 * POST /api/ai-insight/congestion-narrative
 *
 * Same contract as model-narrative, for the congestion classifier: the client
 * sends the leaderboard and per-hour accuracy it is already showing, and gets
 * prose back. Nothing is stored and nothing is applied.
 */
export const congestionNarrative = async (req: Request, res: Response) => {
  const parsed = CongestionNarrativeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      code: "bad_request",
      message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    });
  }

  try {
    const data = await generateCongestionInsight(parsed.data);
    return res.json({ success: true, data });
  } catch (err) {
    if (err instanceof GlmError) {
      const status = err.code === "bad_model_output" ? 502 : 503;
      return res.status(status).json({ success: false, code: err.code, message: err.message });
    }
    console.error("Congestion narrative failed:", err);
    return res
      .status(500)
      .json({ success: false, code: "internal", message: "Narrative generation failed." });
  }
};

/**
 * POST /api/ai-insight/event-surge-narrative
 *
 * Same contract as the others: the client sends the validation rows and the
 * situation it is already showing, and gets prose back. Nothing is stored.
 */
export const eventSurgeNarrative = async (req: Request, res: Response) => {
  const parsed = EventSurgeNarrativeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      code: "bad_request",
      message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    });
  }

  try {
    const data = await generateEventSurgeInsight(parsed.data);
    return res.json({ success: true, data });
  } catch (err) {
    if (err instanceof GlmError) {
      const status = err.code === "bad_model_output" ? 502 : 503;
      return res.status(status).json({ success: false, code: err.code, message: err.message });
    }
    console.error("Event surge narrative failed:", err);
    return res
      .status(500)
      .json({ success: false, code: "internal", message: "Narrative generation failed." });
  }
};

/**
 * POST /api/ai-insight/ranking-narrative
 *
 * Same read-only contract as the others: the client sends the ranked rows
 * it's already showing (Predicted Incidents Ranking or Secondary Incident
 * Risk), and gets prose back. Nothing is stored and nothing is applied.
 */
export const rankingNarrative = async (req: Request, res: Response) => {
  const parsed = RankingNarrativeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      code: "bad_request",
      message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    });
  }

  try {
    const data = await generateRankingInsight(parsed.data);
    return res.json({ success: true, data });
  } catch (err) {
    if (err instanceof GlmError) {
      const status = err.code === "bad_model_output" ? 502 : 503;
      return res.status(status).json({ success: false, code: err.code, message: err.message });
    }
    console.error("Ranking narrative failed:", err);
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

/* ── The incident module's three non-forecast panels ────────────────────────
 *
 * Same contract as the endpoints above: the client posts the rows it is
 * already displaying and gets prose back. Nothing is read from the database
 * and nothing is stored. The three share one handler factory because the only
 * thing that differs between them is the schema and the generator -- writing
 * the same parse/try/catch three times would just be three places to fix the
 * next time the error shaping changes.
 */
function narrativeHandler<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { issues: { path: (string | number)[]; message: string }[] } } },
  generate: (input: T) => Promise<unknown>,
  label: string,
) {
  return async (req: Request, res: Response) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        code: "bad_request",
        message: (parsed.error?.issues ?? [])
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
    }
    try {
      const data = await generate(parsed.data as T);
      return res.json({ success: true, data });
    } catch (err) {
      if (err instanceof GlmError) {
        const status = err.code === "bad_model_output" ? 502 : 503;
        return res.status(status).json({ success: false, code: err.code, message: err.message });
      }
      console.error(`${label} narrative failed:`, err);
      return res
        .status(500)
        .json({ success: false, code: "internal", message: "Narrative generation failed." });
    }
  };
}

/** POST /api/ai-insight/incident-models-narrative */
export const incidentModelsNarrative = narrativeHandler(
  IncidentModelsNarrativeSchema,
  generateIncidentModelsInsight,
  "Incident models",
);

/** POST /api/ai-insight/clearance-narrative */
export const clearanceNarrative = narrativeHandler(
  ClearanceNarrativeSchema,
  generateClearanceInsight,
  "Clearance",
);

/** POST /api/ai-insight/incident-priority-narrative */
export const incidentPriorityNarrative = narrativeHandler(
  IncidentPriorityNarrativeSchema,
  generateIncidentPriorityInsight,
  "Incident priority",
);

/** POST /api/ai-insight/corridor-risk-narrative */
export const corridorRiskNarrative = narrativeHandler(
  CorridorRiskNarrativeSchema,
  generateCorridorRiskInsight,
  "Corridor risk models",
);

/** POST /api/ai-insight/high-incident-day-narrative */
export const highIncidentDayNarrative = narrativeHandler(
  HighIncidentDayNarrativeSchema,
  generateHighIncidentDayInsight,
  "High-incident-day risk",
);
