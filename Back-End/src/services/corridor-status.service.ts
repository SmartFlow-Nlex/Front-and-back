import { db } from "../config/db.js";

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

  try {
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
  } catch (err) {
    console.error("Database query failed for corridor status:", err);
    return null;
  }
}
