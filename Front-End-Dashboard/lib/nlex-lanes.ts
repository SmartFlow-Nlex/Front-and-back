/**
 * Carriageway width along the NLEX corridor, by km-post range.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS TABLE IS EMPTY ON PURPOSE. FILL IT FROM AN AUTHORITATIVE SOURCE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The sandbox needs to know how many lanes the selected stretch of road
 * actually has, because a closure on a 3-lane segment is a very different event
 * from the same closure on a 5-lane one — it is the difference between losing a
 * third of capacity and losing a fifth.
 *
 * That figure is not in the warehouse. There is no lane column on nlex_exits,
 * nothing in the init schema, and neither the NLEX Exits reference PDF (place,
 * access, coordinates only) nor the 258-page manuscript states the corridor's
 * lane configuration — the manuscript discusses lane CLOSURES as a feature
 * without ever saying how wide the road is.
 *
 * Rather than guess, this file is left for someone who can cite a source:
 * NLEX Corporation / MPTC published data, a DPWH or TRB reference, or the
 * team's own field survey. Until a range is filled in, the sandbox says the
 * segment is unconfigured and lets the operator set the width by hand, which is
 * honest. Inventing plausible numbers here would put an unverifiable figure
 * underneath every capacity result the panel produces.
 *
 * TO FILL IN: add one entry per stretch where the width changes, in km-posts
 * measured from Balintawak (km 0) to Sta. Ines (km 76.25), the same scale
 * nlex-exits.ts uses. Ranges are [fromKm, toKm) — inclusive of the start,
 * exclusive of the end — and should not overlap. `lanes` is per direction.
 *
 * Example of the shape once known (VALUES ARE ILLUSTRATIVE, NOT REAL):
 *   { fromKm: 0,  toKm: 15.2, lanes: 5, source: "NLEX Corp segment plan 2024" },
 *   { fromKm: 15.2, toKm: 46, lanes: 4, source: "NLEX Corp segment plan 2024" },
 */

export type LaneSegment = {
  /** Km-post where this width begins, inclusive. Balintawak is 0. */
  fromKm: number;
  /** Km-post where it ends, exclusive. */
  toKm: number;
  /** Through lanes per direction, excluding shoulders and ramps. */
  lanes: number;
  /** Where the figure came from. Required — an unsourced entry is a guess. */
  source: string;
};

/** Empty until filled from a citable source. See the note above. */
export const LANE_SEGMENTS: LaneSegment[] = [];

/**
 * Lane count for the stretch between two km-posts.
 *
 * Returns the NARROWEST width the route passes through, not the width at either
 * end. A journey from a 5-lane section into a 3-lane one is governed by the
 * 3-lane pinch — that is where the queue forms, and simulating the wider figure
 * would understate every closure on the route.
 *
 * Returns null when the corridor table does not cover the whole span, so the
 * caller can say "unknown" rather than present a default as fact.
 */
export function lanesForSegment(fromKm: number, toKm: number): number | null {
  if (LANE_SEGMENTS.length === 0) return null;

  const lo = Math.min(fromKm, toKm);
  const hi = Math.max(fromKm, toKm);
  // A zero-length route (same origin and destination) still has a width; treat
  // it as the single point rather than an empty span.
  const overlapping = LANE_SEGMENTS.filter((s) =>
    lo === hi ? lo >= s.fromKm && lo < s.toKm : s.fromKm < hi && s.toKm > lo,
  );
  if (overlapping.length === 0) return null;

  // Every kilometre of the route must be covered, or the narrowest known
  // section might not be the narrowest actual one.
  const covered = overlapping
    .map((s) => [Math.max(s.fromKm, lo), Math.min(s.toKm, hi)] as const)
    .sort((a, b) => a[0] - b[0]);
  let reach = lo;
  for (const [a, b] of covered) {
    if (a > reach + 1e-9) return null; // gap in the table
    reach = Math.max(reach, b);
  }
  if (reach < hi - 1e-9) return null;

  return Math.min(...overlapping.map((s) => s.lanes));
}

/** The sources behind a route's width, for showing provenance in the UI. */
export function laneSources(fromKm: number, toKm: number): string[] {
  const lo = Math.min(fromKm, toKm);
  const hi = Math.max(fromKm, toKm);
  return [
    ...new Set(
      LANE_SEGMENTS.filter((s) => s.fromKm < hi && s.toKm > lo).map((s) => s.source),
    ),
  ];
}
