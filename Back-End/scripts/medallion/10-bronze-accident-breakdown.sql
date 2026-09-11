-- BRONZE + SILVER: accident_data / breakdown_data event exports.
--
-- These are genuinely new source tables (unlike every other bronze table in
-- this file set, bronze.nlex_accident_data / bronze.nlex_breakdown_data have
-- never existed anywhere — this migration is the one place their DDL lives,
-- so it uses CREATE TABLE IF NOT EXISTS rather than assuming a pre-existing
-- relation the way 01-bronze-events.sql etc. do).
--
-- accident_data replaces nlex_road_crashes/nlex_motorcycle_crashes as the
-- source for the incident severity/clearance models: it carries real
-- non-null NumberOfInjured/NumberOfFatality (the old tables' `severity`
-- column is 100% NULL) and a real scene-cleared timestamp, SiteCleared (the
-- old tables have no clearance timestamp at all, only reported/response).
--
-- breakdown_data is a much richer superset of nlex_stalled_vehicles (which
-- carries only 5 columns and near-uniform-random response times) — its
-- `deployments` column holds real per-service (AAP/Patrol/RAMFA/...)
-- dispatch/arrival/departure records, parsed to JSONB at ETL time by
-- transformer.ts's parseDeployments() (source data is a Python-repr string,
-- not valid JSON — see that function's doc comment for the two parse
-- wrinkles it fixes).
--
-- StartKM in both source CSVs is in METERS, snapped to 100m posts (e.g.
-- 82500 = Km 82+500) — bronze keeps it raw and unconverted (a faithful copy
-- of what was received); silver derives km_value = start_km / 1000.0 to
-- match every other table's km convention.
--
-- Bronze: CREATE TABLE IF NOT EXISTS (append-only inserts from the ETL
-- loader, same as bronze.nlex_incidents — never dropped by this file).
-- Silver: DROP + CREATE TABLE AS, idempotent and safe to re-run after every
-- bulk load, same idiom as 06-silver-remaining.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- bronze.nlex_accident_data
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bronze.nlex_accident_data (
  id                    SERIAL PRIMARY KEY,
  event_number          INT,
  event_start_date      TIMESTAMP,
  event_type            TEXT,
  event_status          TEXT,
  direction             TEXT,
  location              TEXT,
  sub_location          TEXT,
  start_km              NUMERIC,        -- raw meters, as received
  type_of_event         TEXT,
  main_cause            TEXT,
  sub_cause             TEXT,
  detection             TEXT,
  weather_condition     TEXT,
  damage_to_property    TEXT,
  property              TEXT,
  number_of_vehicles    INT,
  number_of_injured     INT,
  number_of_fatality    INT,
  blockage_cleared      TIMESTAMP,
  site_cleared          TIMESTAMP,
  deployment_count      INT,
  injury_record_count   INT,
  vehicle_record_count  INT,
  loaded_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_bronze_accident_event_number ON bronze.nlex_accident_data (event_number);
CREATE INDEX IF NOT EXISTS ix_bronze_accident_start_date   ON bronze.nlex_accident_data (event_start_date);

-- ---------------------------------------------------------------------------
-- bronze.nlex_breakdown_data
--   MaterialTraffic dropped — 100% NULL across all 5 years of source data.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bronze.nlex_breakdown_data (
  id                    SERIAL PRIMARY KEY,
  event_number          INT,
  event_encoded_date    TIMESTAMP,
  event_type            TEXT,
  event_status          TEXT,
  direction             TEXT,
  location              TEXT,
  sub_location          TEXT,
  start_km              NUMERIC,        -- raw meters, as received
  sloop                 INT,
  vehicle               TEXT,
  vehicle_number        TEXT,           -- source column named "Number"
  type_of_vehicle       TEXT,
  vehicle_class         TEXT,
  plate_number          TEXT,
  driver                TEXT,
  main_cause            TEXT,
  sub_cause             TEXT,
  detection             TEXT,
  trouble_description   TEXT,
  detail_entry_count    INT,
  deployment_count      INT,
  deployments           JSONB,          -- parsed by transformer.ts's parseDeployments()
  loaded_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_bronze_breakdown_event_number ON bronze.nlex_breakdown_data (event_number);
CREATE INDEX IF NOT EXISTS ix_bronze_breakdown_encoded_date ON bronze.nlex_breakdown_data (event_encoded_date);

-- ---------------------------------------------------------------------------
-- silver.nlex_accident_events_clean
--   * de-duplicated on event_number (keep the most recently loaded copy)
--   * requires a start date, a cleared timestamp, and a km post — an
--     accident missing any of those cannot feed the clearance/severity models
--   * DELETED/OPEN event_status rows excluded (6 + 12 rows in the source data
--     — not resolved incidents, no real clearance to measure)
--   * casualty counts coerced to non-negative
--   * clearance_min NULLed (not row-dropped) when outside 0-1440 minutes,
--     same convention as silver.nlex_incidents_clean's clearance_minutes
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS silver.nlex_accident_events_clean;
CREATE TABLE silver.nlex_accident_events_clean AS
SELECT event_number, event_start_date, event_status, direction, location, sub_location,
       start_km / 1000.0 AS km_value,
       type_of_event, main_cause, sub_cause, detection, weather_condition, damage_to_property,
       property,
       GREATEST(COALESCE(number_of_vehicles, 0), 0) AS number_of_vehicles,
       GREATEST(COALESCE(number_of_injured,  0), 0) AS number_of_injured,
       GREATEST(COALESCE(number_of_fatality, 0), 0) AS number_of_fatality,
       blockage_cleared, site_cleared,
       CASE WHEN EXTRACT(EPOCH FROM (site_cleared - event_start_date)) / 60.0 BETWEEN 0 AND 1440
            THEN EXTRACT(EPOCH FROM (site_cleared - event_start_date)) / 60.0 END AS clearance_min,
       deployment_count
FROM (
  SELECT DISTINCT ON (event_number) *
  FROM bronze.nlex_accident_data
  WHERE event_number IS NOT NULL
    AND event_start_date IS NOT NULL
    AND site_cleared IS NOT NULL
    AND start_km IS NOT NULL
    AND event_status IN ('FINALIZED', 'AVAILABLE')
  ORDER BY event_number, loaded_at DESC
) q;

CREATE INDEX ix_silver_accident_start_date ON silver.nlex_accident_events_clean (event_start_date);
CREATE INDEX ix_silver_accident_km         ON silver.nlex_accident_events_clean (km_value);

-- ---------------------------------------------------------------------------
-- silver.nlex_breakdown_events_clean
--   * de-duplicated on event_number
--   * only FINALIZED breakdowns (the ~30 OPEN/UNAVAILABLE/DELETED/malformed
--     status rows out of 156,939 are excluded — not resolved events)
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS silver.nlex_breakdown_events_clean;
CREATE TABLE silver.nlex_breakdown_events_clean AS
SELECT event_number, event_encoded_date, event_status, direction, location, sub_location,
       start_km / 1000.0 AS km_value,
       sloop, vehicle, vehicle_number, type_of_vehicle, vehicle_class, plate_number, driver,
       main_cause, sub_cause, detection, trouble_description, detail_entry_count,
       deployment_count, deployments
FROM (
  SELECT DISTINCT ON (event_number) *
  FROM bronze.nlex_breakdown_data
  WHERE event_number IS NOT NULL
    AND event_encoded_date IS NOT NULL
    AND start_km IS NOT NULL
    AND event_status = 'FINALIZED'
  ORDER BY event_number, loaded_at DESC
) q;

CREATE INDEX ix_silver_breakdown_encoded_date ON silver.nlex_breakdown_events_clean (event_encoded_date);
CREATE INDEX ix_silver_breakdown_main_cause   ON silver.nlex_breakdown_events_clean (main_cause);

COMMIT;

SELECT 'bronze.nlex_accident_data'         AS table_name, COUNT(*) AS rows FROM bronze.nlex_accident_data
UNION ALL SELECT 'bronze.nlex_breakdown_data',        COUNT(*) FROM bronze.nlex_breakdown_data
UNION ALL SELECT 'silver.nlex_accident_events_clean',  COUNT(*) FROM silver.nlex_accident_events_clean
UNION ALL SELECT 'silver.nlex_breakdown_events_clean', COUNT(*) FROM silver.nlex_breakdown_events_clean
ORDER BY 1;
