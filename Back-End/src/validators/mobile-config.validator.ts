import { z } from "zod";

/**
 * The contract between the dashboard's Mobile Control Centre and the mobile app.
 *
 * Every switch here is one the app actually honours. That constraint is the
 * whole point: a control panel whose toggles do nothing is worse than no panel,
 * because an operator turns Community off, sees the switch move, and believes
 * the tab is gone. Before adding a field, wire it in the app first.
 *
 * Currently honoured by the app:
 *   features.*  -> frontend/app/(tabs)/_layout.tsx hides the tab
 *   advisory.*  -> frontend/alerts/AlertsProvider.tsx posts it as an alert
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

export const MobileConfigSchema = z.object({
  features: FeaturesSchema,
  advisory: AdvisorySchema,
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
  advisory: { active: false, tone: "info", message: "" },
};
