-- GOLD: what a jam typically looks like at each exit, hour and day type.
--
-- The congestion forecast says WHETHER an exit is expected to jam in a given
-- hour. The live map says much more about a jam that exists: how long the
-- queue is, how far from the plaza it starts, and how many minutes it costs.
-- This table lets the forecast say the same things, from four years of Waze
-- history: for every exit x weekday/weekend x hour x severity, the median
-- queue length, distance from the plaza, delay and speed of the jams that
-- actually formed there.
--
-- SOURCE. silver.waze_jam_hourly_exit, the Jan 2022 - Apr 2026 Partner Hub
-- export rolled up to exit-hours (see the 29 Sep 2026 load). Only
-- on_corridor rows are used: that flag is the live map's own "this street is
-- the NLEX mainline" test, so a profile never describes a queue on a service
-- road the map would not draw. Each exit-hour can arrive as two rows (at the
-- exit, and further out); they are combined weighted by jam_snapshots, which
-- is exposure time.
--
-- NEAR THE EXIT ONLY (distance_m_avg <= 600). The export assigns every jam to
-- its nearest exit however far away it is, so Mexico's "typical queue" came
-- out at 2.9 km from jams three kilometres up the road, against 381 m in the
-- live feed. The live feed only attaches jams that touch the exit's stretch
-- (ON_CORRIDOR: median 107 m, 90th percentile 580 m from the plaza). Scored on
-- the live weeks, the typical queue error was:
--     every on-corridor jam      34 m   (and a 452 m mean, from those exits)
--     within 250 m (at_exit)     28 m
--     within 600 m               21 m   <- used
--     within 1000 m              22 m
-- An exit with too few near-plaza jams in history gets no profile rather than
-- one built from somewhere else.
--
-- SEVERITY uses the forecast's own cuts (train_congestion_horizon.py,
-- SEVERE_KMH = 10, HEAVY_KMH = 20) on the length-weighted speed, so a cell the
-- forecast paints red is matched with the jams that were red.
--
-- distance_m is from the jam's matched point to the nearest exit and has no
-- sign: history carries no carriageway, so it cannot say "before" or "past"
-- the plaza the way the live map does from a jam's geometry. The card words it
-- as "from" the plaza for that reason.
--
-- ROWS. Four levels, so the API can fall back when an hour is thin:
--   (exit, day_type, hour, state)   the specific case
--   (exit, day_type, hour, 'Any')   that hour, any severity
--   (exit, 'all',   NULL, state)    the exit, that severity, any hour
--   (exit, 'all',   NULL, 'Any')    the exit overall
-- plus exit_name = 'ALL' rows (corridor-wide, by severity), used only as the
-- baseline the evaluation below has to beat.
--
-- EVALUATION. gold.congestion_jam_profile_eval scores the profile against the
-- live feed (silver.fact_waze_jams, from 4 Aug 2026), which the history never
-- saw: for every live exit-hour with an NLEX jam, the profile's queue and
-- delay for that exit, hour, day type and observed severity, against what
-- Waze reported. It is compared with two simpler guesses: the corridor-wide
-- median for that severity, and the exit's median regardless of hour.
--
-- Idempotent: both tables are dropped and rebuilt. Re-run after any reload of
-- silver.waze_jam_hourly_exit:
--   npx tsx scripts/run-sql.ts scripts/medallion/11-gold-congestion-jam-profile.sql

DROP TABLE IF EXISTS gold.congestion_jam_profile;

CREATE TABLE gold.congestion_jam_profile AS
WITH h AS (
  SELECT w.date_day,
         w.hour_of_day::int AS hour_of_day,
         e.exit_name,
         CASE WHEN EXTRACT(ISODOW FROM w.date_day) IN (6, 7) THEN 'weekend' ELSE 'weekday' END AS day_type,
         SUM(w.speed_kmh_wavg * w.jam_snapshots) / NULLIF(SUM(w.jam_snapshots), 0) AS spd,
         SUM(w.length_m_avg   * w.jam_snapshots) / NULLIF(SUM(w.jam_snapshots), 0) AS len,
         SUM(w.delay_s_avg    * w.jam_snapshots) / NULLIF(SUM(w.jam_snapshots), 0) AS dly,
         SUM(w.distance_m_avg * w.jam_snapshots) / NULLIF(SUM(w.jam_snapshots), 0) AS dist
  FROM silver.waze_jam_hourly_exit w
  JOIN bronze.nlex_exits e ON e.id = w.nlex_exit_id
  WHERE w.on_corridor
    AND w.distance_m_avg <= 600
  GROUP BY 1, 2, 3, 4
), s AS (
  SELECT h.*,
         CASE WHEN spd < 10 THEN 'High' WHEN spd < 20 THEN 'Med' ELSE 'Low' END AS state
  FROM h
  WHERE spd IS NOT NULL AND len IS NOT NULL AND dly IS NOT NULL
)
SELECT COALESCE(exit_name, 'ALL')  AS exit_name,
       COALESCE(day_type, 'all')   AS day_type,
       hour_of_day,                                   -- NULL = every hour
       COALESCE(state, 'Any')      AS state,
       COUNT(*)::int               AS n_hours,
       ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY len))::int  AS queue_m,
       ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY len))::int  AS queue_p75_m,
       ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY dly))::int  AS delay_s,
       ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY dly))::int  AS delay_p75_s,
       ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY dist))::int AS dist_m,
       ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY spd)::numeric, 1) AS speed_kmh,
       MIN(date_day)               AS first_day,
       MAX(date_day)               AS last_day
FROM s
GROUP BY GROUPING SETS (
  (exit_name, day_type, hour_of_day, state),
  (exit_name, day_type, hour_of_day),
  (exit_name, state),
  (exit_name),
  (state),
  ()
);

CREATE INDEX congestion_jam_profile_key
  ON gold.congestion_jam_profile (exit_name, day_type, hour_of_day, state);

COMMENT ON TABLE gold.congestion_jam_profile IS
  'Median queue length, distance from plaza, delay and speed of on-corridor Waze jams per exit x day_type x hour x severity, Jan 2022 - Apr 2026. Built by Back-End/scripts/medallion/11-gold-congestion-jam-profile.sql. hour_of_day NULL / day_type all / state Any are roll-up rows; exit_name ALL is corridor-wide.';


-- How well the profile describes jams it never saw.
DROP TABLE IF EXISTS gold.congestion_jam_profile_eval;

CREATE TABLE gold.congestion_jam_profile_eval AS
WITH live AS (
  SELECT j.date_day,
         j.hour_of_day::int AS hour_of_day,
         e.exit_name,
         CASE WHEN EXTRACT(ISODOW FROM j.date_day) IN (6, 7) THEN 'weekend' ELSE 'weekday' END AS day_type,
         SUM(j.speed_kmh * GREATEST(j.length_meters, 1)) / SUM(GREATEST(j.length_meters, 1)) AS spd,
         AVG(j.length_meters) AS len,
         AVG(j.delay_seconds) AS dly
  FROM silver.fact_waze_jams j
  JOIN bronze.nlex_exits e ON e.id = j.nlex_exit_id
  WHERE j.corridor_match IN ('ON_CORRIDOR', 'NEAR_CORRIDOR')
    AND (LOWER(j.street) LIKE '%nlex%' OR LOWER(j.street) LIKE '%north luzon%')
    AND LOWER(j.street) !~ '(service|crossing|exit rd|halili|dulalia|tullahan|libtong|slex|skyway|sctex|tplex|cavitex)'
    AND j.speed_kmh IS NOT NULL AND j.length_meters IS NOT NULL AND j.delay_seconds IS NOT NULL
  GROUP BY 1, 2, 3, 4
), ls AS (
  SELECT live.*,
         CASE WHEN spd < 10 THEN 'High' WHEN spd < 20 THEN 'Med' ELSE 'Low' END AS state
  FROM live
), scored AS (
  SELECT ls.*,
         -- Same fallback order the API uses (traffic.service.ts).
         COALESCE(p1.queue_m, p2.queue_m, p3.queue_m) AS full_len,
         COALESCE(p1.delay_s, p2.delay_s, p3.delay_s) AS full_dly,
         COALESCE(p2.queue_m, p3.queue_m)             AS exit_len,
         COALESCE(p2.delay_s, p3.delay_s)             AS exit_dly,
         b.queue_m                                    AS base_len,
         b.delay_s                                    AS base_dly
  FROM ls
  LEFT JOIN gold.congestion_jam_profile p1
         ON p1.exit_name = ls.exit_name AND p1.day_type = ls.day_type
        AND p1.hour_of_day = ls.hour_of_day AND p1.state = ls.state AND p1.n_hours >= 12
  LEFT JOIN gold.congestion_jam_profile p2
         ON p2.exit_name = ls.exit_name AND p2.day_type = 'all'
        AND p2.hour_of_day IS NULL AND p2.state = ls.state AND p2.n_hours >= 12
  LEFT JOIN gold.congestion_jam_profile p3
         ON p3.exit_name = ls.exit_name AND p3.day_type = 'all'
        AND p3.hour_of_day IS NULL AND p3.state = 'Any'
  LEFT JOIN gold.congestion_jam_profile b
         ON b.exit_name = 'ALL' AND b.day_type = 'all'
        AND b.hour_of_day IS NULL AND b.state = ls.state
  WHERE ls.state IN ('High', 'Med')
)
SELECT 1 AS id,
       jsonb_build_object(
         'history_from', (SELECT MIN(first_day) FROM gold.congestion_jam_profile),
         'history_to',   (SELECT MAX(last_day)  FROM gold.congestion_jam_profile),
         'history_exit_hours', (SELECT n_hours FROM gold.congestion_jam_profile
                                 WHERE exit_name = 'ALL' AND state = 'Any' AND hour_of_day IS NULL
                                   AND day_type = 'all'),
         'test_from', MIN(date_day),
         'test_to',   MAX(date_day),
         'test_exit_hours', COUNT(*),
         -- Live hours at an exit with no near-plaza history are left out of
         -- the score, as they are left without detail on the card.
         'test_exit_hours_total', (SELECT COUNT(*) FROM scored),
         'actual_queue_median_m', ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY len)),
         'actual_delay_median_s', ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY dly)),
         'queue', jsonb_build_object(
           'profile_mae_m',  ROUND(AVG(ABS(len - full_len))),
           'exit_mae_m',     ROUND(AVG(ABS(len - exit_len))),
           'corridor_mae_m', ROUND(AVG(ABS(len - base_len))),
           'profile_median_err_m',  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(len - full_len))),
           'corridor_median_err_m', ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(len - base_len)))
         ),
         'delay', jsonb_build_object(
           'profile_mae_s',  ROUND(AVG(ABS(dly - full_dly))),
           'exit_mae_s',     ROUND(AVG(ABS(dly - exit_dly))),
           'corridor_mae_s', ROUND(AVG(ABS(dly - base_dly))),
           'profile_median_err_s',  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(dly - full_dly))),
           'corridor_median_err_s', ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(dly - base_dly)))
         )
       ) AS payload,
       NOW() AS updated_at
FROM scored
WHERE full_len IS NOT NULL AND base_len IS NOT NULL;

COMMENT ON TABLE gold.congestion_jam_profile_eval IS
  'Out-of-time check of gold.congestion_jam_profile against live NLEX jams from silver.fact_waze_jams. One row. Built by 11-gold-congestion-jam-profile.sql.';

SELECT payload FROM gold.congestion_jam_profile_eval;
