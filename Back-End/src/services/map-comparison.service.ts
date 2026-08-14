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
