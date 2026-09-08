/**
 * The corridor cut at every exit, in corridor order — "exit to next exit"
 * segments, the same shape the Home page's Live Corridor Status and the Live
 * Map's TrafficMapPanel already draw the road as (segment_name there is
 * built the identical way: `${exitNames[i]} to ${exitNames[i + 1]}`).
 *
 * Before this, the Incident module's own "By Km" views each invented their
 * own bins — fixed 5km buckets in one card, equal-incident-count quantile
 * bins in another — neither of which corresponded to a segment name a reader
 * would recognize, and the two disagreed with each other. Both now build
 * their segments from here, so a segment can no longer drift between cards.
 *
 * The trade-off, made explicitly rather than accidentally: exits sit
 * anywhere from 0.4km apart (Bocaue Barrier/Interchange) to 11.6km apart
 * (Pulilan to San Simon), so a long inter-exit stretch is one segment here —
 * finer resolution within it (e.g. "where in that 11.6km" risk concentrates)
 * is no longer visible the way the old fixed-width bins showed it.
 */

export type ExitRef = { exit_id: number; exit_name: string; km: number };

export type ExitToExitSegment = {
  segmentStart: number;
  segmentEnd: number;
  label: string;
  fromExitId: number;
  toExitId: number;
};

/** exits.length - 1 segments, each spanning one consecutive pair of exits. */
export function buildExitToExitSegments(exits: ExitRef[]): ExitToExitSegment[] {
  const sorted = [...exits].sort((a, b) => a.km - b.km);
  const segments: ExitToExitSegment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    segments.push({
      segmentStart: sorted[i].km,
      segmentEnd: sorted[i + 1].km,
      label: `${sorted[i].exit_name} to ${sorted[i + 1].exit_name}`,
      fromExitId: sorted[i].exit_id,
      toExitId: sorted[i + 1].exit_id,
    });
  }
  return segments;
}

/**
 * Which segment a km position falls in. A location just south of the first
 * exit or north of the last one clamps to that end segment rather than being
 * dropped — the exit list spans the corridor, but a resolved km can sit a
 * touch outside it in the raw data.
 */
export function segmentIndexForKm(km: number, segments: ExitToExitSegment[]): number {
  if (segments.length === 0) return -1;
  if (km <= segments[0].segmentStart) return 0;
  if (km >= segments[segments.length - 1].segmentEnd) return segments.length - 1;
  for (let i = 0; i < segments.length; i++) {
    if (km >= segments[i].segmentStart && km < segments[i].segmentEnd) return i;
  }
  return segments.length - 1;
}
