import { db } from "../config/db.js";

// [DEV-01] Get Incident List
export async function getIncidentListFromDb(status: string) {
  if (!db) return null;
  try {
    let query = `SELECT * FROM incidents_table`;
    if (status === "active") query += ` WHERE clearance_time_mins IS NULL`;
    if (status === "resolved") query += ` WHERE clearance_time_mins IS NOT NULL`;
    
    const { rows } = await db.query(query);
    return rows;
  } catch (error) {
    console.error("Database query failed for incidents:", error);
    return null;
  }
}

// [DEV-02] Get Incident Metrics (Rate, Severity, Clearance Time)
export async function getIncidentMetricsFromDb() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT 
        COUNT(*) as total_incidents,
        AVG(clearance_time_mins) as avg_clearance_time,
        severity, COUNT(severity) as severity_count
      FROM incidents_table
      GROUP BY severity
    `);
    return rows;
  } catch (error) {
    console.error("Database query failed for incident metrics:", error);
    return null;
  }
}

// [DEV-03] Get Weather Correlation
export async function getWeatherCorrelationFromDb() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT weather_condition, COUNT(*) as incident_count
      FROM incidents_table
      GROUP BY weather_condition
    `);
    return rows;
  } catch (error) {
    console.error("Database query failed for weather correlation:", error);
    return null;
  }
}
