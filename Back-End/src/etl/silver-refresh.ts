/**
 * Silver refreshes that must run after a bronze load for the dashboard to
 * change.
 *
 * WHY THIS EXISTS: the loader already knew how to make traffic-volume uploads
 * visible (REFRESH MATERIALIZED VIEW nlex_traffic_volume — see loader.ts), but
 * accident/breakdown silver is not a materialized view. It is a plain table
 * built by DROP + CREATE TABLE AS, and it lived only in
 * scripts/medallion/10-bronze-accident-breakdown.sql, which is run by hand.
 * So an upload through the dashboard landed in bronze and stopped there: the
 * ETL reported "N rows inserted" truthfully while every chart kept reading the
 * stale silver snapshot. These statements close that gap.
 *
 * ATOMICITY: each refresh is wrapped in BEGIN/COMMIT. DROP TABLE takes an
 * ACCESS EXCLUSIVE lock, so without the transaction there is a window where
 * the table does not exist and concurrent dashboard queries fail outright.
 * Inside one, readers block for the length of the rebuild and then see the new
 * snapshot — a pause, never an error.
 *
 * KEEP IN SYNC: scripts/medallion/10-bronze-accident-breakdown.sql holds the
 * same two definitions, because that file still has to build silver on a fresh
 * database where this code has never run. Change one, change the other.
 */

export interface SilverRefresh {
  /** Table being rebuilt, used in the error message when it fails. */
  label: string;
  sql: string;
}

/**
 * silver.nlex_accident_events_clean
 *   * de-duplicated on event_number (keep the most recently loaded copy)
 *   * requires a start date, a cleared timestamp, and a km post
 *   * DELETED/OPEN event_status rows excluded
 *   * casualty counts coerced to non-negative
 *   * clearance_min NULLed (not row-dropped) when outside 0-1440 minutes
 */
export const REFRESH_ACCIDENT_SILVER: SilverRefresh = {
  label: "silver.nlex_accident_events_clean",
  sql: `
BEGIN;

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

COMMIT;
`,
};

/**
 * silver.nlex_breakdown_events_clean
 *   * de-duplicated on event_number
 *   * only FINALIZED breakdowns
 */
export const REFRESH_BREAKDOWN_SILVER: SilverRefresh = {
  label: "silver.nlex_breakdown_events_clean",
  sql: `
BEGIN;

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
`,
};
