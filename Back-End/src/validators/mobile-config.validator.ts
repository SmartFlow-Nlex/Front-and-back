import { z } from "zod";

/**
 * The contract between the dashboard's Mobile Control Centre and the mobile app.
 *
 * Every switch here is one the app actually honours. That constraint is the
 * whole point: a control panel whose toggles do nothing is worse than no panel,
 * because an operator turns Community off, sees the switch move, and believes
 * the tab is gone. Before adding a field, wire it in the app first.
 *
 * Two levels:
 *   features.*  — whether a TAB exists at all. Honoured in (tabs)/_layout.tsx,
 *                 which sets href: null so the route stops resolving too.
 *   sections.*  — what is inside each tab. Honoured by the screen itself.
 *   advisory.*  — a broadcast notice, posted into the Alerts list.
 */

// Mirrors the five tabs in frontend/app/(tabs)/_layout.tsx. The keys are the
// Expo route names, so a mismatch here is a mismatch the app can detect.
export const MOBILE_FEATURES = ["dashboard", "map", "community", "assistant", "alerts"] as const;
export type MobileFeature = (typeof MOBILE_FEATURES)[number];

export const ADVISORY_TONES = ["info", "warning", "critical"] as const;
export type AdvisoryTone = (typeof ADVISORY_TONES)[number];

const FeaturesSchema = z.object({
  dashboard: z.boolean(),
  map: z.boolean(),
  community: z.boolean(),
  assistant: z.boolean(),
  alerts: z.boolean(),
});

/* ── Sections ──────────────────────────────────────────────────────────────
 *
 * Every field defaults to true, and every group defaults to {}. That is what
 * lets a row written before sections existed still parse: an old document
 * simply has no `sections` key, and zod fills the whole tree in as "on"
 * rather than failing validation and dropping the operator's feature flags
 * back to defaults. The same property means a dashboard that gains a section
 * does not invalidate rows saved by the build before it.
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
 * Tabs that would render an empty screen if every section inside them were
 * switched off.
 *
 * Turning a whole tab off is a legitimate thing to do and has its own switch.
 * Leaving the tab ON while emptying it is not: the user taps it and finds a
 * blank page, which reads as a broken app rather than as a decision. These are
 * refused at the API so it cannot happen by a stray click in the UI either.
 *
 * Assistant is absent deliberately — with quickQuestions off it still has a
 * working chat box, so an empty-section assistant is not an empty screen.
 */
const NON_EMPTY: { feature: MobileFeature; label: string; keys: string[] }[] = [
  {
    feature: "dashboard",
    label: "Dashboard",
    keys: ["statusSummary", "segmentForecast", "corridorOutlook", "eventForecasts", "mlHotspots"],
  },
  { feature: "map", label: "Corridor", keys: ["liveStatus", "forecastView"] },
  { feature: "alerts", label: "Alerts", keys: ["traffic", "maintenance"] },
];

export const MobileConfigSchema = z
  .object({
    features: FeaturesSchema,
    sections: SectionsSchema,
    advisory: AdvisorySchema,
  })
  .superRefine((cfg, ctx) => {
    for (const { feature, label, keys } of NON_EMPTY) {
      // A tab that is switched off may hold whatever it likes; nobody sees it.
      if (!cfg.features[feature]) continue;
      const group = cfg.sections[feature] as Record<string, boolean>;
      if (keys.some((k) => group[k])) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sections", feature],
        message: `${label} needs at least one section switched on, or the tab opens to an empty screen. Switch the whole tab off instead.`,
      });
    }
  });

export type MobileConfig = z.infer<typeof MobileConfigSchema>;

/**
 * Served when the table has not been created yet, or when the database cannot
 * be reached on a read.
 *
 * Deliberately fails OPEN — every feature on, no advisory. A feature-flag
 * service that fails closed takes the whole app down with it the moment RDS
 * hiccups, which is a far worse outcome than briefly ignoring an operator's
 * switch. Reads say which of the two they are returning via `source`, so
 * "everything is on" is never silently mistaken for "an operator chose this".
 */
export const DEFAULT_MOBILE_CONFIG: MobileConfig = {
  features: { dashboard: true, map: true, community: true, assistant: true, alerts: true },
  sections: {
    dashboard: {
      statusSummary: true,
      segmentForecast: true,
      corridorOutlook: true,
      eventForecasts: true,
      mlHotspots: true,
    },
    map: { liveStatus: true, forecastView: true },
    community: { shareUpdate: true, reportIncident: true, filters: true },
    assistant: { quickQuestions: true },
    alerts: { traffic: true, maintenance: true },
  },
  advisory: { active: false, tone: "info", message: "" },
};
