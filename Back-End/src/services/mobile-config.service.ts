import { db } from "../config/db.js";
import {
  DEFAULT_MOBILE_CONFIG,
  MobileConfigSchema,
  type MobileConfig,
} from "../validators/mobile-config.validator.js";

// ---------------------------------------------------------------------------
// Mobile app configuration — persisted in nlex_mobile_config (AWS RDS), one row.
// DDL: Back-End/scripts/mobile-config.sql
//
// Read by the mobile app on launch and written by the dashboard's Mobile
// Control Centre. Reads fail open to DEFAULT_MOBILE_CONFIG; writes never do.
// ---------------------------------------------------------------------------

export type MobileConfigRead = {
  config: MobileConfig;
  /** "db" when an operator's saved row was returned, "defaults" when it wasn't. */
  source: "db" | "defaults";
  updatedAt: string | null;
  updatedBy: string | null;
};

/** Postgres "relation does not exist" — the table has not been created yet. */
const UNDEFINED_TABLE = "42P01";

export async function getMobileConfigFromDb(): Promise<MobileConfigRead> {
  const fallback: MobileConfigRead = {
    config: DEFAULT_MOBILE_CONFIG,
    source: "defaults",
    updatedAt: null,
    updatedBy: null,
  };

  if (!db) return fallback;

  try {
    const { rows } = await db.query(
      `SELECT config, updated_at, updated_by FROM nlex_mobile_config WHERE id = 1`
    );
    if (rows.length === 0) return fallback;

    // A row written by an older build, or edited by hand in psql, can be the
    // wrong shape. Serving that to the app would crash a screen, so an
    // unparseable row is treated exactly like a missing one.
    const parsed = MobileConfigSchema.safeParse(rows[0].config);
    if (!parsed.success) {
      console.warn(
        `[mobile-config] stored row failed validation (${parsed.error.issues[0]?.message}); serving defaults`
      );
      return fallback;
    }

    return {
      config: parsed.data,
      source: "db",
      updatedAt: rows[0].updated_at?.toISOString?.() ?? null,
      updatedBy: rows[0].updated_by ?? null,
    };
  } catch (err: any) {
    if (err?.code === UNDEFINED_TABLE) {
      console.warn("[mobile-config] nlex_mobile_config missing — run Back-End/scripts/mobile-config.sql");
    } else {
      console.error(`[mobile-config] read failed: ${err.message}`);
    }
    return fallback;
  }
}

/**
 * Returns null when the write could not be persisted, so the caller can answer
 * 503 rather than reporting a save that did not happen. An operator who is told
 * "saved" and comes back to find the old settings has lost trust in every
 * switch on the page.
 */
export async function saveMobileConfigInDb(
  config: MobileConfig,
  updatedBy: string
): Promise<MobileConfigRead | null> {
  if (!db) return null;

  try {
    const { rows } = await db.query(
      `INSERT INTO nlex_mobile_config (id, config, updated_at, updated_by)
       VALUES (1, $1::jsonb, now(), $2)
       ON CONFLICT (id) DO UPDATE
         SET config = EXCLUDED.config,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by
       RETURNING config, updated_at, updated_by`,
      [JSON.stringify(config), updatedBy]
    );

    return {
      config,
      source: "db",
      updatedAt: rows[0].updated_at?.toISOString?.() ?? null,
      updatedBy: rows[0].updated_by ?? null,
    };
  } catch (err: any) {
    if (err?.code === UNDEFINED_TABLE) {
      console.error("[mobile-config] cannot save — run Back-End/scripts/mobile-config.sql first");
    } else {
      console.error(`[mobile-config] write failed: ${err.message}`);
    }
    return null;
  }
}
