import type { Request, Response } from "express";
import { SandboxCommandSchema } from "../validators/ai-sandbox.validator.js";
import { parseCommand, CommandParseError } from "../services/sandbox-command.service.js";
import { isGlmConfigured, providerInfo } from "../lib/glm.client.js";
import { getScenarioContext } from "../services/sandbox-scenario.service.js";

/**
 * GET /api/ai-sandbox/command/status
 *
 * Lets the dashboard show the command tab as available or unconfigured without
 * spending a token to find out.
 */
export const commandStatus = async (_req: Request, res: Response) => {
  res.json({ success: true, data: { configured: isGlmConfigured(), ...providerInfo() } });
};

/**
 * POST /api/ai-sandbox/command
 *
 * Returns a PROPOSAL, never an applied change. The dashboard renders the
 * actions for confirmation and applies them itself — nothing here writes to the
 * simulation, and nothing here writes to the database.
 */
export const parseSandboxCommand = async (req: Request, res: Response) => {
  const parsed = SandboxCommandSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Invalid request",
    });
  }

  const { command, context } = parsed.data;

  try {
    const plan = await parseCommand(command, context);
    return res.json({ success: true, data: plan });
  } catch (err) {
    if (err instanceof CommandParseError) {
      // 503 for "the service isn't usable right now" (no key, no balance, GLM
      // unreachable); 502 for "the model answered, but not with usable JSON".
      const status = err.code === "bad_model_output" ? 502 : 503;
      return res
        .status(status)
        .json({ success: false, code: err.code, message: err.message });
    }
    console.error("Sandbox command parsing failed:", err);
    return res
      .status(500)
      .json({ success: false, code: "internal", message: "Command parsing failed." });
  }
};

/**
 * GET /api/ai-sandbox/scenario?date=YYYY-MM-DD
 *
 * What the traffic, incident and emission forecasts all expect for one day, so
 * the sandbox can simulate against a predicted day rather than an average one.
 * Read-only; omitting the date returns the first forecastable day.
 */
export const scenarioContext = async (req: Request, res: Response) => {
  const raw = typeof req.query.date === "string" ? req.query.date : undefined;
  // A malformed date is treated as "no date" rather than an error: the service
  // falls back to the first available day, which is more useful than a 400.
  const date = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;

  try {
    const data = await getScenarioContext(date);
    if (!data) {
      return res.status(503).json({
        success: false,
        message:
          "No forecast day is available: the traffic, incident and emission forecasts have no dates in common.",
      });
    }
    return res.json({ success: true, data });
  } catch (err) {
    console.error("Scenario context failed:", err);
    return res.status(500).json({ success: false, message: "Scenario context failed." });
  }
};
