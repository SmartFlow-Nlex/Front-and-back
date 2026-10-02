import { db } from "../config/db.js";

// Entries are written by services/audit.ts; this reads them.

/** The latest entries, newest first. Page views are left out unless asked for: they would bury every other entry. */
export async function getAuditLogsFromDb(filters: {
  user_id?: string; action?: string; module?: string; include_views?: "0" | "1"; limit?: number;
  start_date?: string; end_date?: string;
}) {
  if (!db) return null;
  try {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
    if (filters.user_id) add("user_id = ?", filters.user_id);
    if (filters.action) add("action = ?", filters.action);
    if (filters.module) add("module = ?", filters.module);
    if (filters.start_date) add(`"timestamp" >= ?`, filters.start_date);
    if (filters.end_date) add(`"timestamp" <= ?`, filters.end_date);
    if (filters.include_views !== "1") where.push(`action <> 'page.viewed'`);
    params.push(filters.limit ?? 500);
    const { rows } = await db.query(
      `SELECT * FROM audit_logs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY "timestamp" DESC LIMIT $${params.length}`,
      params,
    );
    return rows;
  } catch (error) {
    console.error("Database query failed for list audit logs:", error);
    return null;
  }
}
