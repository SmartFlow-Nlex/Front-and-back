import { db } from "../config/db.js";

/**
 * Everything the Waze panel's overview sidebar shows, from the live feeds.
 *
 * Two sources, both writing continuously:
 *   - silver.fact_waze_jams   — one row per jam, with speed, level, length and
 *                               Waze's own delay estimate
 *   - bronze.waze_raw_alerts  — the raw alert feed, one JSON array per fetch
 *
 * Nothing here is a constant standing in for data. Where a figure could not be
 * derived it is not reported: see the note on travel time below.
 */

/** How far back a jam or alert still counts as "now". */
const WINDOW_MINUTES = 60;

/** An alert is on the corridor if it sits within this of an exit. */
const CORRIDOR_RADIUS_M = 3000;

export type LiveAlert = {
  type: string;
  street: string | null;
  city: string | null;
  nearestExit: string;
  metresFromExit: number;
  publishedAt: string | null;
  minutesAgo: number | null;
  reliability: number | null;
};

export async function getLiveCorridorOverview() {
  if (!db) return null;

  const WINDOW = `last_seen_at > NOW() - interval '${WINDOW_MINUTES} minutes'`;
  const ON_CORRIDOR = `corridor_match IN ('ON_CORRIDOR', 'NEAR_CORRIDOR')`;

  const [totals, byExit, alerts, timeline, feed] = await Promise.all([
    // Corridor-wide state. delay_seconds is Waze's own estimate of how much
    // longer a jam makes its stretch take, so summing it gives the delay a
    // driver crossing all of them would accumulate.
    db.query<{
      jams: number; avg_speed: number | null; min_speed: number | null;
      jam_metres: number | null; delay_seconds: number | null; worst_level: number | null;
    }>(
      `SELECT COUNT(*)::int                                   AS jams,
              ROUND(AVG(speed_kmh)::numeric, 1)::float        AS avg_speed,
              ROUND(MIN(speed_kmh)::numeric, 1)::float        AS min_speed,
              SUM(length_meters)::int                         AS jam_metres,
              SUM(delay_seconds)::int                         AS delay_seconds,
              MAX(level)::int                                 AS worst_level
       FROM silver.fact_waze_jams
       WHERE ${ON_CORRIDOR} AND ${WINDOW}`,
    ),

    // Per-exit, for the density strip and the slowest-stretch callout.
    db.query<{ exit_name: string; avg_speed: number; worst_level: number; jams: number; delay_seconds: number | null }>(
      `SELECT e.exit_name,
              ROUND(AVG(j.speed_kmh)::numeric, 1)::float AS avg_speed,
              MAX(j.level)::int                          AS worst_level,
              COUNT(*)::int                              AS jams,
              SUM(j.delay_seconds)::int                  AS delay_seconds
       FROM silver.fact_waze_jams j
       JOIN nlex_exits e ON e.id = j.nlex_exit_id
       WHERE j.corridor_match IN ('ON_CORRIDOR', 'NEAR_CORRIDOR')
         AND j.last_seen_at > NOW() - interval '60 minutes'
       GROUP BY e.exit_name
       ORDER BY avg_speed ASC`,
    ),

    // The alert feed arrives as one JSON array per fetch, so the newest row is
    // the current picture. Each alert is matched to its nearest exit and kept
    // only if it is close enough to be about this road.
    db.query<{
      type: string; street: string | null; city: string | null;
      exit_name: string; metres: number; pub: string | null; reliability: number | null;
    }>(
      `WITH latest AS (
         SELECT raw_data FROM bronze.waze_raw_alerts ORDER BY ingested_at DESC LIMIT 1
       ), a AS (
         SELECT x,
                (x->'location'->>'x')::float AS lon,
                (x->'location'->>'y')::float AS lat
         FROM latest, LATERAL jsonb_array_elements(raw_data::jsonb) AS x
         WHERE x->'location' IS NOT NULL
       )
       SELECT a.x->>'type'                    AS type,
              NULLIF(a.x->>'street', '')      AS street,
              NULLIF(a.x->>'city', '')        AS city,
              e.exit_name,
              ROUND(e.d)::int                 AS metres,
              a.x->>'pubDate'                 AS pub,
              (a.x->>'reliability')::int      AS reliability
       FROM a
       JOIN LATERAL (
         SELECT exit_name,
                ST_DistanceSphere(ST_MakePoint(a.lon, a.lat), ST_MakePoint(longitude, latitude)) AS d
         FROM nlex_exits
         ORDER BY ST_DistanceSphere(ST_MakePoint(a.lon, a.lat), ST_MakePoint(longitude, latitude)) ASC
         LIMIT 1
       ) e ON TRUE
       WHERE e.d < $1
       ORDER BY a.x->>'pubDate' DESC NULLS LAST`,
      [CORRIDOR_RADIUS_M],
    ),

    // Speed over the last few hours, bucketed, for the timeline scrubber.
    db.query<{ bucket: Date; avg_speed: number; jams: number }>(
      `SELECT date_trunc('hour', last_seen_at)
                + (floor(EXTRACT(minute FROM last_seen_at) / 15) * interval '15 minutes') AS bucket,
              ROUND(AVG(speed_kmh)::numeric, 1)::float AS avg_speed,
              COUNT(*)::int                            AS jams
       FROM silver.fact_waze_jams
       WHERE ${ON_CORRIDOR} AND last_seen_at > NOW() - interval '3 hours'
       GROUP BY 1 ORDER BY 1`,
    ),

    db.query<{ jams_at: Date | null; alerts_at: Date | null }>(
      `SELECT (SELECT MAX(last_seen_at) FROM silver.fact_waze_jams)   AS jams_at,
              (SELECT MAX(ingested_at)  FROM bronze.waze_raw_alerts)  AS alerts_at`,
    ),
  ]);

  const t = totals.rows[0];

  const parsedAlerts: LiveAlert[] = alerts.rows.map((r) => {
    const at = r.pub ? new Date(r.pub) : null;
    const ok = at && !Number.isNaN(at.getTime());
    return {
      type: r.type,
      street: r.street,
      city: r.city,
      nearestExit: r.exit_name,
      metresFromExit: r.metres,
      publishedAt: ok ? at.toISOString() : null,
      minutesAgo: ok ? Math.max(0, Math.round((Date.now() - at.getTime()) / 60000)) : null,
      reliability: r.reliability,
    };
  });

  const exits = byExit.rows;
  const slowest = exits[0] ?? null;

  const newestJam = feed.rows[0]?.jams_at ? new Date(feed.rows[0].jams_at) : null;
  const newestAlert = feed.rows[0]?.alerts_at ? new Date(feed.rows[0].alerts_at) : null;
  const ageMin = (d: Date | null) => (d ? Math.round(((Date.now() - d.getTime()) / 60000) * 10) / 10 : null);

  return {
    windowMinutes: WINDOW_MINUTES,

    /**
     * Speed here is the average WITHIN the jams Waze is reporting, not an
     * end-to-end corridor average — the feed only describes stretches that are
     * congested, so there is nothing in it about the clear kilometres between
     * them. Labelled accordingly in the UI.
     */
    speed: {
      avgInJamsKmh: t.avg_speed,
      slowestKmh: t.min_speed,
    },

    /**
     * Total delay across the corridor's current jams, from Waze's own per-jam
     * estimate. This is reported INSTEAD of an absolute travel time: a
     * door-to-door figure needs a free-flow speed, and nothing in the warehouse
     * measures one — the jam feed only ever observes congested traffic. Inventing
     * a limit to divide by would make the headline number an assumption wearing a
     * measurement's clothes.
     */
    delay: {
      seconds: t.delay_seconds ?? 0,
      jamMetres: t.jam_metres ?? 0,
    },

    activeReports: parsedAlerts.length,
    jamCount: t.jams,
    worstLevel: t.worst_level,

    /** Per-exit, slowest first — drives the density strip and the callout. */
    exits: exits.map((r) => ({
      exit: r.exit_name,
      avgSpeedKmh: r.avg_speed,
      worstLevel: r.worst_level,
      jams: r.jams,
      delaySeconds: r.delay_seconds ?? 0,
    })),

    slowestExit: slowest
      ? { exit: slowest.exit_name, avgSpeedKmh: slowest.avg_speed, jams: slowest.jams }
      : null,

    alerts: parsedAlerts,

    timeline: timeline.rows.map((r) => ({
      at: new Date(r.bucket).toISOString(),
      avgSpeedKmh: r.avg_speed,
      jams: r.jams,
    })),

    feed: {
      jamsAt: newestJam ? newestJam.toISOString() : null,
      alertsAt: newestAlert ? newestAlert.toISOString() : null,
      jamsAgeMinutes: ageMin(newestJam),
      alertsAgeMinutes: ageMin(newestAlert),
      stale: (ageMin(newestJam) ?? 999) > 30,
    },

    generatedAt: new Date().toISOString(),
  };
}


/**
 * The live map's GeoJSON, built from the warehouse.
 *
 * The Redis path this used to come from authenticates but its keys hold zero
 * records, so the map drew an empty corridor. The same Waze feed is landing in
 * silver.fact_waze_jams and bronze.waze_raw_alerts every few minutes, and both
 * already carry geometry — the jams as LINESTRINGs, the alerts as points — so
 * the map can be drawn from what the database actually has.
 *
 * Shapes match what the Mapbox layers already filter on: feature_type "jam" for
 * the coloured lines and "alert" for the incident circles.
 */
export async function getLiveMapGeoJson() {
  if (!db) return { type: "FeatureCollection" as const, features: [] };

  const [jams, alerts] = await Promise.all([
    db.query<{ geojson: string; speed: number | null; level: number | null; street: string | null; city: string | null; delay: number | null; exit_name: string | null }>(
      `SELECT ST_AsGeoJSON(j.geom) AS geojson,
              ROUND(j.speed_kmh::numeric, 1)::float AS speed,
              j.level::int                          AS level,
              NULLIF(j.street, '')                  AS street,
              NULLIF(j.city, '')                    AS city,
              j.delay_seconds::int                  AS delay,
              e.exit_name
       FROM silver.fact_waze_jams j
       LEFT JOIN nlex_exits e ON e.id = j.nlex_exit_id
       WHERE j.corridor_match IN ('ON_CORRIDOR', 'NEAR_CORRIDOR')
         AND j.last_seen_at > NOW() - interval '${WINDOW_MINUTES} minutes'
         AND j.geom IS NOT NULL`,
    ),
    db.query<{ lon: number; lat: number; type: string; street: string | null; city: string | null; reliability: number | null; confidence: number | null; exit_name: string }>(
      `WITH latest AS (
         SELECT raw_data FROM bronze.waze_raw_alerts ORDER BY ingested_at DESC LIMIT 1
       ), a AS (
         SELECT x,
                (x->'location'->>'x')::float AS lon,
                (x->'location'->>'y')::float AS lat
         FROM latest, LATERAL jsonb_array_elements(raw_data::jsonb) AS x
         WHERE x->'location' IS NOT NULL
       )
       SELECT a.lon, a.lat,
              a.x->>'type'               AS type,
              NULLIF(a.x->>'street', '') AS street,
              NULLIF(a.x->>'city', '')   AS city,
              (a.x->>'reliability')::int AS reliability,
              (a.x->>'confidence')::int  AS confidence,
              e.exit_name
       FROM a
       JOIN LATERAL (
         SELECT exit_name,
                ST_DistanceSphere(ST_MakePoint(a.lon, a.lat), ST_MakePoint(longitude, latitude)) AS d
         FROM nlex_exits
         ORDER BY ST_DistanceSphere(ST_MakePoint(a.lon, a.lat), ST_MakePoint(longitude, latitude)) ASC
         LIMIT 1
       ) e ON TRUE
       WHERE e.d < $1`,
      [CORRIDOR_RADIUS_M],
    ),
  ]);

  const features = [
    ...jams.rows.map((r) => ({
      type: "Feature" as const,
      geometry: JSON.parse(r.geojson),
      properties: {
        feature_type: "jam",
        speed: r.speed ?? 0,
        level: r.level ?? 0,
        street: r.street ?? r.exit_name ?? "NLEX",
        city: r.city ?? "",
        delay_seconds: r.delay ?? 0,
        nearest_exit: r.exit_name ?? "",
      },
    })),
    ...alerts.rows.map((r) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [r.lon, r.lat] },
      properties: {
        feature_type: "alert",
        type: r.type,
        street: r.street ?? r.exit_name,
        city: r.city ?? "",
        reliability: r.reliability ?? 0,
        confidence: r.confidence ?? 0,
        nearest_exit: r.exit_name,
      },
    })),
  ];

  return { type: "FeatureCollection" as const, features };
}
