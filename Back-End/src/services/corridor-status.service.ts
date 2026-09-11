import { db } from "../config/db.js";
import { searchExitsInDb } from "./map-comparison.service.js";

/**
 * Live per-exit corridor status, from the same Waze feed the Live Map uses.
 *
 * The Home tab's corridor diagram was driven by three hardcoded datasets. This
 * replaces them with the jams the ingester is writing into
 * silver.fact_waze_jams, which lands roughly every few minutes.
 *
 * Two things make this readable as a corridor status rather than a jam list:
 *
 *  - Absence is information. Waze only emits a jam record where there IS a jam,
 *    so an exit with no recent row is flowing freely, not missing data. Every
 *    exit therefore starts green and is darkened only by evidence.
 *
 *  - Direction comes from the jam's own geometry. The feed has no direction
 *    field, but each jam is a LINESTRING, so the bearing from its start point to
 *    its end point says which way the stalled traffic was pointing. NLEX runs
 *    roughly north-south, so a northward bearing is NB. Across the full history
 *    this splits 13.2k/14.1k NB/SB, which is the even split a bidirectional
 *    corridor should give and a decent check that the derivation is sound.
 *
 * NAMED_ONLY matches are excluded: those sit ~3.9 km from the corridor and were
 * matched on a street name alone, so they describe somewhere else.
 *
 * Jams must also be on NLEX by the name Waze gave them, the same test the map
 * applies before painting a ribbon. Position alone is not enough: the local road
 * network runs within metres of the corridor for most of its length, and
 * counting it made this panel disagree with the map about the whole road.
 */

export type SegmentStatus = "clear" | "slow" | "congested";

export type ExitStatus = {
  exit: string;
  direction: "NB" | "SB";
  status: SegmentStatus;
  /** Worst Waze jam level seen in the window, 1-5. Null when nothing was seen. */
  level: number | null;
  /** Slowest speed seen, km/h. Null when nothing was seen. */
  speedKmh: number | null;
  jamCount: number;
  observedAt: string | null;
};

/**
 * Waze grades a jam 0-5 as a share of free-flow speed: 0 is 100-80% of free flow,
 * 1 is 80-61%, 2 is 60-41%, 3 is 40-21%, 4 is 20-1%, and 5 is a blocked road.
 *
 * Splitting at 3 puts everything below half of free-flow speed in red and leaves
 * the merely slow in amber. That matches what the levels carry here: on this
 * corridor level 1 averages 23 km/h, 2 about 16, 3 about 9, 4 about 4, and 5 a
 * standstill.
 *
 * Level 0 is free flow BY DEFINITION, so it returns clear rather than falling
 * through to slow. No level-0 row has appeared in the feed — Waze only emits a
 * jam where there is congestion — but the field is documented as 0-5 and a
 * record that says "free flow" must not be painted amber if one ever arrives.
 */
function classify(level: number | null, speedKmh: number | null): SegmentStatus {
  if (level == null && speedKmh == null) return "clear";
  if (level === 0) return "clear";
  if ((level != null && level >= 3) || (speedKmh != null && speedKmh < 10)) return "congested";
  return "slow";
}

const WINDOW_MINUTES = 60;

export async function getCorridorStatus() {
  // Same guard the other services use: no pool configured means no data, and the
  // controller turns that into an explicit "unavailable" rather than a crash.
  if (!db) return null;

  const { rows } = await db.query<{
    exit_name: string;
    direction: "NB" | "SB";
    worst_level: number | null;
    min_speed: number | null;
    jam_count: number;
    newest: Date | null;
  }>(
    `WITH recent AS (
       SELECT j.nlex_exit_id,
              j.level,
              j.speed_kmh,
              j.last_seen_at,
              ST_LineMerge(j.geom) AS g
       FROM silver.fact_waze_jams j
       WHERE j.corridor_match IN ('ON_CORRIDOR', 'NEAR_CORRIDOR')
         AND j.last_seen_at > NOW() - ($1 || ' minutes')::interval
         AND j.geom IS NOT NULL
         /* On NLEX by name, not merely near it.

            corridor_match alone admits anything the matcher put within reach of
            an exit, and the local road network runs right alongside: a live
            sample had this panel reporting jams on Gen. T. De Leon, Governor
            Padilla Road, M. Villarica Road, Tullahan and Maysan Road as exit
            conditions, 172 jams where the map drew 21. It coloured nearly every
            exit on the panel amber or red while the map showed a mostly clear
            corridor.

            This is isNlexCorridorStreet from lib/nlex-corridor.ts written as
            SQL, because the aggregation happens in the query. Keep the two in
            step: the map applies the same test to the jams it paints with. */
         AND (LOWER(j.street) LIKE '%nlex%' OR LOWER(j.street) LIKE '%north luzon%')
         AND LOWER(j.street) NOT LIKE '%service%'
         AND LOWER(j.street) NOT LIKE '%crossing%'
         AND LOWER(j.street) NOT LIKE '%exit rd%'
         AND LOWER(j.street) NOT LIKE '%halili%'
         AND LOWER(j.street) NOT LIKE '%dulalia%'
         AND LOWER(j.street) NOT LIKE '%tullahan%'
         AND LOWER(j.street) NOT LIKE '%libtong%'
         AND LOWER(j.street) NOT LIKE '%slex%'
         AND LOWER(j.street) NOT LIKE '%skyway%'
         AND LOWER(j.street) NOT LIKE '%sctex%'
         AND LOWER(j.street) NOT LIKE '%tplex%'
         AND LOWER(j.street) NOT LIKE '%cavitex%'
     ),
     bearing AS (
       SELECT nlex_exit_id, level, speed_kmh, last_seen_at,
              DEGREES(ST_Azimuth(ST_StartPoint(g), ST_EndPoint(g))) AS az
       FROM recent
       WHERE GeometryType(g) = 'LINESTRING'
     )
     SELECT e.exit_name,
            CASE WHEN b.az < 90 OR b.az > 270 THEN 'NB' ELSE 'SB' END AS direction,
            MAX(b.level)::int                      AS worst_level,
            ROUND(MIN(b.speed_kmh)::numeric, 1)::float AS min_speed,
            COUNT(*)::int                          AS jam_count,
            MAX(b.last_seen_at)                    AS newest
     FROM bearing b
     JOIN nlex_exits e ON e.id = b.nlex_exit_id
     WHERE b.az IS NOT NULL
     GROUP BY e.exit_name, 2`,
    [WINDOW_MINUTES],
  );

  const segments: ExitStatus[] = rows.map((r) => ({
    exit: r.exit_name,
    direction: r.direction,
    status: classify(r.worst_level, r.min_speed),
    level: r.worst_level,
    speedKmh: r.min_speed,
    jamCount: r.jam_count,
    observedAt: r.newest ? new Date(r.newest).toISOString() : null,
  }));

  // How current the feed itself is, separate from the query time. If the
  // ingester stalls, this is what tells the reader the picture is stale rather
  // than the corridor being empty.
  const { rows: freshRows } = await db.query<{ newest: Date | null }>(
    `SELECT MAX(last_seen_at) AS newest FROM silver.fact_waze_jams`,
  );
  const feedNewest = freshRows[0]?.newest ? new Date(freshRows[0].newest) : null;
  const feedAgeMinutes = feedNewest ? (Date.now() - feedNewest.getTime()) / 60000 : null;

  return {
    windowMinutes: WINDOW_MINUTES,
    segments,
    feed: {
      newestAt: feedNewest ? feedNewest.toISOString() : null,
      ageMinutes: feedAgeMinutes != null ? Math.round(feedAgeMinutes * 10) / 10 : null,
      // Under 30 minutes the picture is current enough to act on; past that the
      // UI says so rather than presenting stale rows as now.
      stale: feedAgeMinutes == null || feedAgeMinutes > 30,
    },
    generatedAt: new Date().toISOString(),
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
   MERGED CORRIDOR VIEW  (mobile clients)

   getCorridorStatus() above returns only the exits Waze reported a jam on —
   around ten rows out of forty exit/direction pairs. Rendering a corridor from
   it takes three rules that are not in the payload:

     1. absence means clear, so every pair starts green and is darkened only by
        evidence;
     2. the live rows join to the exit list by NAME, there being no exit id in
        the feed;
     3. a direction with no ramp is not clear, it is not a road — it draws as
        bare tarmac and is left out of the tally.

   The dashboard implements all three in the browser. A second client
   reimplementing them is a second chance to get them wrong, and the failure is
   quiet: the map still renders, it just disagrees with the dashboard about the
   road. So this resolves them once, server-side, and hands back every exit in
   both directions with its status already decided.

   The panel's own numbers are the specification here — the tally counts pairs
   with a ramp, which is why 20 exits give 40 pairs and the header adds up.
══════════════════════════════════════════════════════════════════════════════ */

export type DirectionStatus = {
  status: SegmentStatus;
  level: number | null;
  speedKmh: number | null;
  jamCount: number;
  observedAt: string | null;
  /** "Entry & Exit" | "Entry Only" | "Exit Only" | "No Access", null at a barrier. */
  access: string | null;
  /**
   * Whether to draw this direction as road at all. False only for "No Access",
   * where the exit has no ramp this way — paint it as bare tarmac rather than
   * green, because nothing is flowing there to be clear.
   *
   * True at a toll barrier despite there being no ramp: a mainline barrier
   * carries live traffic in both directions, so it is a road with a status.
   * Bocaue Barrier is the corridor's only one. This mirrors the dashboard,
   * whose tally likewise excludes just "No Access" — which is why 20 exits give
   * 40 counted pairs.
   */
  hasRamp: boolean;
};

/**
 * Per-direction access in words. Mirrors accessLabel() in the dashboard's
 * lib/nlex-exits so both clients describe a ramp the same way.
 */
function accessLabel(
  row: { nb_entry: boolean; nb_exit: boolean; sb_entry: boolean; sb_exit: boolean; node_type: string },
  dir: "NB" | "SB",
): string | null {
  if (row.node_type === "toll-barrier") return null;
  const entry = dir === "NB" ? row.nb_entry : row.sb_entry;
  const exit = dir === "NB" ? row.nb_exit : row.sb_exit;
  if (entry && exit) return "Entry & Exit";
  if (entry) return "Entry Only";
  if (exit) return "Exit Only";
  return "No Access";
}

/**
 * Label fixes for names the database stores title-cased, which mangles the
 * initialisms. exit_name stays the match key — it is what the live feed joins
 * on — so this is applied at the edge, as the dashboard does in displayExitName.
 */
const DISPLAY_NAMES: Record<string, string> = {
  "cdv/ph arena": "CDV/PH Arena",
  sctex: "SCTEX",
};

function displayExitName(name: string): string {
  return DISPLAY_NAMES[name.toLowerCase().trim()] ?? name;
}

/** Both sides of the name join are nlex_exits.exit_name, so an exact match would
    do; normalising anyway costs nothing and survives a change of case upstream. */
function statusKey(name: string, dir: "NB" | "SB") {
  return `${name.toLowerCase().trim()}-${dir}`;
}

const NO_JAMS = {
  status: "clear" as SegmentStatus,
  level: null,
  speedKmh: null,
  jamCount: 0,
  observedAt: null,
};

export async function getCorridorStatusFull() {
  // Both halves come from the same database; a null from either means the pool
  // is not configured and the controller answers 503 rather than half a road.
  const [live, exitRows] = await Promise.all([getCorridorStatus(), searchExitsInDb("")]);
  if (!live || !exitRows) return null;

  const bySegment = new Map(live.segments.map((s) => [statusKey(s.exit, s.direction), s]));

  const counts = { congested: 0, slow: 0, clear: 0 };

  const exits = exitRows.map((x: any) => {
    const directions = {} as Record<"NB" | "SB", DirectionStatus>;

    for (const dir of ["NB", "SB"] as const) {
      const access = accessLabel(x, dir);
      const seen = bySegment.get(statusKey(x.exit_name, dir));
      const base = seen ?? NO_JAMS;

      directions[dir] = {
        status: base.status,
        level: base.level,
        speedKmh: base.speedKmh,
        jamCount: base.jamCount,
        observedAt: base.observedAt,
        access,
        hasRamp: access !== "No Access",
      };

      // A direction without a ramp is left out entirely, exactly as the panel
      // does: a tally that disagreed with what is drawn would be worse than none.
      if (access === "No Access") continue;
      counts[base.status]++;
    }

    return {
      exit_id: x.exit_id,
      exit_name: x.exit_name,
      display_name: displayExitName(x.exit_name),
      km: x.km ?? null,
      latitude: x.latitude,
      longitude: x.longitude,
      node_type: x.node_type,
      directions,
    };
  });

  return {
    windowMinutes: live.windowMinutes,
    generatedAt: live.generatedAt,
    feed: live.feed,
    counts,
    exits,
  };
}
