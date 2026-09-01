import { db } from "../config/db.js";

// [DEV-01 & DEV-03] Fetch merged real-time data (volumes + active incidents).
//
// Reads the warehouse tables that actually carry data: nlex_traffic_volume for
// plaza volume and fact_incident_log for incidents. The flat traffic_volumes /
// incidents_table from the original schema are present but unpopulated.
export async function getRealtimeMapDataFromDb() {
  if (!db) return null;
  try {
    const hourCols = Array.from({ length: 24 }, (_, i) => `h${String(i).padStart(2, "0")}`).join(" + ");

    const [{ rows: volumes }, { rows: incidents }] = await Promise.all([
      db.query(
        `WITH span AS (SELECT MAX(date) AS hi, (MAX(date) - 29) AS lo FROM nlex_traffic_volume)
         SELECT t.toll_plaza AS segment_id,
                t.direction,
                ROUND(AVG(${hourCols}))::int AS volume_count,
                span.hi::text AS as_of
         FROM nlex_traffic_volume t, span
         WHERE t.type = 'Entries' AND t.vehicle_class = 'Total'
           AND t.date BETWEEN span.lo AND span.hi
         GROUP BY 1, 2, 4 ORDER BY 1, 2`
      ),
      db.query(
        `SELECT incident_log_id, alert_type, subtype, street, city,
                report_description, reliability, confidence, is_active,
                first_seen_at, last_seen_at, mttc_minutes,
                ST_X(geom::geometry) AS longitude,
                ST_Y(geom::geometry) AS latitude
         FROM fact_incident_log
         WHERE geom IS NOT NULL
         ORDER BY first_seen_at DESC NULLS LAST
         LIMIT 500`
      ),
    ]);

    return { volumes, incidents };
  } catch (error) {
    console.error("Database query failed for map real-time:", error);
    return null;
  }
}

// [DEV-04] Exit reference for the whole corridor — the single list every tab
// should use. nlex_exits gives identity and position; the km-post is derived
// from dim_location, whose segments carry length_meters, by running a cumulative
// sum along segment_order. Balintawak is km 0 and Sta. Ines is km 76.25, which
// matches the corridor's published length.
//
// Deriving km rather than hardcoding it is the point: the dashboard previously
// carried three different hand-written exit lists (9 exits in the AI sandbox,
// 26 in maintenance, 20 on the map) that disagreed with each other and with the
// database.
export async function searchExitsInDb(query: string) {
  if (!db) return null;
  try {
    const { rows } = await db.query(
      `WITH seg AS (
         SELECT segment_order, start_node, end_node, length_meters,
                COALESCE(SUM(length_meters) OVER (
                  ORDER BY segment_order
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS m_before
         FROM dim_location
         WHERE segment_order IS NOT NULL
       ), nodes AS (
         SELECT start_node AS node, m_before AS m FROM seg
         UNION ALL
         -- the corridor's final node is an end_node, never a start_node
         SELECT end_node, m_before + length_meters
         FROM seg WHERE segment_order = (SELECT MAX(segment_order) FROM seg)
       )
       SELECT x.exit_id,
              x.exit_name,
              x.latitude,
              x.longitude,
              ROUND((n.m / 1000.0)::numeric, 2)::float AS km,
              -- Per-direction access from silver.nlex_exit_reference. A node
              -- with no entry or exit either way is a mainline toll barrier,
              -- not an interchange.
              COALESCE(r.nb_entry, true) AS nb_entry,
              COALESCE(r.nb_exit,  true) AS nb_exit,
              COALESCE(r.sb_entry, true) AS sb_entry,
              COALESCE(r.sb_exit,  true) AS sb_exit,
              -- A mainline barrier is named as one. Inferring it from the access
              -- flags does not work: Bocaue Barrier still carries sb_exit, so a
              -- "no access at all" rule misses it.
              CASE WHEN x.exit_name ILIKE '%barrier%'
                   THEN 'toll-barrier' ELSE 'interchange' END AS node_type
       FROM nlex_exits x
       LEFT JOIN nodes n ON n.node = x.exit_name
       LEFT JOIN silver.nlex_exit_reference r ON r.exit_name = x.exit_name
       WHERE x.exit_name ILIKE $1
       ORDER BY x.exit_id`,
      [`%${query}%`]
    );
    return rows;
  } catch (error) {
    console.error("Database query failed for exit search:", error);
    return null;
  }
}


/**
 * Which model produced the forecast, and whether it varies with the horizon.
 *
 * The panel draws real model output, but a reader cannot tell that from a
 * coloured line — and two things about this particular model need saying.
 *
 * It is the accepted classifier for target 'Congestion' in gold.ml_model_metrics,
 * which the training pipeline writes along with the competitors it rejected and
 * why. Naming it, and its score, is the difference between "the map says" and
 * "a model with this accuracy, trained on this date, says".
 *
 * The horizon check is the more important one. gold.ml_predictive_congestion
 * holds twelve rows per segment, one per hour ahead, but every row for a given
 * segment currently carries the same state and the same probability: the +1h
 * outlook is byte-identical to the +12h one. So the table has a horizon column
 * that the model does not actually use, and any control offering to change the
 * horizon would move nothing on screen. The flag lets the panel say so instead
 * of implying a forecast that varies over time.
 */
export async function getForecastModelInfo(): Promise<{
  name: string | null;
  accuracy: number | null;
  trainedAt: string | null;
  rejectedCount: number;
  horizonVaries: boolean;
  horizons: number;
} | null> {
  if (!db) return null;
  try {
    const [{ rows: model }, { rows: variance }] = await Promise.all([
      db.query(
        `SELECT model_name, r2, updated_at,
                (SELECT COUNT(*) FROM gold.ml_model_metrics
                  WHERE target = 'Congestion' AND NOT accepted)::int AS rejected
           FROM gold.ml_model_metrics
          WHERE target = 'Congestion' AND accepted
          ORDER BY rank NULLS LAST
          LIMIT 1`,
      ),
      db.query(
        `SELECT COUNT(*) FILTER (WHERE variants > 1)::int AS varying,
                MAX(horizons)::int                        AS horizons
           FROM (
             SELECT segment_name,
                    COUNT(DISTINCT congestion_state || ':' || probability::text) AS variants,
                    COUNT(DISTINCT hours_ahead)                                  AS horizons
               FROM gold.ml_predictive_congestion
              GROUP BY segment_name
           ) per_segment`,
      ),
    ]);

    const m = model[0];
    const v = variance[0];
    return {
      name: m?.model_name ?? null,
      accuracy: m?.r2 === null || m?.r2 === undefined ? null : Number(m.r2),
      trainedAt: m?.updated_at ? new Date(m.updated_at).toISOString() : null,
      rejectedCount: Number(m?.rejected ?? 0),
      horizonVaries: Number(v?.varying ?? 0) > 0,
      horizons: Number(v?.horizons ?? 0),
    };
  } catch (error) {
    console.error("Database query failed for forecast model info:", error);
    return null;
  }
}

/**
 * [DEV-02] Predicted congestion for the forecast map panel.
 *
 * Reads gold.ml_predictive_congestion (written by the traffic ML pipeline) and
 * attaches the real corridor geometry from dim_location, so the panel draws
 * actual model output. It previously returned a single hardcoded LineString
 * with a fixed congestion_score of 0.78 and never touched the database.
 *
 * Segment naming differs between the two tables — the ML pipeline names a
 * segment after its starting plaza ("Bocaue", "Valenzuela") while dim_location
 * uses the full node name ("Bocaue Barrier", "Paso De Blas Valenzuela"). So the
 * join tries a prefix match first and falls back to a contains match, taking
 * the lowest location_id when several fit. Segments with no geometry match
 * (currently Karuhatan and Mindanao Ave, which are absent from the rebuilt exit
 * list) are simply omitted rather than drawn in the wrong place.
 */
export async function getForecastCongestionFromDb(hoursAhead: number) {
  if (!db) return null;
  try {
    const { rows } = await db.query(
      `SELECT g.segment_name,
              g.hours_ahead,
              g.congestion_state,
              g.probability::float AS probability,
              d.segment_name AS corridor_segment,
              d.location_id,
              ST_AsGeoJSON(d.geom::geometry) AS geojson
       FROM gold.ml_predictive_congestion g
       JOIN LATERAL (
         SELECT dl.location_id, dl.segment_name, dl.geom
         FROM dim_location dl
         WHERE dl.geom IS NOT NULL
           AND (dl.start_node ILIKE g.segment_name || '%'
                OR dl.start_node ILIKE '%' || g.segment_name || '%')
         ORDER BY (dl.start_node ILIKE g.segment_name || '%') DESC, dl.location_id
         LIMIT 1
       ) d ON TRUE
       WHERE g.hours_ahead = $1
       ORDER BY d.location_id`,
      [hoursAhead]
    );

    return rows.map((r) => ({
      type: "Feature" as const,
      properties: {
        feature_type: "forecast",
        segment_id: r.segment_name,
        corridor_segment: r.corridor_segment,
        horizon: `${r.hours_ahead}h`,
        hours_ahead: r.hours_ahead,
        congestion_state: r.congestion_state,
        probability: r.probability,
        // Kept for backward compatibility with the existing map styling, which
        // reads a 0-1 score rather than the Low/Med/High label.
        congestion_score: r.probability,
      },
      geometry: JSON.parse(r.geojson),
    }));
  } catch (error) {
    console.error("Database query failed for forecast congestion:", error);
    return null;
  }
}
