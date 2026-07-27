import { db } from "../config/db.js";

// [DEV-01] Save Audit Event
export async function saveAuditEventInDb(data: {
  user_id: string;
  action: string;
  target_resource?: string;
  details?: Record<string, unknown>;
  severity?: string;
  module?: string;
  previous_status?: string;
  new_status?: string;
}) {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      INSERT INTO audit_logs (user_id, action, target_resource, details, severity, module, previous_status, new_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      data.user_id,
      data.action,
      data.target_resource ?? null,
      JSON.stringify(data.details || {}),
      data.severity ?? "info",
      data.module ?? null,
      data.previous_status ?? null,
      data.new_status ?? null,
    ]);
    return rows[0];
  } catch (error) {
    console.error("Database query failed for save audit event:", error);
    return null;
  }
}

// [DEV-02, DEV-03] Get Audit Logs (with filtering)
export async function getAuditLogsFromDb(filters: {
  user_id?: string;
  action?: string;
  module?: string;
  severity?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
}) {
  if (!db) return null;
  try {
    let query = `SELECT * FROM audit_logs WHERE 1=1`;
    const params: unknown[] = [];
    let idx = 1;

    if (filters.user_id) {
      query += ` AND user_id = $${idx++}`;
      params.push(filters.user_id);
    }
    if (filters.action) {
      query += ` AND action = $${idx++}`;
      params.push(filters.action);
    }
    if (filters.module) {
      query += ` AND module = $${idx++}`;
      params.push(filters.module);
    }
    if (filters.severity) {
      query += ` AND severity = $${idx++}`;
      params.push(filters.severity);
    }
    if (filters.start_date) {
      query += ` AND timestamp >= $${idx++}`;
      params.push(filters.start_date);
    }
    if (filters.end_date) {
      query += ` AND timestamp <= $${idx++}`;
      params.push(filters.end_date);
    }

    const limit = Math.min(filters.limit ?? 200, 500);
    query += ` ORDER BY timestamp DESC LIMIT ${limit}`;

    const { rows } = await db.query(query, params);
    return rows;
  } catch (error) {
    console.error("Database query failed for list audit logs:", error);
    return null;
  }
}

// [DEV-04] GET /api/v1/audit-log/stats — aggregated operational intelligence
export async function getAuditStatsFromDb() {
  if (!db) return null;
  try {
    const [eventsPerModule, topUsers, topActions, recentWarnings, dailyTrend] = await Promise.all([
      // Events grouped by module
      db.query(`
        SELECT
          COALESCE(module, split_part(action, '.', 1)) AS module,
          COUNT(*) AS total,
          SUM(CASE WHEN severity IN ('warning','critical') THEN 1 ELSE 0 END) AS warnings
        FROM audit_logs
        GROUP BY 1
        ORDER BY total DESC
        LIMIT 10
      `),
      // Most active users
      db.query(`
        SELECT user_id, COUNT(*) AS total
        FROM audit_logs
        GROUP BY user_id
        ORDER BY total DESC
        LIMIT 5
      `),
      // Most frequent actions
      db.query(`
        SELECT action, COUNT(*) AS total
        FROM audit_logs
        GROUP BY action
        ORDER BY total DESC
        LIMIT 8
      `),
      // Recent warning/critical events (last 7 days)
      db.query(`
        SELECT id, timestamp, user_id, action, target_resource, details, severity
        FROM audit_logs
        WHERE severity IN ('warning', 'critical')
          AND timestamp >= NOW() - INTERVAL '7 days'
        ORDER BY timestamp DESC
        LIMIT 10
      `),
      // Daily event count for the last 14 days
      db.query(`
        SELECT
          DATE(timestamp) AS day,
          COUNT(*) AS total
        FROM audit_logs
        WHERE timestamp >= NOW() - INTERVAL '14 days'
        GROUP BY 1
        ORDER BY 1 ASC
      `),
    ]);

    return {
      eventsPerModule: eventsPerModule.rows,
      topUsers: topUsers.rows,
      topActions: topActions.rows,
      recentWarnings: recentWarnings.rows,
      dailyTrend: dailyTrend.rows,
    };
  } catch (error) {
    console.error("Database query failed for audit stats:", error);
    return null;
  }
}
