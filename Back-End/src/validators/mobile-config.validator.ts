import { z } from "zod";

/**
 * The contract between the dashboard's Mobile Control Centre and the mobile app.
 *
 * Every switch here is one the app actually honours. That constraint is the
 * whole point: a control panel whose toggles do nothing is worse than no panel,
 * because an operator turns Community off, sees the switch move, and believes
 * the tab is gone. Before adding a field, wire it in the app first.
 *
 *   sections.*  — what is inside each tab. The only thing an operator sets.
 *   features.*  — whether each TAB exists. DERIVED, never chosen: a tab is
 *                 shown when at least one of its sections is. See below.
 *   advisories  — broadcast notices, pinned above the app's own Alerts. A
 *                 list, so an operator can hold several and publish or
 *                 withdraw them one at a time.
 *   advisory    — DERIVED: the first published advisory, written only so a
 *                 mobile build older than the list still finds what it
 *                 expects. Nothing reads it back.
 */

// Mirrors the five tabs in frontend/app/(tabs)/_layout.tsx. The keys are the
// Expo route names, so a mismatch here is a mismatch the app can detect.
export const MOBILE_FEATURES = ["dashboard", "map", "community", "assistant", "alerts"] as const;
export type MobileFeature = (typeof MOBILE_FEATURES)[number];

export const ADVISORY_TONES = ["info", "warning", "critical"] as const;
export type AdvisoryTone = (typeof ADVISORY_TONES)[number];

/* ── Sections ──────────────────────────────────────────────────────────────
 *
 * Every field defaults to true, and every group defaults to {}. That is what
 * lets a row written before sections existed still parse: an old document
 * simply has no `sections` key, and zod fills the whole tree in as "on"
 * rather than failing validation. The same property means a dashboard that
 * gains a section does not invalidate rows saved by the build before it.
 */

const DashboardSectionsSchema = z
  .object({
    statusSummary: z.boolean().default(true),
    segmentForecast: z.boolean().default(true),
    corridorOutlook: z.boolean().default(true),
    eventForecasts: z.boolean().default(true),
    mlHotspots: z.boolean().default(true),
  })
  .default({});

const MapSectionsSchema = z
  .object({
    liveStatus: z.boolean().default(true),
    forecastView: z.boolean().default(true),
  })
  .default({});

const CommunitySectionsSchema = z
  .object({
    shareUpdate: z.boolean().default(true),
    reportIncident: z.boolean().default(true),
    filters: z.boolean().default(true),
  })
  .default({});

const AssistantSectionsSchema = z
  .object({
    quickQuestions: z.boolean().default(true),
    capabilities: z.boolean().default(true),
  })
  .default({});

const AlertsSectionsSchema = z
  .object({
    traffic: z.boolean().default(true),
    maintenance: z.boolean().default(true),
  })
  .default({});

const SectionsSchema = z
  .object({
    dashboard: DashboardSectionsSchema,
    map: MapSectionsSchema,
    community: CommunitySectionsSchema,
    assistant: AssistantSectionsSchema,
    alerts: AlertsSectionsSchema,
  })
  .default({});

export type MobileSections = z.infer<typeof SectionsSchema>;

/** Upper bound on what can be pinned at once. Every active advisory is pinned
 *  above the app's own notices, so a long list stops being a notice and starts
 *  being the Alerts screen. */
export const MAX_ADVISORIES = 6;
export const MIN_ADVISORY_MESSAGE = 8;

const AdvisoryItemSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    active: z.boolean(),
    tone: z.enum(ADVISORY_TONES),
    // Long enough for a real closure notice, short enough to read on a phone
    // without the card becoming a wall of text.
    message: z.string().trim().max(280),
  })
  .refine((v) => !v.active || v.message.length >= MIN_ADVISORY_MESSAGE, {
    // Publishing an empty advisory would push a blank card to every phone.
    message: `A published advisory needs a message of at least ${MIN_ADVISORY_MESSAGE} characters`,
    path: ["message"],
  });

export type MobileAdvisory = z.infer<typeof AdvisoryItemSchema>;

const AdvisoriesSchema = z
  .array(AdvisoryItemSchema)
  .max(MAX_ADVISORIES, `At most ${MAX_ADVISORIES} advisories can be held at once`)
  .default([])
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const a of list) {
      if (seen.has(a.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Two advisories share an id",
        });
        return;
      }
      seen.add(a.id);
    }
  });

/** The single advisory this used to hold, derived from the list.
 *
 *  Written alongside `advisories` purely so a mobile build released before the
 *  list existed still finds what it expects. It is the first active one, since
 *  that is what such a build would have shown. Nothing reads it back. */
function legacyAdvisory(list: MobileAdvisory[]) {
  const first = list.find((a) => a.active && a.message.trim().length >= MIN_ADVISORY_MESSAGE);
  return first
    ? { active: true, tone: first.tone, message: first.message }
    : { active: false, tone: "info" as const, message: "" };
}

/**
 * A tab is shown when anything inside it is.
 *
 * There is no separate switch for the tab itself, and deliberately so. Two
 * levels of on/off let an operator produce a combination that means nothing —
 * a tab switched on with every section inside it off, which opens to a blank
 * screen and reads as a broken app. Deriving it removes that state from the
 * system rather than validating against it: emptying a tab IS how you retire
 * it, and the two can never drift apart because there is only one of them.
 */
export function deriveFeatures(sections: MobileSections): Record<MobileFeature, boolean> {
  const anyOn = (group: Record<string, boolean>) => Object.values(group).some(Boolean);
  return {
    dashboard: anyOn(sections.dashboard),
    map: anyOn(sections.map),
    community: anyOn(sections.community),
    assistant: anyOn(sections.assistant),
    alerts: anyOn(sections.alerts),
  };
}

/**
 * Parses a whole configuration document, from the API or from the stored row,
 * and recomputes `features` from `sections` on the way through.
 *
 * Any `features` in the input is ignored rather than trusted. It is written to
 * the row only so the app can read it directly, and a stored copy that
 * disagreed with its own sections would be a bug nobody would notice until a
 * tab went missing.
 */
export const MobileConfigSchema = z
  .object({
    // Accepted and discarded, so the dashboard can PUT back exactly what it GET.
    features: z.record(z.string(), z.boolean()).optional(),
    sections: SectionsSchema,
    advisories: AdvisoriesSchema,
    // A row written before the list existed carries one of these instead.
    advisory: z
      .object({
        active: z.boolean(),
        tone: z.enum(ADVISORY_TONES),
        message: z.string().trim().max(280),
      })
      .optional(),
  })
  .transform((cfg) => {
    // Migrate in place on read: an old single advisory becomes a one-item list
    // so the rest of the system only ever deals with the list.
    const list =
      cfg.advisories.length > 0
        ? cfg.advisories
        : cfg.advisory && cfg.advisory.message.trim().length > 0
          ? [{ id: "legacy", ...cfg.advisory, message: cfg.advisory.message.trim() }]
          : [];
    return { sections: cfg.sections, advisories: list };
  })
  .superRefine((cfg, ctx) => {
    // Every tab empty means an app with no tabs at all.
    if (Object.values(deriveFeatures(cfg.sections)).some(Boolean)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sections"],
      message: "At least one section somewhere must stay on, or the app opens to nothing.",
    });
  })
  .transform((cfg) => ({
    features: deriveFeatures(cfg.sections),
    sections: cfg.sections,
    advisories: cfg.advisories,
    advisory: legacyAdvisory(cfg.advisories),
  }));

export type MobileConfig = z.infer<typeof MobileConfigSchema>;

/**
 * Served when the table has not been created yet, or when the database cannot
 * be reached on a read.
 *
 * Deliberately fails OPEN — everything on, no advisory. A feature-flag service
 * that fails closed takes the whole app down with it the moment RDS hiccups,
 * which is a far worse outcome than briefly ignoring an operator's switch.
 * Reads say which of the two they are returning via `source`, so "everything is
 * on" is never silently mistaken for "an operator chose this".
 */
const DEFAULT_SECTIONS: MobileSections = {
  dashboard: {
    statusSummary: true,
    segmentForecast: true,
    corridorOutlook: true,
    eventForecasts: true,
    mlHotspots: true,
  },
  map: { liveStatus: true, forecastView: true },
  community: { shareUpdate: true, reportIncident: true, filters: true },
  assistant: { quickQuestions: true, capabilities: true },
  alerts: { traffic: true, maintenance: true },
};

export const DEFAULT_MOBILE_CONFIG: MobileConfig = {
  features: deriveFeatures(DEFAULT_SECTIONS),
  sections: DEFAULT_SECTIONS,
  advisories: [],
  advisory: { active: false, tone: "info", message: "" },
};
