import { db } from "../config/db.js";
import { kmPost } from "../lib/km-post.js";
import { forecastTable } from "./forecast-source.js";
import { directionSql, jamProfileAvailable, jamProfileSql, queuePlacementSql, volumeProfileSql } from "./jam-profile.js";

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
// sum along segment_order, plus 12: Balintawak is Km 12 and Sta. Ines measures
// 88.25 (76.25 km of road, the corridor's published length). That `km` is the
// MEASURED position every calculation uses; `km_post` beside it is the official
// km post a person is shown (lib/km-post.ts), e.g. Sta. Ines Km 87.
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
              -- The NLEX km POST, not the distance from the start of the
              -- corridor. Cumulative segment length gives the distance, which
              -- is a true measurement and the wrong label: no sign on this road
              -- says km 0. Balintawak is km 12, and a km post is distance along
              -- the road, so every other exit is that plus how far it is from
              -- Balintawak -- which is exactly what n.m already holds.
              --
              -- gold.exit_km_post was meant to carry these and cannot be used
              -- as it stands: its hand-entered values put Balintawak to Harbor
              -- Link at 4.00 km against 1.63 km measured, and four of them run
              -- BACKWARDS along the corridor, Tabang Guiguinto to Balagtas by
              -- five kilometres. Anchoring the measurement instead lands within
              -- a tenth of that table's own coordinate-calibrated figures at
              -- the far end -- Dau 83.05 against 83.1, SCTEX 85.23 against 85.4
              -- -- which is the part of it that was derived rather than typed.
              --
              -- Only the offset changes, so every distance taken as a
              -- DIFFERENCE of these stays exactly as it was.
              ROUND((n.m / 1000.0 + 12)::numeric, 2)::float AS km,
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
    return rows.map((x) => ({ ...x, km_post: x.km == null ? null : kmPost(Number(x.km)) }));
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
 * The horizon check is the more important one. It once found every row for a
 * segment carrying the same state and probability - the +1h outlook was
 * byte-identical to the +12h one - so the panel said so rather than offering a
 * control that would move nothing. The retrained model does vary, and the
 * panel offers the control again on the strength of this flag.
 *
 * `maxHorizon` is what the table actually reaches, which is not the same as
 * what the model can serve: the pipeline writes as many hours ahead as it was
 * asked for, and the UI must not offer a range the warehouse cannot answer.
 */
export async function getForecastModelInfo(): Promise<{
  name: string | null;
  accuracy: number | null;
  trainedAt: string | null;
  rejectedCount: number;
  horizonVaries: boolean;
  horizons: number;
  minHorizon: number | null;
  maxHorizon: number | null;
  /** When the forecast was made. Hour N is baseTs + N, not now + N: the run can be hours old. */
  baseTs: string | null;
} | null> {
  if (!db) return null;
  try {
    // Prefer the table only this pipeline writes; see forecast-source.
    const src = await forecastTable(db);
    const [{ rows: model }, { rows: variance }, { rows: base }] = await Promise.all([
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
                MAX(horizons)::int                        AS horizons,
                MIN(lo)::int                              AS min_h,
                MAX(hi)::int                              AS max_h
           FROM (
             SELECT segment_name,
                    COUNT(DISTINCT congestion_state || ':' || probability::text) AS variants,
                    COUNT(DISTINCT hours_ahead)                                  AS horizons,
                    MIN(hours_ahead)                                             AS lo,
                    MAX(hours_ahead)                                             AS hi
               FROM ${src}
              GROUP BY segment_name
           ) per_segment`,
      ),
      // base_ts is Manila wall time with no zone; say so, or a server in UTC would read it 8 h off.
      db.query(`SELECT to_char(MAX(base_ts), 'YYYY-MM-DD"T"HH24:MI:SS') || '+08:00' AS base_ts FROM ${src}`),
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
      minHorizon: v?.min_h == null ? null : Number(v.min_h),
      maxHorizon: v?.max_h == null ? null : Number(v.max_h),
      baseTs: base[0]?.base_ts ?? null,
    };
  } catch (error) {
    console.error("Database query failed for forecast model info:", error);
    return null;
  }
}

/**
 * [DEV-02] Predicted congestion for the forecast map panel.
 *
 * Reads the congestion forecast (see forecast-source for which table) and
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
    // Prefer the table only this pipeline writes; see forecast-source.
    const src = await forecastTable(db);
    /* The typical queue for each predicted jam -- length, distance from the
       plaza, delay, speed -- so the map can draw the stretch a jam would
       actually occupy, the way the live map draws a real one, instead of
       painting the whole exit-to-exit segment. See jam-profile.ts. */
    const withProfile = await jamProfileAvailable(db);
    const jp = jamProfileSql();
    const qp = await queuePlacementSql(db);
    const vp = withProfile ? await volumeProfileSql(db) : { cols: "", join: "" };
    const dp = withProfile ? await directionSql(db) : { cols: "", join: "" };
    const { rows } = await db.query(
      `SELECT c.segment_name,
              c.hours_ahead,
              c.congestion_state,
              c.probability::float AS probability,
              (COALESCE(c.p_med, 0) + COALESCE(c.p_high, 0))::float AS p_congested,
              c.p_med::float AS p_med, c.p_high::float AS p_high,
              d.segment_name AS corridor_segment,
              d.location_id,
              ST_AsGeoJSON(d.geom::geometry) AS geojson
              ${withProfile ? jp.cols : ""}
              ${qp.cols}
              ${vp.cols}
              ${dp.cols}
       FROM ${src} c
       JOIN LATERAL (
         SELECT dl.location_id, dl.segment_name, dl.geom
         FROM dim_location dl
         WHERE dl.geom IS NOT NULL
           AND (dl.start_node ILIKE c.segment_name || '%'
                OR dl.start_node ILIKE '%' || c.segment_name || '%')
         ORDER BY (dl.start_node ILIKE c.segment_name || '%') DESC, dl.location_id
         LIMIT 1
       ) d ON TRUE
       ${withProfile ? jp.join : ""}
       ${vp.join}
       ${dp.join}
       ${qp.join}
       WHERE c.hours_ahead = $1
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
        /* The state the dashboard SHOWS: a jam when the chance of one (heavy +
           severe) is 50% or more, severity by the likelier of the two. The
           model's own label is the likeliest of three, which called 244 cells
           of one run "Low" at a 50-60% chance of a jam; above 50% the chance is
           calibrated (said 55% -> 51% happened). Same rule as the congestion
           card, so the map, its list and the card agree. */
        congestion_state:
          r.p_med != null && r.p_high != null
            ? (r.p_med + r.p_high >= 0.5 ? (r.p_high >= r.p_med ? "High" : "Med") : "Low")
            : r.congestion_state,
        model_state: r.congestion_state,
        probability: r.probability,
        p_congested: r.p_congested,
        p_med: r.p_med,
        p_high: r.p_high,
        // Kept for backward compatibility with the existing map styling, which
        // reads a 0-1 score rather than the Low/Med/High label.
        congestion_score: r.probability,
        jam_queue_m: r.jamQueueM ?? null,
        jam_queue_p75_m: r.jamQueueP75M ?? null,
        jam_delay_s: r.jamDelayS ?? null,
        jam_dist_m: r.jamDistM ?? null,
        jam_speed_kmh: r.jamSpeedKmh ?? null,
        jam_basis: r.jamBasis ?? null,
        jam_basis_hours: r.jamBasisHours ?? null,
        // Signed metres from the plaza to the queue's front, per carriageway.
        front_nb_m: r.front_nb_m ?? null,
        front_sb_m: r.front_sb_m ?? null,
        front_nb_own: r.front_nb_own ?? null,
        front_sb_own: r.front_sb_own ?? null,
        // Typical vehicles per hour at this exit for the forecast hour.
        vol_median: r.volMedian ?? null,
        vol_rel: r.volRel ?? null,
        // Share of this exit's jam-hours (at this time of day) on each side.
        nb_share: r.nb_share ?? null,
        sb_share: r.sb_share ?? null,
        dir_jam_hours: r.dir_jam_hours ?? null,
      },
      geometry: JSON.parse(r.geojson),
    }));
  } catch (error) {
    console.error("Database query failed for forecast congestion:", error);
    return null;
  }
}

/**
 * The hour each day is most likely to be congested, for the next seven days.
 *
 * A week of hourly options is twenty-nine rows that mostly say the same thing:
 * nobody scrolls a dropdown looking for 11 PM on Tuesday. What a reader wants
 * from a seven-day view is which day is bad and when, so this answers that
 * directly — one row per day, already pointing at that day's worst hour.
 *
 * "Worst" is the hour with the most segments forecast congested, and where two
 * hours tie, the one whose congestion the model is most confident about. Both
 * come from the same rows the map draws, so selecting a peak lands on exactly
 * the picture that made it the peak.
 */
export async function getForecastDailyPeaksFromDb(): Promise<
  { day: string; hoursAhead: number; at: string; congested: number; slow: number; confidence: number }[] | null
> {
  if (!db) return null;
  try {
    // Prefer the table only this pipeline writes; see forecast-source.
    const src = await forecastTable(db);
    const { rows } = await db.query(
      /* "Congested" is the rule the map draws by: a jam when the chance of one
         (heavy + severe) is 50% or more. This counted only exits the model
         LABELLED severe, so the week list said "1 congested" for days the map
         drew with a dozen predicted queues. Confidence is the average chance
         of a jam across the corridor at that hour.
         Split by the colour the map draws (2 Nov 2026): "congested" is a jam the map paints red (Severe more likely
         than Heavy), "slow" one it paints amber. They were one count called "congested", which the live map uses
         for red alone, so "12 congested" ahead could not be compared with "3 congested" now. */
      `WITH per_hour AS (
         SELECT hours_ahead,
                MAX(base_ts) AS base_ts,
                COUNT(*) FILTER (WHERE COALESCE(p_med, 0) + COALESCE(p_high, 0) >= 0.5
                                   AND COALESCE(p_high, 0) >= COALESCE(p_med, 0))::int AS congested,
                COUNT(*) FILTER (WHERE COALESCE(p_med, 0) + COALESCE(p_high, 0) >= 0.5
                                   AND COALESCE(p_high, 0) < COALESCE(p_med, 0))::int AS slow,
                AVG(COALESCE(p_med, 0) + COALESCE(p_high, 0))::float                      AS confidence
           FROM ${src}
          GROUP BY hours_ahead
       ), stamped AS (
         SELECT hours_ahead,
                congested,
                slow,
                confidence,
                base_ts + make_interval(hours => hours_ahead) AS at
           FROM per_hour
          WHERE base_ts IS NOT NULL
       )
       -- to_char, not at::date. The driver parses a DATE into a JS Date at
       -- LOCAL midnight, and toISOString then walks it back across UTC, so
       -- every day came out one behind: the peak at 2026-09-19 13:00 was
       -- labelled 2026-09-18. Formatting it in Postgres keeps the calendar
       -- day the grouping actually used.
       SELECT DISTINCT ON (at::date)
              to_char(at, 'YYYY-MM-DD') AS day, hours_ahead,
              to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS') || '+08:00' AS at, congested, slow, confidence
         FROM stamped
        ORDER BY at::date, congested DESC, slow DESC, confidence DESC, hours_ahead
      `,
    );

    return rows.map((r) => ({
      day: String(r.day),
      hoursAhead: Number(r.hours_ahead),
      at: new Date(r.at).toISOString(),
      congested: Number(r.congested),
      slow: Number(r.slow),
      confidence: Number(r.confidence),
    }));
  } catch (error) {
    console.error("Database query failed for forecast daily peaks:", error);
    return null;
  }
}
