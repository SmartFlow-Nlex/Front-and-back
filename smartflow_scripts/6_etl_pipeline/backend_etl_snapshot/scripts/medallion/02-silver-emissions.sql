-- SILVER: nlex_emissions_clean
--
-- Cleans bronze.nlex_emissions into the silver layer. Idempotent: truncates and
-- reloads, so re-running always yields the same result.
--
-- TIMESTAMP SEMANTICS — the important part.
--   bronze.recorded_at is the INGESTION time. Every one of the 978,796 rows
--   carries a value inside a single hour on 2026-08-02, because that is when the
--   backfill ran. It is not when the air was measured.
--   bronze.api_dt is the OBSERVATION time, a Unix epoch from OpenWeather,
--   spanning 2020-11-27 to 2026-08-02 across 48,879 distinct hours.
--   bronze.fetched_at is entirely NULL.
--
--   So silver maps:
--     recorded_at <- to_timestamp(api_dt)      (when the reading was taken)
--     fetched_at  <- bronze.recorded_at        (when we ingested it)
--
--   Deduplicating on bronze.recorded_at instead of api_dt collapses the whole
--   table to 2,780 rows on one day. Any query that groups emissions by time must
--   use api_dt.
--
-- Cleaning rules applied (this is what makes it silver rather than a copy):
--   * drop readings with no observation timestamp
--   * keep only the plausible OpenWeather AQI band 1-5
--   * drop negative pollutant concentrations, which are sensor faults
--   * de-duplicate on (exit_id, observation hour), keeping the first ingested
--   * drop raw_response, which belongs only in bronze

BEGIN;

TRUNCATE silver.nlex_emissions_clean RESTART IDENTITY;

INSERT INTO silver.nlex_emissions_clean
  (exit_id, exit_name, direction, latitude, longitude,
   aqi, co, no, no2, o3, so2, pm2_5, pm10, nh3, recorded_at, fetched_at)
SELECT exit_id, exit_name, direction, latitude, longitude,
       aqi, co, no, no2, o3, so2, pm2_5, pm10, nh3, observed_at, ingested_at
FROM (
  SELECT DISTINCT ON (exit_id, api_dt)
         exit_id, exit_name, direction, latitude, longitude,
         aqi, co, no, no2, o3, so2, pm2_5, pm10, nh3,
         to_timestamp(api_dt) AS observed_at,
         recorded_at          AS ingested_at
  FROM bronze.nlex_emissions
  WHERE api_dt IS NOT NULL
    AND aqi BETWEEN 1 AND 5
    AND COALESCE(co,    0) >= 0
    AND COALESCE(no2,   0) >= 0
    AND COALESCE(o3,    0) >= 0
    AND COALESCE(so2,   0) >= 0
    AND COALESCE(pm2_5, 0) >= 0
    AND COALESCE(pm10,  0) >= 0
  ORDER BY exit_id, api_dt, id
) q;

COMMIT;

SELECT 'silver.nlex_emissions_clean'  AS table_name,
       COUNT(*)                       AS rows_loaded,
       MIN(recorded_at)::date         AS observed_from,
       MAX(recorded_at)::date         AS observed_to,
       COUNT(DISTINCT exit_id)        AS exits,
       COUNT(DISTINCT recorded_at)    AS distinct_hours
FROM silver.nlex_emissions_clean;
