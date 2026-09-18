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
 *   advisory.*  — a broadcast notice, posted into the Alerts list.
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

const AdvisorySchema = z
  .object({
    active: z.boolean(),
    tone: z.enum(ADVISORY_TONES),
    // Long enough for a real closure notice, short enough to read on a phone
    // without the card becoming a wall of text.
    message: z.string().trim().max(280),
  })
  .refine((v) => !v.active || v.message.length >= 8, {
    // Publishing an empty advisory would push a blank card to every phone.
    message: "An advisory needs a message of at least 8 characters before it can be published",
    path: ["message"],
  });

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
    advisory: AdvisorySchema,
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
    advisory: cfg.advisory,
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
  advisory: { active: false, tone: "info", message: "" },
};
