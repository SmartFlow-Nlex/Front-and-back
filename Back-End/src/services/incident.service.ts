import { db } from "../config/db.js";

// ─────────────────────────────────────────────────────────
// Incident Queries — reads from nlex_road_crashes, nlex_motorcycle_crashes,
//                    nlex_stalled_vehicles, nlex_apprehensions
// ─────────────────────────────────────────────────────────

// Check if we have incident data
export async function hasIncidentData(): Promise<boolean> {
  if (!db) return false;
  try {
    const { rows } = await db.query(`
      SELECT (
        (SELECT COUNT(*)::int FROM nlex_road_crashes) +
        (SELECT COUNT(*)::int FROM nlex_motorcycle_crashes) +
        (SELECT COUNT(*)::int FROM nlex_stalled_vehicles) +
        (SELECT COUNT(*)::int FROM nlex_apprehensions)
      ) as total
    `);
    return rows[0].total > 0;
  } catch { return false; }
}

// Total incident counts by type
export async function getIncidentCounts() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM nlex_road_crashes) as road_crashes,
        (SELECT COUNT(*)::int FROM nlex_motorcycle_crashes) as motorcycle_crashes,
        (SELECT COUNT(*)::int FROM nlex_stalled_vehicles) as stalled_vehicles,
        (SELECT COUNT(*)::int FROM nlex_apprehensions) as apprehensions
    `);
    return rows[0];
  } catch (error) {
    console.error("DB error (getIncidentCounts):", error);
    return null;
  }
}

// Average clearance time (from road crashes + motorcycle crashes)
export async function getAvgClearanceTime() {
  if (!db) return null;
  try {
    // Calculate clearance time in minutes from reported_time to cleared_time
    const { rows } = await db.query(`
      SELECT ROUND(AVG(clearance_mins), 1) as avg_clearance_time
      FROM (
        SELECT
          EXTRACT(EPOCH FROM (
            TO_TIMESTAMP(cleared_time, 'HH12:MI PM') - TO_TIMESTAMP(reported_time, 'HH12:MI PM')
          )) / 60.0 as clearance_mins
        FROM nlex_road_crashes
        WHERE cleared_time IS NOT NULL AND cleared_time != ''
          AND reported_time IS NOT NULL AND reported_time != ''
        UNION ALL
        SELECT
          EXTRACT(EPOCH FROM (
            TO_TIMESTAMP(cleared_time, 'HH12:MI PM') - TO_TIMESTAMP(reported_time, 'HH12:MI PM')
          )) / 60.0 as clearance_mins
        FROM nlex_motorcycle_crashes
        WHERE cleared_time IS NOT NULL AND cleared_time != ''
          AND reported_time IS NOT NULL AND reported_time != ''
      ) combined
      WHERE clearance_mins > 0 AND clearance_mins < 1440
    `);
    return rows[0]?.avg_clearance_time || null;
  } catch (error) {
    console.error("DB error (getAvgClearanceTime):", error);
    return null;
  }
}

// Incident causes distribution (road + motorcycle crashes)
export async function getCauseDistribution() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT cause_of_accident as cause, COUNT(*)::int as count
      FROM (
        SELECT cause_of_accident FROM nlex_road_crashes WHERE cause_of_accident IS NOT NULL
        UNION ALL
        SELECT cause_of_accident FROM nlex_motorcycle_crashes WHERE cause_of_accident IS NOT NULL
      ) combined
      GROUP BY cause_of_accident
      ORDER BY count DESC
    `);
    return rows;
  } catch (error) {
    console.error("DB error (getCauseDistribution):", error);
    return null;
  }
}

// Weather condition correlation with incidents
export async function getWeatherCorrelation() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT weather_condition, COUNT(*)::int as incident_count
      FROM (
        SELECT weather_condition FROM nlex_road_crashes WHERE weather_condition IS NOT NULL AND weather_condition != ''
        UNION ALL
        SELECT weather_condition FROM nlex_motorcycle_crashes WHERE weather_condition IS NOT NULL AND weather_condition != ''
      ) combined
      GROUP BY weather_condition
      ORDER BY incident_count DESC
    `);
    return rows;
  } catch (error) {
    console.error("DB error (getWeatherCorrelation):", error);
    return null;
  }
}

// Severity distribution — using injuries and fatalities to classify
export async function getSeverityDistribution() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT severity, COUNT(*)::int as count
      FROM (
        SELECT
          CASE
            WHEN (fatalities_male + fatalities_female) > 0 THEN 'Severe'
            WHEN (injuries_male + injuries_female) > 0 THEN 'Moderate'
            ELSE 'Minor'
          END as severity
        FROM nlex_road_crashes
        UNION ALL
        SELECT
          CASE
            WHEN (fatalities_male + fatalities_female) > 0 THEN 'Severe'
            WHEN (injuries_male + injuries_female) > 0 THEN 'Moderate'
            ELSE 'Minor'
          END as severity
        FROM nlex_motorcycle_crashes
      ) combined
      GROUP BY severity
      ORDER BY
        CASE severity WHEN 'Minor' THEN 1 WHEN 'Moderate' THEN 2 WHEN 'Severe' THEN 3 END
    `);
    return rows;
  } catch (error) {
    console.error("DB error (getSeverityDistribution):", error);
    return null;
  }
}

// Stalled vehicle causes distribution
export async function getStalledVehicleCauses() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT vehicle_cause, COUNT(*)::int as count
      FROM nlex_stalled_vehicles
      WHERE vehicle_cause IS NOT NULL AND vehicle_cause != ''
      GROUP BY vehicle_cause
      ORDER BY count DESC
    `);
    return rows;
  } catch (error) {
    console.error("DB error (getStalledVehicleCauses):", error);
    return null;
  }
}

// Apprehension (violation) distribution
export async function getViolationDistribution() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT violation, COUNT(*)::int as count
      FROM nlex_apprehensions
      WHERE violation IS NOT NULL AND violation != ''
      GROUP BY violation
      ORDER BY count DESC
    `);
    return rows;
  } catch (error) {
    console.error("DB error (getViolationDistribution):", error);
    return null;
  }
}

// Full incident summary for dashboard
export async function getIncidentSummary() {
  if (!db) return null;
  try {
    const [counts, avgClearance, causes, weather, severity, stalledCauses, violations] = await Promise.all([
      getIncidentCounts(),
      getAvgClearanceTime(),
      getCauseDistribution(),
      getWeatherCorrelation(),
      getSeverityDistribution(),
      getStalledVehicleCauses(),
      getViolationDistribution(),
    ]);
    return { counts, avgClearance, causes, weather, severity, stalledCauses, violations };
  } catch (error) {
    console.error("DB error (getIncidentSummary):", error);
    return null;
  }
}
