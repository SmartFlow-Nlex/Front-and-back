import { db } from "../config/db.js";

export type AuditEvent = {
  user_id?: string;
  actor_role?: string;
  action: string;                 // "<module>.<verb>"
  module?: string;
  entity_type?: string;
  entity_id?: string;
  target_resource?: string;
  from_status?: string | null;
  to_status?: string | null;
  outcome?: string;               // created|updated|approved|rejected|revised|escalated|deleted
  request_id?: string;
  details?: Record<string, unknown>;
};

// [DEV-01] Save Audit Event
//
// A log that records only "who did what" cannot answer how the process behaves.
// Every event therefore carries the state TRANSITION (from_status -> to_status)
// and duration_ms — the gap since this entity's previous event — which is what
// makes turnaround time, bottleneck detection and delay monitoring possible
// later. duration_ms is computed here rather than at read time so it stays
// correct even if rows are exported or archived.
export async function saveAuditEventInDb(data: AuditEvent) {
  if (!db) return null;
  try {
    const moduleName = data.module ?? data.action.split(".")[0] ?? null;
    const entityId =
      data.entity_id ?? (data.target_resource?.includes(":")
        ? data.target_resource.split(":").slice(1).join(":")
        : null);

    // Previous event for this entity: gives us the prior state and the dwell time.
    let fromStatus = data.from_status ?? null;
    let durationMs: number | null = null;
    if (entityId) {
      const prev = await db.query(
        `SELECT to_status, timestamp FROM audit_logs
         WHERE entity_id = $1 AND ($2::text IS NULL OR entity_type = $2)
         ORDER BY timestamp DESC LIMIT 1`,
        [entityId, data.entity_type ?? null]
      );
      if (prev.rows.length) {
        if (fromStatus === null) fromStatus = prev.rows[0].to_status ?? null;
        durationMs = Date.now() - new Date(prev.rows[0].timestamp).getTime();
      }
    }

    const { rows } = await db.query(
      `INSERT INTO audit_logs
         (user_id, actor_role, action, module, entity_type, entity_id, target_resource,
          from_status, to_status, outcome, duration_ms, request_id, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        data.user_id ?? "unknown",
        data.actor_role ?? null,
        data.action,
        moduleName,
        data.entity_type ?? null,
        entityId,
        data.target_resource ?? null,
        fromStatus,
        data.to_status ?? null,
        data.outcome ?? null,
        durationMs,
        data.request_id ?? null,
        JSON.stringify(data.details || {}),
      ]
    );
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


// [DEV-04] Process analytics derived from the log itself.
//
// This is the point of capturing from_status/to_status/duration_ms: the log
// stops being a record of who-did-what and starts answering how the process
// behaves — where work waits, which transitions are slow, who is active.
export async function getAuditAnalyticsFromDb(module?: string) {
  if (!db) return null;
  const where = module ? `WHERE module = $1` : ``;
  const params = module ? [module] : [];
  try {
    const [dwell, transitions, actors, volume] = await Promise.all([
      // How long entities sit in each status before moving on.
      db.query(
        `SELECT from_status AS status,
                COUNT(*)::int                          AS transitions,
                ROUND(AVG(duration_ms) / 1000.0, 1)    AS avg_seconds,
                ROUND(MAX(duration_ms) / 1000.0, 1)    AS max_seconds
         FROM audit_logs
         ${where} ${module ? "AND" : "WHERE"} from_status IS NOT NULL AND duration_ms IS NOT NULL
         GROUP BY 1 ORDER BY avg_seconds DESC NULLS LAST`, params),
      // Which state changes actually occur, and how slow each one is.
      db.query(
        `SELECT from_status, to_status, COUNT(*)::int AS n,
                ROUND(AVG(duration_ms) / 1000.0, 1) AS avg_seconds
         FROM audit_logs
         ${where} ${module ? "AND" : "WHERE"} from_status IS NOT NULL AND to_status IS NOT NULL
         GROUP BY 1,2 ORDER BY n DESC`, params),
      db.query(
        `SELECT user_id, COUNT(*)::int AS actions, MAX(timestamp) AS last_seen
         FROM audit_logs ${where} GROUP BY 1 ORDER BY actions DESC LIMIT 20`, params),
      db.query(
        `SELECT module, outcome, COUNT(*)::int AS n
         FROM audit_logs ${where} GROUP BY 1,2 ORDER BY n DESC`, params),
    ]);
    const slowest = dwell.rows[0] ?? null;
    return {
      dwellByStatus: dwell.rows,
      transitions: transitions.rows,
      topActors: actors.rows,
      outcomes: volume.rows,
      // Named explicitly so the UI does not have to re-derive the headline.
      bottleneck: slowest
        ? { status: slowest.status, avgSeconds: Number(slowest.avg_seconds) }
        : null,
    };
  } catch (error) {
    console.error("Database query failed for audit analytics:", error);
    return null;
  }
}
