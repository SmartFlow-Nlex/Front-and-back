import { db } from "../config/db.js";

// [DEV-01] Get Volumes and ADT from Database
export async function getTrafficVolumesFromDb(direction?: string) {
  if (!db) return null;
  try {
    let query = `SELECT segment_id as "segmentId", volume_count as "volumePerMin", avg_speed_kmh as "avgSpeedKmh" FROM traffic_volumes`;
    const params: string[] = [];

    if (direction) {
      query += ` WHERE segment_id LIKE $1`;
      params.push(`${direction}%`);
    }

    const { rows } = await db.query(query, params);
    return rows;
  } catch (error) {
    console.error("Database query failed for traffic volumes:", error);
    return null;
  }
}

// [DEV-02] Get Directional Flow from Database
export async function getDirectionalFlowFromDb() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`SELECT direction, SUM(vehicle_count) as total FROM directional_flow GROUP BY direction`);
    return rows;
  } catch (error) {
    console.error("Database query failed for directional flow:", error);
    return null;
  }
}

// [DEV-03] Get Vehicle Class Distribution from Database
export async function getVehicleClassDistributionFromDb() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`SELECT class_type, SUM(count) as count FROM vehicle_classes GROUP BY class_type`);
    return rows;
  } catch (error) {
    console.error("Database query failed for vehicle classes:", error);
    return null;
  }
}
