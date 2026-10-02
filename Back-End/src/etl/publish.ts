/**
 * Publish — carry a load from bronze into the silver tables the dashboards read.
 *
 * The upload wrote bronze and stopped there, while every dashboard reads
 * silver: public.nlex_road_crashes / _motorcycle_crashes over
 * silver.nlex_incidents_clean, the incident pages over
 * silver.nlex_accident_events_clean and silver.nlex_breakdown_events_clean,
 * and the emissions pages over silver.nlex_theoretical_emissions_clean and
 * silver.nlex_emissions_clean. Silver was only ever rebuilt by running the
 * medallion SQL by hand, so an upload could report success and change nothing
 * anyone could see.
 *
 * Each function below applies its table's cleaning rules, copied from the SQL
 * that builds it (scripts/medallion/02, 06 and 10), to exactly the bronze
 * rows this load wrote (temp table etl_written, ids), inside the load's own
 * transaction. The result is what a full rebuild would give for those rows,
 * without rebuilding millions of others or locking readers out while it runs.
 *
 * public.nlex_stalled_vehicles needs nothing: the dashboards read it directly.
 *
 * Before writing, each one tells the load's undo journal (undo.ts) which silver
 * rows it is about to add or replace, by the same rule it then applies.
 */
import type { PoolClient } from "pg";
import type { DatasetType } from "./classifier.js";
import type { UndoJournal } from "./undo.js";

export type Published = { table: string; rows: number };

/* silver.nlex_incidents_clean (06-silver-remaining.sql): a date and a
   location required, casualties non-negative, clearance kept only within a
   day, one row per (date, hour, location, type) with the first loaded kept. */
async function incidents(c: PoolClient, j: UndoJournal): Promise<Published[]> {
  // The keys it will add: those of this load's rows that silver does not hold yet.
  await j.saveNew("silver.nlex_incidents_clean", { cols: ["incident_date", "hour_of_day", "location", "incident_type"], nullable: ["hour_of_day"] }, `
    SELECT q.incident_date, q.hour_of_day, q.location, q.incident_type
      FROM bronze.nlex_incidents q
     WHERE q.id IN (SELECT id FROM etl_written)
       AND q.incident_date IS NOT NULL AND btrim(COALESCE(q.location, '')) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM silver.nlex_incidents_clean s
          WHERE s.incident_date = q.incident_date AND COALESCE(s.hour_of_day, -1) = COALESCE(q.hour_of_day, -1)
            AND s.location = q.location AND s.incident_type = q.incident_type)`);
  const r = await c.query(`
    INSERT INTO silver.nlex_incidents_clean
      (incident_date, hour_of_day, location, incident_type, cause_of_accident, type_of_accident, weather_condition,
       injuries_male, injuries_female, fatalities_male, fatalities_female, km_value, severity, nearest_exit,
       clearance_minutes, reported_time, cleared_time)
    SELECT incident_date, hour_of_day, location, incident_type, cause_of_accident, type_of_accident, weather_condition,
           GREATEST(COALESCE(injuries_male, 0), 0), GREATEST(COALESCE(injuries_female, 0), 0),
           GREATEST(COALESCE(fatalities_male, 0), 0), GREATEST(COALESCE(fatalities_female, 0), 0),
           km_value, severity, nearest_exit,
           CASE WHEN clearance_minutes BETWEEN 0 AND 1440 THEN clearance_minutes END,
           reported_time, cleared_time
      FROM (SELECT DISTINCT ON (incident_date, hour_of_day, location, incident_type) *
              FROM bronze.nlex_incidents
             WHERE id IN (SELECT id FROM etl_written)
               AND incident_date IS NOT NULL AND btrim(COALESCE(location, '')) <> ''
             ORDER BY incident_date, hour_of_day, location, incident_type, id) q
     WHERE NOT EXISTS (
       SELECT 1 FROM silver.nlex_incidents_clean s
        WHERE s.incident_date = q.incident_date AND COALESCE(s.hour_of_day, -1) = COALESCE(q.hour_of_day, -1)
          AND s.location = q.location AND s.incident_type = q.incident_type)`);
  return [{ table: "silver.nlex_incidents_clean", rows: r.rowCount ?? 0 }];
}

/* silver.nlex_accident_events_clean (10-bronze-accident-breakdown.sql): an
   event needs a start, a cleared time and a km post, and a FINALIZED or
   AVAILABLE status; km from metres, Balintawak-relative corridor km beside
   it, clearance kept only within a day. An upserted event replaces its
   silver row, so a corrected record shows up corrected. */
async function accidents(c: PoolClient, j: UndoJournal): Promise<Published[]> {
  const events = `SELECT event_number FROM bronze.nlex_accident_data WHERE id IN (SELECT id FROM etl_written)`;
  await j.saveOld("silver.nlex_accident_events_clean", EVENT_KEY, `FROM silver.nlex_accident_events_clean t WHERE t.event_number IN (${events})`);
  await j.saveNew("silver.nlex_accident_events_clean", EVENT_KEY, events);
  await c.query(`
    DELETE FROM silver.nlex_accident_events_clean
     WHERE event_number IN (SELECT event_number FROM bronze.nlex_accident_data WHERE id IN (SELECT id FROM etl_written))`);
  const r = await c.query(`
    INSERT INTO silver.nlex_accident_events_clean
      (event_number, event_start_date, event_status, direction, location, sub_location, km_value, corridor_km,
       type_of_event, main_cause, sub_cause, detection, weather_condition, damage_to_property, property,
       number_of_vehicles, number_of_injured, number_of_fatality, blockage_cleared, site_cleared, clearance_min, deployment_count)
    SELECT event_number, event_start_date, event_status, direction, location, sub_location,
           start_km / 1000.0, (start_km / 1000.0) - 12.0,
           type_of_event, main_cause, sub_cause, detection, weather_condition, damage_to_property, property,
           GREATEST(COALESCE(number_of_vehicles, 0), 0), GREATEST(COALESCE(number_of_injured, 0), 0),
           GREATEST(COALESCE(number_of_fatality, 0), 0), blockage_cleared, site_cleared,
           CASE WHEN EXTRACT(EPOCH FROM (site_cleared - event_start_date)) / 60.0 BETWEEN 0 AND 1440
                THEN EXTRACT(EPOCH FROM (site_cleared - event_start_date)) / 60.0 END,
           deployment_count
      FROM (SELECT DISTINCT ON (event_number) *
              FROM bronze.nlex_accident_data
             WHERE event_number IN (SELECT event_number FROM bronze.nlex_accident_data WHERE id IN (SELECT id FROM etl_written))
               AND event_start_date IS NOT NULL AND site_cleared IS NOT NULL AND start_km IS NOT NULL
               AND event_status IN ('FINALIZED', 'AVAILABLE')
             ORDER BY event_number, loaded_at DESC) q`);
  return [{ table: "silver.nlex_accident_events_clean", rows: r.rowCount ?? 0 }];
}

/* silver.nlex_breakdown_events_clean (same file): FINALIZED breakdowns with a
   date and a km post, one row per event, the latest load kept. */
async function breakdowns(c: PoolClient, j: UndoJournal): Promise<Published[]> {
  const events = `SELECT event_number FROM bronze.nlex_breakdown_data WHERE id IN (SELECT id FROM etl_written)`;
  await j.saveOld("silver.nlex_breakdown_events_clean", EVENT_KEY, `FROM silver.nlex_breakdown_events_clean t WHERE t.event_number IN (${events})`);
  await j.saveNew("silver.nlex_breakdown_events_clean", EVENT_KEY, events);
  await c.query(`
    DELETE FROM silver.nlex_breakdown_events_clean
     WHERE event_number IN (SELECT event_number FROM bronze.nlex_breakdown_data WHERE id IN (SELECT id FROM etl_written))`);
  const r = await c.query(`
    INSERT INTO silver.nlex_breakdown_events_clean
      (event_number, event_encoded_date, event_status, direction, location, sub_location, km_value, corridor_km,
       sloop, vehicle, vehicle_number, type_of_vehicle, vehicle_class, plate_number, driver, main_cause, sub_cause,
       detection, trouble_description, detail_entry_count, deployment_count, deployments)
    SELECT event_number, event_encoded_date, event_status, direction, location, sub_location,
           start_km / 1000.0, (start_km / 1000.0) - 12.0,
           sloop, vehicle, vehicle_number, type_of_vehicle, vehicle_class, plate_number, driver, main_cause, sub_cause,
           detection, trouble_description, detail_entry_count, deployment_count, deployments
      FROM (SELECT DISTINCT ON (event_number) *
              FROM bronze.nlex_breakdown_data
             WHERE event_number IN (SELECT event_number FROM bronze.nlex_breakdown_data WHERE id IN (SELECT id FROM etl_written))
               AND event_encoded_date IS NOT NULL AND start_km IS NOT NULL AND event_status = 'FINALIZED'
             ORDER BY event_number, loaded_at DESC) q`);
  return [{ table: "silver.nlex_breakdown_events_clean", rows: r.rowCount ?? 0 }];
}

/* silver.nlex_theoretical_emissions_clean (06-silver-remaining.sql): NaN and
   negative grams to NULL, volume non-negative, classes 1-3 only. Keeps bronze's id. */
async function theoreticalEmissions(c: PoolClient, j: UndoJournal): Promise<Published[]> {
  await j.saveNew("silver.nlex_theoretical_emissions_clean", { cols: ["id"] }, `SELECT id FROM etl_written`);
  const r = await c.query(`
    INSERT INTO silver.nlex_theoretical_emissions_clean
      (id, exit_id, timestamp_utc, direction, vehicle_class, volume, segment_distance_km,
       co2_grams, co_grams, no2_grams, pm25_grams, pm10_grams, so2_grams)
    SELECT id, exit_id, timestamp_utc, direction, vehicle_class, GREATEST(COALESCE(volume, 0), 0), segment_distance_km,
           CASE WHEN co2_grams::text  <> 'NaN' AND co2_grams  >= 0 THEN co2_grams  END,
           CASE WHEN co_grams::text   <> 'NaN' AND co_grams   >= 0 THEN co_grams   END,
           CASE WHEN no2_grams::text  <> 'NaN' AND no2_grams  >= 0 THEN no2_grams  END,
           CASE WHEN pm25_grams::text <> 'NaN' AND pm25_grams >= 0 THEN pm25_grams END,
           CASE WHEN pm10_grams::text <> 'NaN' AND pm10_grams >= 0 THEN pm10_grams END,
           CASE WHEN so2_grams::text  <> 'NaN' AND so2_grams  >= 0 THEN so2_grams  END
      FROM bronze.nlex_theoretical_emissions
     WHERE id IN (SELECT id FROM etl_written)
       AND timestamp_utc IS NOT NULL AND vehicle_class BETWEEN 1 AND 3`);
  return [{ table: "silver.nlex_theoretical_emissions_clean", rows: r.rowCount ?? 0 }];
}

/* silver.nlex_emissions_clean (02-silver-emissions.sql): an observation time
   (api_dt) required, AQI within OpenWeather's 1-5, no negative pollutant,
   one reading per exit per observation. recorded_at is when the air was
   measured; fetched_at, when it was ingested. */
async function airQuality(c: PoolClient, j: UndoJournal): Promise<Published[]> {
  // The readings it will add: this load's, where silver has none for that exit and time yet.
  await j.saveNew("silver.nlex_emissions_clean", { cols: ["exit_id", "recorded_at"] }, `
    SELECT q.exit_id, to_timestamp(q.api_dt) AS recorded_at
      FROM bronze.nlex_emissions q
     WHERE q.id IN (SELECT id FROM etl_written) AND q.api_dt IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM silver.nlex_emissions_clean s
                        WHERE s.exit_id = q.exit_id AND s.recorded_at = to_timestamp(q.api_dt))`);
  const r = await c.query(`
    INSERT INTO silver.nlex_emissions_clean
      (exit_id, exit_name, direction, latitude, longitude, aqi, co, no, no2, o3, so2, pm2_5, pm10, nh3, recorded_at, fetched_at)
    SELECT exit_id, exit_name, direction, latitude, longitude, aqi, co, no, no2, o3, so2, pm2_5, pm10, nh3,
           to_timestamp(api_dt), recorded_at
      FROM (SELECT DISTINCT ON (exit_id, api_dt) *
              FROM bronze.nlex_emissions
             WHERE id IN (SELECT id FROM etl_written)
               AND api_dt IS NOT NULL AND aqi BETWEEN 1 AND 5
               AND COALESCE(co, 0) >= 0 AND COALESCE(no2, 0) >= 0 AND COALESCE(o3, 0) >= 0
               AND COALESCE(so2, 0) >= 0 AND COALESCE(pm2_5, 0) >= 0 AND COALESCE(pm10, 0) >= 0
             ORDER BY exit_id, api_dt, id) q
     WHERE NOT EXISTS (SELECT 1 FROM silver.nlex_emissions_clean s
                        WHERE s.exit_id = q.exit_id AND s.recorded_at = to_timestamp(q.api_dt))`);
  return [{ table: "silver.nlex_emissions_clean", rows: r.rowCount ?? 0 }];
}

const EVENT_KEY = { cols: ["event_number"] };

/** Silver tables a load of this bronze table feeds. */
const PUBLISHERS: Record<string, (c: PoolClient, j: UndoJournal) => Promise<Published[]>> = {
  "bronze.nlex_incidents": incidents,
  "bronze.nlex_accident_data": accidents,
  "bronze.nlex_breakdown_data": breakdowns,
  "bronze.nlex_theoretical_emissions": theoreticalEmissions,
  "bronze.nlex_emissions": airQuality,
};

/** Run the publisher for `table`, if it has one; [] when the dashboards read it directly. */
export async function publish(c: PoolClient, table: string, _type: DatasetType, journal: UndoJournal): Promise<Published[]> {
  const fn = PUBLISHERS[table];
  return fn ? fn(c, journal) : [];
}
