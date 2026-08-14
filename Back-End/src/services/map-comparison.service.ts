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

// [DEV-04] Exit search — nlex_exits is the corridor's exit reference table.
export async function searchExitsInDb(query: string) {
  if (!db) return null;
  try {
    const { rows } = await db.query(
      `SELECT exit_id, exit_name, latitude, longitude
       FROM nlex_exits
       WHERE exit_name ILIKE $1
       ORDER BY exit_id`,
      [`%${query}%`]
    );
    return rows;
  } catch (error) {
    console.error("Database query failed for exit search:", error);
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
