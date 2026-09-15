-- GOLD: daily_emissions_summary and daily_weather_summary
--
-- Both aggregate SILVER, never bronze — that is the point of the layer.
-- Idempotent: truncate and reload.
--
-- Dates are Philippine local days. The silver timestamps are timestamptz, so
-- they are converted with AT TIME ZONE 'Asia/Manila' before truncating to a
-- date; grouping on the raw UTC value would split every local day at 08:00 and
-- silently misattribute the evening peak to the following day.

BEGIN;

-- ---------------------------------------------------------------------------
-- gold.daily_emissions_summary — one row per local day / exit / direction
-- ---------------------------------------------------------------------------
TRUNCATE gold.daily_emissions_summary RESTART IDENTITY;

INSERT INTO gold.daily_emissions_summary
  (date, exit_name, direction, avg_aqi, avg_co, avg_no2, avg_o3, avg_so2,
   avg_pm2_5, avg_pm10, reading_count)
SELECT (recorded_at AT TIME ZONE 'Asia/Manila')::date AS date,
       exit_name,
       direction,
       ROUND(AVG(aqi)::numeric,   3)::double precision AS avg_aqi,
       ROUND(AVG(co)::numeric,    3)::double precision AS avg_co,
       ROUND(AVG(no2)::numeric,   3)::double precision AS avg_no2,
       ROUND(AVG(o3)::numeric,    3)::double precision AS avg_o3,
       ROUND(AVG(so2)::numeric,   3)::double precision AS avg_so2,
       ROUND(AVG(pm2_5)::numeric, 3)::double precision AS avg_pm2_5,
       ROUND(AVG(pm10)::numeric,  3)::double precision AS avg_pm10,
       COUNT(*)::int                                   AS reading_count
FROM silver.nlex_emissions_clean
GROUP BY 1, 2, 3;

-- ---------------------------------------------------------------------------
-- gold.daily_weather_summary — one row per local day / cell
--
-- dominant_weather is the modal description for the day, chosen by frequency
-- then alphabetically so ties resolve deterministically.
--
-- Both halves are computed in ONE pass each and joined. An earlier version used
-- a LATERAL that re-scanned the 1.15M-row silver table once per day/cell group
-- (~48k groups) and blew the statement timeout.
-- ---------------------------------------------------------------------------
TRUNCATE gold.daily_weather_summary RESTART IDENTITY;

WITH local AS (
  SELECT (recorded_at AT TIME ZONE 'Asia/Manila')::date AS date,
         cell_name, temp, humidity, wind_speed, rain_1h, weather_desc
  FROM silver.hourly_weather_clean
), agg AS (
  SELECT date, cell_name,
         ROUND(AVG(temp)::numeric,       2)::double precision AS avg_temp,
         ROUND(MIN(temp)::numeric,       2)::double precision AS min_temp,
         ROUND(MAX(temp)::numeric,       2)::double precision AS max_temp,
         ROUND(AVG(humidity)::numeric,   2)::double precision AS avg_humidity,
         ROUND(AVG(wind_speed)::numeric, 2)::double precision AS avg_wind_speed,
         ROUND(SUM(rain_1h)::numeric,    2)::double precision AS total_rain
  FROM local GROUP BY 1, 2
), modal AS (
  SELECT date, cell_name, weather_desc,
         ROW_NUMBER() OVER (PARTITION BY date, cell_name
                            ORDER BY COUNT(*) DESC, weather_desc) AS rn
  FROM local WHERE weather_desc IS NOT NULL
  GROUP BY date, cell_name, weather_desc
)
INSERT INTO gold.daily_weather_summary
  (date, cell_name, avg_temp, min_temp, max_temp, avg_humidity,
   avg_wind_speed, total_rain, dominant_weather)
SELECT a.date, a.cell_name, a.avg_temp, a.min_temp, a.max_temp,
       a.avg_humidity, a.avg_wind_speed, a.total_rain, m.weather_desc
FROM agg a
LEFT JOIN modal m ON m.date = a.date AND m.cell_name = a.cell_name AND m.rn = 1;

COMMIT;

SELECT 'gold.daily_emissions_summary' AS table_name, COUNT(*) AS rows,
       MIN(date) AS from_date, MAX(date) AS to_date
FROM gold.daily_emissions_summary
UNION ALL
SELECT 'gold.daily_weather_summary', COUNT(*), MIN(date), MAX(date)
FROM gold.daily_weather_summary;
