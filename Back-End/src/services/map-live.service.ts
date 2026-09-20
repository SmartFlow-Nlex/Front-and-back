import { db } from "../config/db.js";
import { nlexStreetSql } from "../utils/nlex-street.js";
import { isNlexCorridorStreet, isWazeReportType } from "../lib/nlex-corridor.js";

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
  /* Everything below exists so a click on a sidebar row can do what a click on
     the pin does: fly the map there and open the same detail panel. Without the
     coordinates the list had no position to send, and without the rest the
     panel would have shown less for a row than for the pin beside it. */
  uuid: string | null;
  lon: number | null;
  lat: number | null;
  subtype: string | null;
  confidence: number | null;
  reportRating: number | null;
  roadType: number | null;
  byMunicipality: boolean | null;
  heading: number | null;
};

export async function getLiveCorridorOverview() {
  if (!db) return null;

  const WINDOW = `last_seen_at > NOW() - interval '${WINDOW_MINUTES} minutes'`;
  const ON_CORRIDOR = `corridor_match IN ('ON_CORRIDOR', 'NEAR_CORRIDOR')`;
  /* Near an exit is not the same as on the expressway -- see utils/nlex-street.
     Without this the overview counted a dead-stopped barangay road as the
     corridor's slowest stretch while the map drew that exit green. */
  const ON_NLEX = nlexStreetSql("street");

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
       WHERE ${ON_CORRIDOR} AND ${WINDOW} AND ${ON_NLEX}`,
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
         AND ${nlexStreetSql("j.street")}
       GROUP BY e.exit_name
       ORDER BY avg_speed ASC`,
    ),

    // The alert feed arrives as one JSON array per fetch, so the newest row is
    // the current picture. Each alert is matched to its nearest exit and kept
    // only if it is close enough to be about this road.
    db.query<{
      type: string; street: string | null; city: string | null;
      exit_name: string; metres: number; pub: string | null; reliability: number | null;
      uuid: string | null; lon: number | null; lat: number | null; subtype: string | null;
      confidence: number | null; report_rating: number | null; road_type: number | null;
      by_municipality: string | null; heading: number | null;
    }>(
      `WITH latest AS (
         SELECT raw_data FROM bronze.waze_raw_alerts ORDER BY ingested_at DESC LIMIT 1
       ), expanded AS (
         SELECT x,
                (x->'location'->>'x')::float AS lon,
                (x->'location'->>'y')::float AS lat
         FROM latest, LATERAL jsonb_array_elements(raw_data::jsonb) AS x
         WHERE x->'location' IS NOT NULL
       ), a AS (
         /* One row per report.

            A single Waze snapshot repeats the same alert: in a live sample one
            uuid appeared three times and another twice, so fourteen rows were
            eleven reports. That inflated the Active Reports tile and stacked
            duplicate pins on the same spot, which is invisible on the map but
            counted. Keeping the highest-rated copy of each uuid means the row
            that survives is the best-attested one.

            Rows with no uuid cannot be compared, so they are left alone rather
            than being collapsed into a single nameless report. */
         SELECT DISTINCT ON (COALESCE(x->>'uuid', gen_random_uuid()::text))
                x, lon, lat
         FROM expanded
         ORDER BY COALESCE(x->>'uuid', gen_random_uuid()::text),
                  (x->>'reportRating')::int DESC NULLS LAST,
                  (x->>'reliability')::int  DESC NULLS LAST
       )
       SELECT a.x->>'type'                    AS type,
              NULLIF(a.x->>'street', '')      AS street,
              NULLIF(a.x->>'city', '')        AS city,
              e.exit_name,
              ROUND(e.d)::int                 AS metres,
              a.x->>'pubDate'                 AS pub,
              (a.x->>'reliability')::int      AS reliability,
              a.x->>'uuid'                    AS uuid,
              a.lon, a.lat,
              NULLIF(a.x->>'subtype', '')     AS subtype,
              (a.x->>'confidence')::int       AS confidence,
              (a.x->>'reportRating')::int     AS report_rating,
              (a.x->>'roadType')::int         AS road_type,
              a.x->>'reportByMunicipalityUser' AS by_municipality,
              (a.x->>'magvar')::int           AS heading
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
         AND ${ON_NLEX}
       GROUP BY 1 ORDER BY 1`,
    ),

    db.query<{ jams_at: Date | null; alerts_at: Date | null }>(
      `SELECT (SELECT MAX(last_seen_at) FROM silver.fact_waze_jams)   AS jams_at,
              (SELECT MAX(ingested_at)  FROM bronze.waze_raw_alerts)  AS alerts_at`,
    ),
  ]);

  const t = totals.rows[0];

  /* Only the mainline, and only reports.

     The SQL bounds alerts by distance to the nearest exit, which is necessary
     but not sufficient: a service road runs within metres of the corridor, so
     proximity alone pulled in MacArthur Hwy, Maysan Rd and West Service Rd. The
     street test is what makes this "on NLEX" rather than "near NLEX", and the
     type test drops jam points, which are density and are already drawn as the
     coloured ribbon. Both are the same tests the map itself applies, so the
     sidebar and the pins now count one thing. */
  const corridorAlerts = alerts.rows.filter(
    (r) => isNlexCorridorStreet(r.street) && isWazeReportType(r.type),
  );

  const parsedAlerts: LiveAlert[] = corridorAlerts.map((r) => {
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
      uuid: r.uuid ?? null,
      lon: r.lon ?? null,
      lat: r.lat ?? null,
      subtype: r.subtype ?? null,
      confidence: r.confidence ?? null,
      reportRating: r.report_rating ?? null,
      roadType: r.road_type ?? null,
      byMunicipality: r.by_municipality === "true",
      heading: r.heading ?? null,
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
 * How fresh the jam feed is, and how long a window the live map is reading.
 *
 * The Home tab's corridor panel needs this to say "last report 4 min ago", and
 * it was the only reason that panel had to call a second endpoint with its own
 * pipeline — which is how the two views came to disagree about the road. Served
 * alongside the features so one request answers both questions.
 */
export async function getFeedFreshness(): Promise<{
  windowMinutes: number;
  newestAt: string | null;
  ageMinutes: number | null;
  stale: boolean;
}> {
  const fallback = { windowMinutes: WINDOW_MINUTES, newestAt: null, ageMinutes: null, stale: true };
  if (!db) return fallback;
  try {
    const { rows } = await db.query<{ newest: Date | null }>(
      `SELECT MAX(last_seen_at) AS newest FROM silver.fact_waze_jams`,
    );
    const newest = rows[0]?.newest ? new Date(rows[0].newest) : null;
    const ageMinutes = newest ? (Date.now() - newest.getTime()) / 60000 : null;
    return {
      windowMinutes: WINDOW_MINUTES,
      newestAt: newest ? newest.toISOString() : null,
      ageMinutes: ageMinutes != null ? Math.round(ageMinutes * 10) / 10 : null,
      // Same threshold the corridor-status endpoint used, so the wording on the
      // panel does not change with the source.
      stale: (ageMinutes ?? 999) > 30,
    };
  } catch (error) {
    console.error("Database query failed for feed freshness:", error);
    return fallback;
  }
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
    db.query<{ geojson: string; speed: number | null; level: number | null; street: string | null; city: string | null; delay: number | null; exit_name: string | null; length_m: number | null; running_min: number | null; starts_at: string | null; starts_m: number | null }>(
      `SELECT ST_AsGeoJSON(j.geom) AS geojson,
              ROUND(j.speed_kmh::numeric, 1)::float AS speed,
              j.level::int                          AS level,
              NULLIF(j.street, '')                  AS street,
              NULLIF(j.city, '')                    AS city,
              j.delay_seconds::int                  AS delay,
              -- How far the queue stretches and how long it has been there.
              -- Both are Waze's own fields, populated on every row in the feed,
              -- so the hover card states measurements rather than estimates of
              -- its own. length_meters agrees with ST_Length(geom) to the metre,
              -- which is the check that the drawn line IS the queue.
              j.length_meters::int                  AS length_m,
              -- duration_minutes is only filled in once a jam clears (11 of 63
              -- live rows had it), and "going on for" is a live question, so
              -- fall back to how long this jam has actually been observed.
              -- first_seen_at is set on insert and present on every row.
              COALESCE(
                ROUND(j.duration_minutes)::int,
                GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - j.first_seen_at)) / 60)::int)
              )                                     AS running_min,
              e.exit_name,
              -- Where the queue BEGINS, and how far that is from the nearest
              -- exit: "starts 390 m from Marilao" is what a driver needs, and
              -- it is what the alerts panel already says about reports.
              --
              -- The start point is Waze's first vertex, which is only the
              -- upstream end if the line runs with the traffic. It does:
              -- checked against the direction Waze puts in the street name
              -- itself (" N" / " S"), the start-to-end bearing agreed on 40 of
              -- 40 live jams.
              --
              -- Nearest to the START, not to the whole line, and not the
              -- matched exit. Shortest distance to the line is meaningless
              -- here -- a long queue runs right past an exit, so it reads 2 m
              -- -- and the matched exit can sit in the MIDDLE of the queue,
              -- which had one 8.2 km jam reporting "6581 m from Marilao".
              s.exit_name AS starts_at,
              s.d         AS starts_m
       FROM silver.fact_waze_jams j
       LEFT JOIN nlex_exits e ON e.id = j.nlex_exit_id
       LEFT JOIN LATERAL (
         SELECT x.exit_name,
                ROUND(ST_DistanceSphere(
                  ST_StartPoint(ST_LineMerge(j.geom)),
                  ST_MakePoint(x.longitude, x.latitude)))::int AS d
         FROM nlex_exits x
         WHERE GeometryType(ST_LineMerge(j.geom)) = 'LINESTRING'
         ORDER BY ST_DistanceSphere(
                    ST_StartPoint(ST_LineMerge(j.geom)),
                    ST_MakePoint(x.longitude, x.latitude)) ASC
         LIMIT 1
       ) s ON TRUE
       WHERE j.corridor_match IN ('ON_CORRIDOR', 'NEAR_CORRIDOR')
         AND j.last_seen_at > NOW() - interval '${WINDOW_MINUTES} minutes'
         AND j.geom IS NOT NULL
         AND ${nlexStreetSql("j.street")}`,
    ),
    db.query<{
      lon: number; lat: number; type: string; street: string | null; city: string | null;
      reliability: number | null; confidence: number | null; exit_name: string;
      uuid: string | null; subtype: string | null; report_rating: number | null;
      road_type: number | null; by_municipality: string | null; heading: number | null;
      reported_at: Date | null; exit_distance_m: number | null;
    }>(
      `WITH latest AS (
         SELECT raw_data FROM bronze.waze_raw_alerts ORDER BY ingested_at DESC LIMIT 1
       ), expanded AS (
         SELECT x,
                (x->'location'->>'x')::float AS lon,
                (x->'location'->>'y')::float AS lat
         FROM latest, LATERAL jsonb_array_elements(raw_data::jsonb) AS x
         WHERE x->'location' IS NOT NULL
       ), a AS (
         /* One row per report.

            A single Waze snapshot repeats the same alert: in a live sample one
            uuid appeared three times and another twice, so fourteen rows were
            eleven reports. That inflated the Active Reports tile and stacked
            duplicate pins on the same spot, which is invisible on the map but
            counted. Keeping the highest-rated copy of each uuid means the row
            that survives is the best-attested one.

            Rows with no uuid cannot be compared, so they are left alone rather
            than being collapsed into a single nameless report. */
         SELECT DISTINCT ON (COALESCE(x->>'uuid', gen_random_uuid()::text))
                x, lon, lat
         FROM expanded
         ORDER BY COALESCE(x->>'uuid', gen_random_uuid()::text),
                  (x->>'reportRating')::int DESC NULLS LAST,
                  (x->>'reliability')::int  DESC NULLS LAST
       )
       SELECT a.lon, a.lat,
              a.x->>'type'               AS type,
              NULLIF(a.x->>'street', '') AS street,
              NULLIF(a.x->>'city', '')   AS city,
              (a.x->>'reliability')::int AS reliability,
              (a.x->>'confidence')::int  AS confidence,
              e.exit_name,
              -- Everything below backs the report detail panel on the live map.
              -- All of it is already in the raw Waze payload; it was simply not
              -- being selected, so a click had nothing beyond street and city to
              -- show. Nothing here is derived or invented.
              a.x->>'uuid'                       AS uuid,
              NULLIF(a.x->>'subtype', '')        AS subtype,
              (a.x->>'reportRating')::int        AS report_rating,
              (a.x->>'roadType')::int            AS road_type,
              a.x->>'reportByMunicipalityUser'   AS by_municipality,
              (a.x->>'magvar')::int              AS heading,
              -- pubDate is Waze's own "Wed Jun 17 15:47:00 +0000 2026" format.
              -- Parsed here rather than in the browser so every consumer gets one
              -- ISO instant, and NULLIF guards the rows where it is absent.
              to_timestamp(NULLIF(a.x->>'pubDate', ''), 'Dy Mon DD HH24:MI:SS +0000 YYYY') AS reported_at,
              ROUND(e.d)::int                    AS exit_distance_m
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

  // The corridor first, so the jam fragments and alert points draw on top of it.
  const carriageways = await getCorridorCarriagewaysGeoJson();

  const features = [
    ...carriageways,
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
        // Null rather than 0 where Waze did not report one, so the card can
        // omit the row instead of showing a zero that reads as a measurement.
        length_m: r.length_m ?? null,
        running_min: r.running_min ?? null,
        starts_at: r.starts_at ?? null,
        starts_m: r.starts_m ?? null,
        nearest_exit: r.exit_name ?? "",
      },
    })),
    // Same two tests as the sidebar: mainline only, reports only. Without them
    // the map emitted jam points (drawn as lines already) and alerts on parallel
    // service roads, which the client then had to filter a second time.
    ...alerts.rows
      .filter((r) => isNlexCorridorStreet(r.street) && isWazeReportType(r.type))
      .map((r) => ({
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
        // Detail-panel fields. Null rather than a filler value where Waze did
        // not report one, so the panel can omit a row instead of showing a zero
        // that reads as a measurement.
        uuid: r.uuid ?? null,
        subtype: r.subtype ?? null,
        report_rating: r.report_rating ?? null,
        road_type: r.road_type ?? null,
        by_municipality: r.by_municipality === "true",
        heading: r.heading ?? null,
        reported_at: r.reported_at ? new Date(r.reported_at).toISOString() : null,
        exit_distance_m: r.exit_distance_m ?? null,
        lon: r.lon,
        lat: r.lat,
      },
    })),
  ];

  return { type: "FeatureCollection" as const, features };
}


/**
 * The corridor drawn as two carriageways, coloured by what is happening on each.
 *
 * Waze only emits a jam where there IS one, so drawing the feed alone leaves the
 * road invisible between them — scattered coloured fragments over blank map. The
 * corridor itself comes from silver.dim_location, which holds the 19 exit-to-exit
 * segments and their geometry, so every segment is drawn whether or not it is
 * congested, and absence of a jam reads as clear rather than as missing road.
 *
 * Both directions are returned on the same centreline. Separating them is the
 * map's job, not the database's: Mapbox offsets each ribbon in screen pixels, so
 * the gap stays readable at every zoom and both sides trace the identical curve.
 * Offsetting here instead produced two subtly different lines and broke wherever
 * a segment doubled back on itself.
 *
 * Segments carry only their endpoints, so what this returns is a chain of
 * straight chords between exits. The client replaces that geometry with the real
 * OSM alignment before drawing — see lib/corridor-shape.ts. The value here is the
 * per-segment STATE; the shape is a placeholder.
 */

export async function getCorridorCarriagewaysGeoJson() {
  if (!db) return [];

  const { rows } = await db.query<{
    geojson: string; segment_name: string; segment_order: number;
    direction: "NB" | "SB"; level: number | null; speed: number | null; jams: number;
  }>(
    `WITH jam AS (
       SELECT ST_LineMerge(geom) AS g, speed_kmh, level
       FROM silver.fact_waze_jams
       WHERE corridor_match IN ('ON_CORRIDOR', 'NEAR_CORRIDOR')
         AND last_seen_at > NOW() - interval '${WINDOW_MINUTES} minutes'
         AND geom IS NOT NULL
     ),
     -- Direction from the jam's own bearing: the feed has no direction field,
     -- but a jam is a LINESTRING and NLEX runs roughly north-south.
     jam_dir AS (
       SELECT g, speed_kmh, level,
              CASE WHEN DEGREES(ST_Azimuth(ST_StartPoint(g), ST_EndPoint(g))) < 90
                     OR DEGREES(ST_Azimuth(ST_StartPoint(g), ST_EndPoint(g))) > 270
                   THEN 'NB' ELSE 'SB' END AS direction
       FROM jam WHERE GeometryType(g) = 'LINESTRING'
     ),
     -- Each jam colours the segment it is closest to.
     matched AS (
       SELECT d.segment_order, j.direction, j.level, j.speed_kmh
       FROM jam_dir j
       JOIN LATERAL (
         SELECT segment_order FROM silver.dim_location
         ORDER BY ST_Distance(geom, j.g) ASC LIMIT 1
       ) d ON TRUE
     ),
     state AS (
       SELECT segment_order, direction,
              MAX(level)::int                            AS level,
              ROUND(MIN(speed_kmh)::numeric, 1)::float   AS speed,
              COUNT(*)::int                              AS jams
       FROM matched GROUP BY 1, 2
     ),
     -- Every segment, both ways, so the whole corridor is drawn.
     grid AS (
       SELECT l.segment_order, l.segment_name, l.geom, d.direction
       FROM silver.dim_location l
       CROSS JOIN (VALUES ('NB'), ('SB')) AS d(direction)
     )
     SELECT ST_AsGeoJSON(g.geom)   AS geojson,
            g.segment_name,
            g.segment_order,
            g.direction,
            s.level,
            s.speed,
            COALESCE(s.jams, 0)     AS jams
     FROM grid g
     LEFT JOIN state s
       ON s.segment_order = g.segment_order AND s.direction = g.direction
     ORDER BY g.segment_order, g.direction`,
  );

  return rows
    .filter((r) => r.geojson)
    .map((r) => ({
      type: "Feature" as const,
      geometry: JSON.parse(r.geojson),
      properties: {
        feature_type: "carriageway",
        direction: r.direction,
        segment_name: r.segment_name,
        segment_order: r.segment_order,
        // No jam on this stretch means it is flowing, not unknown — Waze reports
        // congestion, so silence is the clear signal.
        level: r.level ?? 0,
        speed: r.speed,
        jams: r.jams,
      },
    }));
}
