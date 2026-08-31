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
 * and named in the key. It also matches WAZE_REPORT_TYPES in the backend's
 * lib/nlex-corridor.ts, which is what the Active Reports tile and the Current
 * alerts list are now both filtered by — the two used to disagree.
 *
 * Two corrections are baked in here:
 *
 *   JAM was counted but never drawn. Jam points are density: they are already
 *   the coloured ribbon on the road and the Light..Standstill legend above.
 *   Counting them made the tile a mix of two units and promised 25 pins that
 *   did not exist.
 *
 *   ROAD_CLOSED was drawn in the legend but filtered out of the data, so the
 *   key named a category the map never showed. It is a real point report and
 *   now counts like the rest.
 */

export const WAZE_REPORT_TYPES = [
  "ACCIDENT",
  "HAZARD",
  "CONSTRUCTION",
  "ROAD_CLOSED",
  "POLICE",
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
