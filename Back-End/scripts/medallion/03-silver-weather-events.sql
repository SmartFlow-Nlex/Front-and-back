-- SILVER: hourly_weather_clean and philippine_arena_events_clean
-- Idempotent: both targets are truncated and reloaded.

BEGIN;

-- ---------------------------------------------------------------------------
-- silver.hourly_weather_clean
--
-- SHAPE MISMATCH, deliberately surfaced rather than hidden. The silver table was
-- designed for the OpenWeather One Call payload (feels_like, uvi, clouds,
-- visibility, wind_deg, pop, weather_main). The landing table actually in use,
-- public.hourly_weather, is a different multi-source feed carrying per-variable
-- provenance and validation columns instead. Seven silver columns therefore have
-- no source and are loaded NULL:
--     feels_like, uvi, clouds, visibility, wind_deg, pop, weather_main
-- Either the silver table should be reshaped to match the feed, or the One Call
-- fields should be ingested. Do not read those seven columns until then.
--
-- Cleaning rules:
--   * require a timestamp and a location
--   * drop physically impossible readings rather than trusting the feed:
--       temperature outside -20..60 C, humidity outside 0..100,
--       negative rainfall or wind speed
--   * exclude imputed rows — silver should hold observations, not fills
--   * de-duplicate on (location, hour), keeping the highest quality score
-- ---------------------------------------------------------------------------
TRUNCATE silver.hourly_weather_clean RESTART IDENTITY;

INSERT INTO silver.hourly_weather_clean
  (cell_name, latitude, longitude, recorded_at,
   temp, pressure, humidity, dew_point, wind_speed, wind_gust, weather_desc, rain_1h)
SELECT cell_name, latitude, longitude, recorded_at,
       temp, pressure, humidity, dew_point, wind_speed, wind_gust, weather_desc, rain_1h
FROM (
  SELECT DISTINCT ON (location_name, timestamp_utc)
         location_name                AS cell_name,
         latitude::double precision   AS latitude,
         longitude::double precision  AS longitude,
         timestamp_utc                AS recorded_at,
         temperature::double precision      AS temp,
         ROUND(surface_pressure)::int       AS pressure,
         ROUND(humidity)::int               AS humidity,
         dew_point::double precision        AS dew_point,
         wind_speed::double precision       AS wind_speed,
         wind_gusts::double precision       AS wind_gust,
         weather_description                AS weather_desc,
         rainfall::double precision         AS rain_1h
  FROM public.hourly_weather
  WHERE timestamp_utc IS NOT NULL
    AND location_name IS NOT NULL
    AND COALESCE(is_imputed, false) = false
    AND (temperature IS NULL OR temperature BETWEEN -20 AND 60)
    AND (humidity    IS NULL OR humidity    BETWEEN 0 AND 100)
    AND (rainfall    IS NULL OR rainfall    >= 0)
    AND (wind_speed  IS NULL OR wind_speed  >= 0)
  ORDER BY location_name, timestamp_utc, quality_score DESC NULLS LAST, ingested_at
) q;

-- ---------------------------------------------------------------------------
-- silver.philippine_arena_events_clean
--
-- Conforms the scraped event list. The source keeps the human string in
-- date_raw and the parsed value in start_date; silver keeps the parsed date and
-- carries date_raw through as notes so the original wording is not lost.
-- Titles are de-duplicated case-insensitively per date — the source holds
-- "SEVENTEEN - BE THE SUN World Tour" and "Seventeen - Be The Sun World Tour"
-- as separate rows on 2022-12-17.
-- ---------------------------------------------------------------------------
TRUNCATE silver.philippine_arena_events_clean RESTART IDENTITY;

INSERT INTO silver.philippine_arena_events_clean
  (event_name, event_date, event_time, venue, category, source, notes)
SELECT event_name, event_date, NULL, venue, category, 'philippine_arena_events', notes
FROM (
  SELECT DISTINCT ON (start_date, lower(btrim(title)))
         btrim(title)                       AS event_name,
         start_date                         AS event_date,
         COALESCE(NULLIF(btrim(venue), ''), 'Philippine Arena') AS venue,
         COALESCE(NULLIF(btrim(event_type), ''), 'Other')       AS category,
         NULLIF(btrim(date_raw), '')        AS notes
  FROM public.philippine_arena_events
  WHERE start_date IS NOT NULL
    AND btrim(COALESCE(title, '')) <> ''
  ORDER BY start_date, lower(btrim(title)), id
) q;

COMMIT;

SELECT 'silver.hourly_weather_clean' AS table_name, COUNT(*) AS rows,
       MIN(recorded_at)::date AS from_date, MAX(recorded_at)::date AS to_date,
       COUNT(DISTINCT cell_name) AS cells
FROM silver.hourly_weather_clean
UNION ALL
SELECT 'silver.philippine_arena_events_clean', COUNT(*),
       MIN(event_date), MAX(event_date), COUNT(DISTINCT venue)
FROM silver.philippine_arena_events_clean;
