import { db } from "../config/db.js";

// ---------------------------------------------------------------------------
// Maintenance schedules — persisted in nlex_maintenance_schedules (AWS RDS).
// IMPORTANT: this data is also consumed by the mobile app; keep the row shape
// and status vocabulary stable (scheduled | in_progress | completed | cancelled).
// ---------------------------------------------------------------------------

export type MaintenanceStatus = "scheduled" | "in_progress" | "completed" | "cancelled";

export type MaintenanceCreate = {
  title: string;
  description?: string;
  startKm: number;
  endKm: number;
  direction: "NB" | "SB" | "Both";
  laneClosure: string;
  startsAt: string;
  endsAt: string;
};

// Allowed lifecycle transitions. Reverts are permitted so operator mistakes
// can be undone: completed → in_progress (reopen), cancelled → scheduled
// (restore), in_progress → scheduled (revert).
const TRANSITIONS: Record<MaintenanceStatus, MaintenanceStatus[]> = {
  scheduled: ["in_progress", "completed", "cancelled"],
  in_progress: ["completed", "cancelled", "scheduled"],
  completed: ["in_progress"],
  cancelled: ["scheduled"],
};

const ROW_COLUMNS = `id, title, description, start_km::float AS start_km, end_km::float AS end_km,
  direction, lane_closure, starts_at, ends_at, status, status_reason, created_at, updated_at`;

export async function createMaintenanceScheduleInDb(data: MaintenanceCreate) {
  if (!db) return null;
  try {
    const { rows } = await db.query(
      `INSERT INTO nlex_maintenance_schedules
         (title, description, start_km, end_km, direction, lane_closure, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${ROW_COLUMNS}`,
      [data.title, data.description ?? null, data.startKm, data.endKm, data.direction, data.laneClosure, data.startsAt, data.endsAt]
    );
    return rows[0];
  } catch (error) {
    console.error("Database query failed for create maintenance:", error);
    return null;
  }
}

export async function getMaintenanceSchedulesFromDb(status?: MaintenanceStatus | "all") {
  if (!db) return null;
  try {
    const { rows } = await db.query(
      `SELECT ${ROW_COLUMNS} FROM nlex_maintenance_schedules
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
                starts_at DESC`,
      [status && status !== "all" ? status : null]
    );
    return rows;
  } catch (error) {
    console.error("Database query failed for list maintenance:", error);
    return null;
  }
}

export async function updateMaintenanceScheduleInDb(id: string, data: MaintenanceCreate) {
  if (!db) return null;
  try {
    const { rows } = await db.query(
      `UPDATE nlex_maintenance_schedules
       SET title = $2, description = $3, start_km = $4, end_km = $5,
           direction = $6, lane_closure = $7, starts_at = $8, ends_at = $9, updated_at = now()
       WHERE id = $1
       RETURNING ${ROW_COLUMNS}`,
      [id, data.title, data.description ?? null, data.startKm, data.endKm, data.direction, data.laneClosure, data.startsAt, data.endsAt]
    );
    if (rows.length === 0) return { error: "not_found" as const };
    return { row: rows[0] };
  } catch (error) {
    console.error("Database query failed for update maintenance:", error);
    return null;
  }
}

export async function updateMaintenanceStatusInDb(id: string, status: MaintenanceStatus, reason?: string) {
  if (!db) return null;
  try {
    const cur = await db.query(`SELECT status FROM nlex_maintenance_schedules WHERE id = $1`, [id]);
    if (cur.rows.length === 0) return { error: "not_found" as const };
    const from: MaintenanceStatus = cur.rows[0].status;
    if (!TRANSITIONS[from].includes(status)) {
      return { error: "invalid_transition" as const, from };
    }
    const { rows } = await db.query(
      `UPDATE nlex_maintenance_schedules
       SET status = $2, status_reason = $3, updated_at = now()
       WHERE id = $1
       RETURNING ${ROW_COLUMNS}`,
      [id, status, reason ?? null]
    );
    // `from` is returned on success as well as on conflict: the audit trail needs
    // the real prior status to measure how long the schedule sat in it.
    return { row: rows[0], from };
  } catch (error) {
    console.error("Database query failed for maintenance status update:", error);
    return null;
  }
}

export async function deleteMaintenanceScheduleInDb(id: string) {
  if (!db) return null;
  try {
    await db.query(`DELETE FROM nlex_maintenance_schedules WHERE id = $1`, [id]);
    return true;
  } catch (error) {
    console.error("Database query failed for delete maintenance:", error);
    return null;
  }
}
