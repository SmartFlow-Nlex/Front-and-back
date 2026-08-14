-- Repoint the serving views from BRONZE to SILVER.
--
-- The dashboard reads public views. Those views were selecting straight from
-- bronze, so every descriptive query consumed raw data and the silver layer,
-- though populated, was bypassed. Each view below now reads its silver table.
--
-- Column lists are unchanged, so nothing downstream has to change: the services
-- see exactly the same shape, just cleaned.
--
-- The matview is rebuilt rather than replaced because REFRESH cannot change a
-- definition. It is dropped and recreated with the identical column list.
--
-- Run AFTER 06-silver-remaining.sql.

BEGIN;

-- ── Exits ──────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.nlex_exits AS
SELECT id, exit_id, exit_name, latitude, longitude,
       sb_entry, sb_exit, nb_entry, nb_exit, recorded_at
FROM silver.nlex_exits_clean
ORDER BY exit_id;

-- ── Emission factors ───────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.nlex_emission_factors AS
SELECT id, vehicle_class, class_label,
       co2_g_per_km, co_g_per_km, no2_g_per_km,
       pm25_g_per_km, pm10_g_per_km, so2_g_per_km,
       source, recorded_at, description
FROM silver.nlex_emission_factors;

-- ── Theoretical emissions ──────────────────────────────────────────────
CREATE OR REPLACE VIEW public.nlex_theoretical_emissions AS
SELECT id, exit_id, timestamp_utc, direction, vehicle_class, volume,
       segment_distance_km, co2_grams, co_grams, no2_grams,
       pm25_grams, pm10_grams, so2_grams
FROM silver.nlex_theoretical_emissions_clean;

-- ── Crash views ────────────────────────────────────────────────────────
-- Same derivations as before (reported/response time built from hour_of_day and
-- clearance_minutes), now over the cleaned incident table.
CREATE OR REPLACE VIEW public.nlex_road_crashes AS
SELECT incident_date::text AS date,
       incident_date + make_interval(hours => COALESCE(hour_of_day, 0)) AS reported_time,
       incident_date + make_interval(hours => COALESCE(hour_of_day, 0))
         + make_interval(mins => COALESCE(clearance_minutes, 0::double precision)::integer) AS response_time,
       location, cause_of_accident, type_of_accident, weather_condition,
       injuries_male, injuries_female, fatalities_male, fatalities_female,
       km_value, severity
FROM silver.nlex_incidents_clean
WHERE incident_type = 'road_crash';

CREATE OR REPLACE VIEW public.nlex_motorcycle_crashes AS
SELECT incident_date::text AS date,
       incident_date + make_interval(hours => COALESCE(hour_of_day, 0)) AS reported_time,
       incident_date + make_interval(hours => COALESCE(hour_of_day, 0))
         + make_interval(mins => COALESCE(clearance_minutes, 0::double precision)::integer) AS response_time,
       location, cause_of_accident, type_of_accident, weather_condition,
       injuries_male, injuries_female, fatalities_male, fatalities_female,
       km_value, severity
FROM silver.nlex_incidents_clean
WHERE incident_type = 'motorcycle_crash';

-- ── Hourly jams ────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.fact_hourly_jams AS
SELECT date_day, hour_of_day,
       avg(avg_speed_kmh)::double precision AS avg_speed_kmh,
       avg(avg_jam_level)::double precision AS avg_jam_level,
       sum(total_jam_reports)::integer      AS total_jam_reports
FROM silver.waze_hourly_jams_clean
GROUP BY date_day, hour_of_day;

COMMIT;

-- ── Traffic volume matview ─────────────────────────────────────────────
-- Rebuilt on silver. Identical output shape: one row per date/plaza/direction/
-- vehicle_class with the 24 hourly columns.
DROP MATERIALIZED VIEW IF EXISTS public.nlex_traffic_volume;

CREATE MATERIALIZED VIEW public.nlex_traffic_volume AS
WITH real_days AS (
  SELECT date_day FROM silver.nlex_traffic_volume_clean
  GROUP BY date_day HAVING SUM(total_volume) > 0
), src AS (
  SELECT s.date_day, s.toll_plaza, s.direction, s.hour_of_day,
         s.total_volume, s.volume_class1, s.volume_class2, s.volume_class3
  FROM silver.nlex_traffic_volume_clean s
  JOIN real_days r ON r.date_day = s.date_day
), cls AS (
  SELECT date_day, toll_plaza, direction, hour_of_day, 'Total'::text   AS vehicle_class, total_volume   AS v FROM src
  UNION ALL
  SELECT date_day, toll_plaza, direction, hour_of_day, 'Class 1'::text, volume_class1 FROM src
  UNION ALL
  SELECT date_day, toll_plaza, direction, hour_of_day, 'Class 2'::text, volume_class2 FROM src
  UNION ALL
  SELECT date_day, toll_plaza, direction, hour_of_day, 'Class 3'::text, volume_class3 FROM src
)
SELECT date_day AS date, toll_plaza, direction,
       'Entries'::text AS type, vehicle_class,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day =  0), 0)::int AS h00,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day =  1), 0)::int AS h01,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day =  2), 0)::int AS h02,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day =  3), 0)::int AS h03,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day =  4), 0)::int AS h04,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day =  5), 0)::int AS h05,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day =  6), 0)::int AS h06,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day =  7), 0)::int AS h07,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day =  8), 0)::int AS h08,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day =  9), 0)::int AS h09,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day = 10), 0)::int AS h10,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day = 11), 0)::int AS h11,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day = 12), 0)::int AS h12,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day = 13), 0)::int AS h13,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day = 14), 0)::int AS h14,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day = 15), 0)::int AS h15,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day = 16), 0)::int AS h16,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day = 17), 0)::int AS h17,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day = 18), 0)::int AS h18,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day = 19), 0)::int AS h19,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day = 20), 0)::int AS h20,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day = 21), 0)::int AS h21,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day = 22), 0)::int AS h22,
       COALESCE(SUM(v) FILTER (WHERE hour_of_day = 23), 0)::int AS h23
FROM cls
GROUP BY date_day, toll_plaza, direction, vehicle_class;

CREATE INDEX ix_ntv_date  ON public.nlex_traffic_volume (date);
CREATE INDEX ix_ntv_plaza ON public.nlex_traffic_volume (toll_plaza, date);

SELECT 'nlex_traffic_volume' AS relation, COUNT(*) AS rows,
       COUNT(DISTINCT toll_plaza) AS plazas
FROM public.nlex_traffic_volume;
