import { db } from "../config/db.js";

// [DEV-01 & DEV-03] Fetch merged real-time data (from volumes and incidents)
export async function getRealtimeMapDataFromDb() {
  if (!db) return null;
  try {
    const { rows: volumes } = await db.query(`SELECT * FROM traffic_volumes`);
    const { rows: incidents } = await db.query(`SELECT * FROM incidents_table`);
    return { volumes, incidents };
  } catch (error) {
    console.error("Database query failed for map real-time:", error);
    return null;
  }
}

// [DEV-04] Exit search
export async function searchExitsInDb(query: string) {
  if (!db) return null;
  try {
    // Basic search simulation
    const { rows } = await db.query(`
      SELECT * FROM traffic_volumes 
      WHERE segment_id ILIKE $1
    `, [`%${query}%`]);
    return rows;
  } catch (error) {
    console.error("Database query failed for exit search:", error);
    return null;
  }
}
