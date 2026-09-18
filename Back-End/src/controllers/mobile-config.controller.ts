import type { Request, Response } from "express";
import { getMobileConfigFromDb, saveMobileConfigInDb } from "../services/mobile-config.service.js";
import { MobileConfigSchema } from "../validators/mobile-config.validator.js";
import { saveAuditEventInDb } from "../services/audit-log.service.js";

// Fire-and-forget audit entry; never blocks or fails the actual operation.
const audit = (req: Request, action: string, details: Record<string, unknown>) => {
  void saveAuditEventInDb({
    user_id: req.header("x-user") ?? "dashboard",
    action,
    target_resource: "mobile-config",
    details,
  });
};

/**
 * GET /api/mobile-config
 *
 * Called by the mobile app on launch, so it must always answer with something
 * usable. When the row is missing or RDS is unreachable the service returns the
 * fail-open defaults and marks `source: "defaults"` — the caller can tell the
 * two apart, which is why this does not 503 like the write path does.
 */
export const readMobileConfig = async (_req: Request, res: Response) => {
  const result = await getMobileConfigFromDb();
  res.json({
    success: true,
    data: result.config,
    meta: {
      source: result.source,
      updatedAt: result.updatedAt,
      updatedBy: result.updatedBy,
    },
  });
};

/**
 * PUT /api/mobile-config
 *
 * Writes the whole document rather than patching fields. The control centre
 * edits one form and saves it in one go, and a whole-document write means two
 * operators saving at once cannot interleave into a state neither of them chose.
 */
export const writeMobileConfig = async (req: Request, res: Response) => {
  const parsed = MobileConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Invalid configuration",
    });
  }

  const before = await getMobileConfigFromDb();
  const saved = await saveMobileConfigInDb(parsed.data, req.header("x-user") ?? "dashboard");
  if (!saved) {
    return res.status(503).json({
      success: false,
      message: "Could not save configuration: database not reachable",
    });
  }

  // Record which switches actually moved, not the whole document — an audit
  // trail of identical blobs is unreadable when you need to find who turned
  // Community off.
  const changed = Object.entries(parsed.data.features)
    .filter(([k, v]) => before.config.features[k as keyof typeof before.config.features] !== v)
    .map(([k, v]) => `${k}=${v ? "on" : "off"}`);

  // Sections are qualified by their tab, because half a dozen of them share
  // short names and "traffic=off" alone would not say which screen it meant.
  const sectionsChanged: string[] = [];
  for (const [tab, group] of Object.entries(parsed.data.sections)) {
    const prev = (before.config.sections as Record<string, Record<string, boolean>>)[tab] ?? {};
    for (const [key, value] of Object.entries(group as Record<string, boolean>)) {
      if (prev[key] !== value) sectionsChanged.push(`${tab}.${key}=${value ? "on" : "off"}`);
    }
  }

  const advisoryChanged =
    before.config.advisory.active !== parsed.data.advisory.active ||
    before.config.advisory.message !== parsed.data.advisory.message ||
    before.config.advisory.tone !== parsed.data.advisory.tone;

  audit(req, "mobile_config.updated", {
    features: changed.length ? changed : "unchanged",
    sections: sectionsChanged.length ? sectionsChanged : "unchanged",
    advisory: advisoryChanged
      ? { active: parsed.data.advisory.active, tone: parsed.data.advisory.tone }
      : "unchanged",
  });

  res.json({
    success: true,
    data: saved.config,
    meta: { source: saved.source, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy },
  });
};
