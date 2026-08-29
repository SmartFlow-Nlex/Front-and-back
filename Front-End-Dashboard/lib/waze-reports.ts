/**
 * Which Waze records count as a "report".
 *
 * The feed carries two different things and they must not be added together. A
 * jam LineString is traffic *density* — a measurement of how fast the road is
 * moving, and what colours the corridor. An alert is a *report*: a person told
 * Waze something is there. Counting density as reports made the Active Reports
 * tile a mix of two units.
 *
 * The set below matches the legend exactly, so anything counted is also drawn
 * and named in the key.
 *
 * Note that the live feed also emits ROAD_CLOSED, which is not in this set and
 * is therefore neither counted nor drawn. That is a deliberate omission to keep
 * the tile and the legend in step, not a claim that road closures do not matter
 * — add it here and to the legend together if it should appear.
 */

export const WAZE_REPORT_TYPES = [
  "JAM",
  "CONSTRUCTION",
  "POLICE",
  "ACCIDENT",
  "HAZARD",
] as const;

export type WazeReportType = (typeof WAZE_REPORT_TYPES)[number];

const SET = new Set<string>(WAZE_REPORT_TYPES);

/** True for an alert whose type is one of the reported categories. */
export function isReportType(type: unknown): boolean {
  return typeof type === "string" && SET.has(type.toUpperCase());
}

/** True for a feature that should count towards Active Reports. */
export function isActiveReport(f: { properties?: Record<string, unknown> | null } | null): boolean {
  const p = f?.properties;
  // Density is not a report, so jam lines are excluded by feature_type here.
  return p?.feature_type === "alert" && isReportType(p?.type);
}
