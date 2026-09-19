import { db } from "../config/db.js";

// [DEV-01] Save Audit Event
export async function saveAuditEventInDb(data: any) {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      INSERT INTO audit_logs (user_id, action, target_resource, details) 
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [data.user_id, data.action, data.target_resource, JSON.stringify(data.details || {})]);
    return rows[0];
  } catch (error) {
    console.error("Database query failed for save audit event:", error);
    return null;
  }
}

// [DEV-02, DEV-03] Get Audit Logs (with basic filtering)
export async function getAuditLogsFromDb(filters: any) {
  if (!db) return null;
  try {
    let query = `SELECT * FROM audit_logs WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (filters.user_id) {
      query += ` AND user_id = $${idx++}`;
      params.push(filters.user_id);
    }
    if (filters.action) {
      query += ` AND action = $${idx++}`;
      params.push(filters.action);
    }

    query += ` ORDER BY timestamp DESC LIMIT 100`;

    const { rows } = await db.query(query, params);
    return rows;
  } catch (error) {
    console.error("Database query failed for list audit logs:", error);
    return null;
  }
}
