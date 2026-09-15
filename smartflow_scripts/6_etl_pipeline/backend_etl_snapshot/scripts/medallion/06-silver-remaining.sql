-- SILVER: the five datasets that had no silver table at all.
--
-- Until now the serving views for traffic volume, incidents, exits, emission
-- factors, theoretical emissions and hourly jams read bronze directly, so the
-- dashboard consumed raw data while silver sat mostly unused. These tables give
-- each of them a cleaned layer to read instead.
--
-- Each table deliberately carries the SAME column names the public view already
-- selects, so 07-repoint-views.sql only has to change the FROM clause.
--
-- Idempotent: every table is dropped and rebuilt.

BEGIN;

-- ---------------------------------------------------------------------------
-- silver.nlex_traffic_volume_clean
--   * de-duplicated on (plaza, day, hour, direction) — bronze was double-loaded
--     for three plazas once already, so silver enforces the grain rather than
--     trusting the loader
--   * negative volumes dropped: a toll count cannot be below zero
--   * class columns coerced to 0 rather than NULL so downstream sums are safe
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS silver.nlex_traffic_volume_clean;
CREATE TABLE silver.nlex_traffic_volume_clean AS
SELECT date_day, hour_of_day, toll_plaza, direction,
       GREATEST(COALESCE(volume_class1, 0), 0) AS volume_class1,
       GREATEST(COALESCE(volume_class2, 0), 0) AS volume_class2,
       GREATEST(COALESCE(volume_class3, 0), 0) AS volume_class3,
       GREATEST(COALESCE(total_volume,   0), 0) AS total_volume,
       day_of_week, is_weekend, month_name, quarter, is_rush_hour,
       is_holiday, is_holiday_window,
       avg_speed_kmh, avg_jam_level, max_delay_seconds,
       temperature, rainfall, wind_speed, humidity
FROM (
  SELECT DISTINCT ON (toll_plaza, date_day, hour_of_day, direction) *
  FROM bronze.nlex_traffic_volume
  WHERE date_day IS NOT NULL
    AND hour_of_day BETWEEN 0 AND 23
    AND direction IN ('NB', 'SB')
    AND COALESCE(total_volume, 0) >= 0
  ORDER BY toll_plaza, date_day, hour_of_day, direction, id
) q;

CREATE INDEX ix_silver_tv_day   ON silver.nlex_traffic_volume_clean (date_day);
CREATE INDEX ix_silver_tv_plaza ON silver.nlex_traffic_volume_clean (toll_plaza, date_day);

-- ---------------------------------------------------------------------------
-- silver.nlex_incidents_clean
--   * requires a date and a location — an incident with neither cannot be placed
--   * clearance capped at 24h: longer values are data-entry noise, not incidents
--   * casualty counts coerced to non-negative
--   * de-duplicated on the natural key (date, hour, location, type)
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS silver.nlex_incidents_clean;
CREATE TABLE silver.nlex_incidents_clean AS
SELECT incident_date, hour_of_day, location, incident_type,
       cause_of_accident, type_of_accident, weather_condition,
       GREATEST(COALESCE(injuries_male,     0), 0) AS injuries_male,
       GREATEST(COALESCE(injuries_female,   0), 0) AS injuries_female,
       GREATEST(COALESCE(fatalities_male,   0), 0) AS fatalities_male,
       GREATEST(COALESCE(fatalities_female, 0), 0) AS fatalities_female,
       km_value, severity, nearest_exit,
       CASE WHEN clearance_minutes BETWEEN 0 AND 1440 THEN clearance_minutes END AS clearance_minutes,
       reported_time, cleared_time
FROM (
  SELECT DISTINCT ON (incident_date, hour_of_day, location, incident_type) *
  FROM bronze.nlex_incidents
  WHERE incident_date IS NOT NULL
    AND btrim(COALESCE(location, '')) <> ''
  ORDER BY incident_date, hour_of_day, location, incident_type, id
) q;

CREATE INDEX ix_silver_inc_date ON silver.nlex_incidents_clean (incident_date);
CREATE INDEX ix_silver_inc_type ON silver.nlex_incidents_clean (incident_type);

-- ---------------------------------------------------------------------------
-- silver.nlex_exits_clean — the corridor reference, one row per exit_id.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS silver.nlex_exits_clean;
CREATE TABLE silver.nlex_exits_clean AS
SELECT DISTINCT ON (exit_id)
       id, exit_id, btrim(exit_name) AS exit_name, latitude, longitude,
       sb_entry, sb_exit, nb_entry, nb_exit, recorded_at
FROM bronze.nlex_exits
WHERE exit_id IS NOT NULL
  AND btrim(COALESCE(exit_name, '')) <> ''
  AND latitude BETWEEN 4 AND 21      -- Philippine bounds; rejects a swapped pair
  AND longitude BETWEEN 116 AND 127
ORDER BY exit_id, id;

-- ---------------------------------------------------------------------------
-- silver.nlex_emission_factors — tiny reference table, kept for completeness so
-- the emissions views can read silver end to end.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS silver.nlex_emission_factors;
CREATE TABLE silver.nlex_emission_factors AS
SELECT DISTINCT ON (vehicle_class)
       id, vehicle_class, class_label,
       co2_g_per_km, co_g_per_km, no2_g_per_km,
       pm25_g_per_km, pm10_g_per_km, so2_g_per_km,
       source, recorded_at, description
FROM bronze.nlex_emission_factors
WHERE vehicle_class BETWEEN 1 AND 3
ORDER BY vehicle_class, id;

-- ---------------------------------------------------------------------------
-- silver.nlex_theoretical_emissions_clean
--   * NaN is scrubbed to NULL. Bronze stores NaN where a pollutant factor was
--     missing, and NaN silently poisons every SUM it touches.
--   * negative gram values dropped as impossible
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS silver.nlex_theoretical_emissions_clean;
CREATE TABLE silver.nlex_theoretical_emissions_clean AS
SELECT id, exit_id, timestamp_utc, direction, vehicle_class,
       GREATEST(COALESCE(volume, 0), 0) AS volume,
       segment_distance_km,
       CASE WHEN co2_grams::text  <> 'NaN' AND co2_grams  >= 0 THEN co2_grams  END AS co2_grams,
       CASE WHEN co_grams::text   <> 'NaN' AND co_grams   >= 0 THEN co_grams   END AS co_grams,
       CASE WHEN no2_grams::text  <> 'NaN' AND no2_grams  >= 0 THEN no2_grams  END AS no2_grams,
       CASE WHEN pm25_grams::text <> 'NaN' AND pm25_grams >= 0 THEN pm25_grams END AS pm25_grams,
       CASE WHEN pm10_grams::text <> 'NaN' AND pm10_grams >= 0 THEN pm10_grams END AS pm10_grams,
       CASE WHEN so2_grams::text  <> 'NaN' AND so2_grams  >= 0 THEN so2_grams  END AS so2_grams
FROM bronze.nlex_theoretical_emissions
WHERE timestamp_utc IS NOT NULL
  AND vehicle_class BETWEEN 1 AND 3;

CREATE INDEX ix_silver_te_ts ON silver.nlex_theoretical_emissions_clean (timestamp_utc);

-- ---------------------------------------------------------------------------
-- silver.waze_hourly_jams_clean — the hourly jam grid behind fact_hourly_jams.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS silver.waze_hourly_jams_clean;
CREATE TABLE silver.waze_hourly_jams_clean AS
SELECT date_day, hour_of_day,
       avg_speed_kmh, avg_jam_level,
       GREATEST(COALESCE(total_jam_reports, 0), 0) AS total_jam_reports
FROM bronze.waze_hourly_jams
WHERE date_day IS NOT NULL
  AND hour_of_day BETWEEN 0 AND 23
  AND (avg_speed_kmh IS NULL OR avg_speed_kmh BETWEEN 0 AND 140)
  AND (avg_jam_level IS NULL OR avg_jam_level BETWEEN 0 AND 5);

CREATE INDEX ix_silver_jams_day ON silver.waze_hourly_jams_clean (date_day, hour_of_day);

COMMIT;

SELECT 'nlex_traffic_volume_clean'        AS table_name, COUNT(*) AS rows FROM silver.nlex_traffic_volume_clean
UNION ALL SELECT 'nlex_incidents_clean',              COUNT(*) FROM silver.nlex_incidents_clean
UNION ALL SELECT 'nlex_exits_clean',                  COUNT(*) FROM silver.nlex_exits_clean
UNION ALL SELECT 'nlex_emission_factors',             COUNT(*) FROM silver.nlex_emission_factors
UNION ALL SELECT 'nlex_theoretical_emissions_clean',  COUNT(*) FROM silver.nlex_theoretical_emissions_clean
UNION ALL SELECT 'waze_hourly_jams_clean',            COUNT(*) FROM silver.waze_hourly_jams_clean
ORDER BY 1;
