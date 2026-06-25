import { db } from "../config/db.js";

// [DEV-01] Create Schedule
export async function createMaintenanceScheduleInDb(data: any) {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      INSERT INTO maintenance_schedules (segment_id, description, start_date, end_date) 
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [data.segmentId, data.description, data.startDate, data.endDate]);
    return rows[0];
  } catch (error) {
    console.error("Database query failed for create maintenance:", error);
    return null;
  }
}

// [DEV-02] List Schedules
export async function getMaintenanceSchedulesFromDb() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`SELECT * FROM maintenance_schedules`);
    return rows;
  } catch (error) {
    console.error("Database query failed for list maintenance:", error);
    return null;
  }
}

// [DEV-03] Delete Schedule
export async function deleteMaintenanceScheduleInDb(id: string) {
  if (!db) return null;
  try {
    await db.query(`DELETE FROM maintenance_schedules WHERE id = $1`, [id]);
    return true;
  } catch (error) {
    console.error("Database query failed for delete maintenance:", error);
    return null;
  }
}
