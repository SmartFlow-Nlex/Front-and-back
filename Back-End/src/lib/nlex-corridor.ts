/**
 * One definition of "on NLEX" and "is a report", shared by every endpoint that
 * counts or lists Waze records.
 *
 * These two tests used to live only inside the /real-time controller, so
 * /live-overview — which feeds the maximised panel's sidebar — applied neither.
 * It counted every alert within 3 km of an exit, of any type, which is why the
 * expanded Active Reports tile disagreed with the collapsed one and why the
 * Current alerts list filled with MacArthur Hwy, Maysan Rd and West Service Rd.
 * Both figures now come through here, so they cannot drift apart again.
 */

/**
 * True when a Waze street name is the NLEX mainline.
 *
 * Matching on "expressway" or "ah26" alone leaks in SLEX, Skyway and the rest of
 * the network, so the name must say NLEX or North Luzon. Service roads,
 * interchanges and crossings are then excluded: they sit within metres of the
 * corridor and would otherwise be reported as activity on it.
 */
export function isNlexCorridorStreet(street: string | null | undefined): boolean {
  const s = (street || "").toLowerCase();
  if (!s) return false;
  const hasNlex = s.includes("nlex") || s.includes("north luzon");
  const isServiceOrCrossRoad =
    s.includes("service") || s.includes("crossing") || s.includes("exit rd") ||
    s.includes("interchange service") || s.includes("halili") || s.includes("dulalia") ||
    s.includes("tullahan") || s.includes("libtong") || s.includes("slex") ||
    s.includes("skyway") || s.includes("sctex") || s.includes("tplex") ||
    s.includes("cavitex");
  return hasNlex && !isServiceOrCrossRoad;
}

/**
 * The alert categories that count as a report and are drawn as pins.
 *
 * JAM is deliberately absent. A jam is traffic *density* — it is drawn as the
 * coloured ribbon on the road and already described by the density legend, so
 * counting it here would add a measurement to a tally of reports and double
 * count the congestion the corridor is already showing.
 */
export const WAZE_REPORT_TYPES = [
  "ACCIDENT",
  "HAZARD",
  "CONSTRUCTION",
  "ROAD_CLOSED",
  "POLICE",
] as const;

const REPORT_SET = new Set<string>(WAZE_REPORT_TYPES);

/** True when an alert's type is one of the drawn, counted categories. */
export function isWazeReportType(type: string | null | undefined): boolean {
  return typeof type === "string" && REPORT_SET.has(type.toUpperCase());
}
