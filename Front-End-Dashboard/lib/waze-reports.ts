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

/* Waze scores every report twice, and the two are easy to misread.
 *
 *   reliability, 0-10, starts at 5 and rises with corroboration. It drops below
 *   5 only when a high-ranked editor files a "not there".
 *
 *   confidence, -1 to 5, is driven by other users' reactions. It is -1 only
 *   after two "not there" reports with nothing positive against them.
 *
 * Measured over 46 distinct NLEX reports, the two are almost a single signal:
 * reliability 5-6 always came with confidence 0, 7-8 with 0 or 1, and only
 * reliability 10 reached confidence 2 or more. Both are corroboration-over-time,
 * so any threshold above the floor is really an age filter — 57% of reports sat
 * at confidence 0, meaning "nobody has reacted yet", and a report thirty seconds
 * old necessarily looks like that. Hiding those would hide the freshest
 * incidents on a live map, which is the opposite of what it is for.
 *
 * So visibility turns only on explicit disagreement, not on absence of praise.
 */

/* Missing is unknown, not disputed. Number(null) is 0, which would read as a
   reliability below the floor and quietly drop every report the feed scored as
   null — the opposite of the intent, since a report with no scores has had
   nothing said against it either. */
const score = (v: unknown): number =>
  v === null || v === undefined || v === "" ? NaN : Number(v);

/** The only two values that mean somebody disputed the report. */
export function isDisputedReport(props: Record<string, unknown> | null | undefined): boolean {
  const reliability = score(props?.reliability);
  const confidence = score(props?.confidence);
  return (Number.isFinite(confidence) && confidence <= -1)
    || (Number.isFinite(reliability) && reliability < 5);
}

/**
 * Reported, but nothing has corroborated it yet — the floor Waze starts every
 * report at. Drawn faintly rather than hidden: it is real until disputed, and
 * a fresh incident is exactly this until somebody reacts to it.
 */
export function isUnconfirmedReport(props: Record<string, unknown> | null | undefined): boolean {
  const reliability = score(props?.reliability);
  const confidence = score(props?.confidence);
  return Number.isFinite(reliability) && reliability <= 5
    && Number.isFinite(confidence) && confidence <= 0;
}

/** True for a feature that should count towards Active Reports. */
export function isActiveReport(f: { properties?: Record<string, unknown> | null } | null): boolean {
  const p = f?.properties;
  // Density is not a report, so jam lines are excluded by feature_type here.
  return p?.feature_type === "alert" && isReportType(p?.type) && !isDisputedReport(p);
}
