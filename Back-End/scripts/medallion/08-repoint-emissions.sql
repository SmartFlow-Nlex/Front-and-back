-- Repoint the measured air-quality view from BRONZE to SILVER.
--
-- Held back from 07 because it needed a code change first. The service read
-- api_dt, a raw Unix epoch that silver replaces with a proper timestamptz
-- recorded_at, so repointing before that would have broken the AQI charts.
-- emissions.service.ts now reads recorded_at AT TIME ZONE 'Asia/Manila'.
--
-- Two bronze-only columns are deliberately NOT carried forward:
--   api_dt        superseded by recorded_at
--   raw_response  the untouched API payload, which belongs in bronze only
--
-- fetched_at is exposed as the ingestion timestamp, which is what bronze's
-- misleadingly-named recorded_at actually held.

-- DROP then CREATE rather than CREATE OR REPLACE: replacing a view cannot
-- remove columns, and this definition drops api_dt and raw_response. Verified
-- that nothing else depends on the view before dropping it.
BEGIN;

DROP VIEW IF EXISTS public.nlex_emissions;

CREATE VIEW public.nlex_emissions AS
SELECT id, exit_id, exit_name, direction, latitude, longitude,
       aqi, co, no, no2, o3, so2, pm2_5, pm10, nh3,
       recorded_at,   -- when the reading was taken
       fetched_at     -- when we ingested it
FROM silver.nlex_emissions_clean;

COMMIT;

SELECT 'public.nlex_emissions' AS relation,
       COUNT(*)                AS rows,
       MIN(recorded_at)::date  AS observed_from,
       MAX(recorded_at)::date  AS observed_to
FROM public.nlex_emissions;
