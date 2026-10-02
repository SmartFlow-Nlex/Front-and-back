/**
 * What the audit log says about how the system is actually used: the figures
 * behind the Audit Log page's insights. Business tables say what NLEX handles;
 * these say how the work on them moves.
 *
 *   usage        actions and page views per day, per module, per user, per page
 *   maintenance  where the schedule flow waits (average time in each status),
 *                turnaround from creation to completed, and the open schedules
 *                that are late to start or running past their planned end
 *   uploads      loads, failures, undos and checks, how long a load takes, and
 *                the loads still waiting for the weekly retrain
 *   models       the weekly retrain's latest result per model group
 *
 * Entries written before the structured columns were filled have no module;
 * it is read from the action's prefix instead ("maintenance.x" -> maintenance).
 * "dashboard" and "anonymous" are entries whose user was not identified.
 */
import { db } from "../config/db.js";
import { nextRetrain } from "./retrain-schedule.js";

const MODULE = `COALESCE(module, CASE split_part(action, '.', 1)
  WHEN 'upload' THEN 'data_management' WHEN 'mobile_config' THEN 'mobile_app' ELSE split_part(action, '.', 1) END)`;
const IN_WINDOW = `"timestamp" >= now() - make_interval(days => $1)`;
const UNIDENTIFIED = `(user_id IN ('dashboard', 'anonymous') OR user_id LIKE 'system:%')`;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

async function exists(table: string): Promise<boolean> {
  const { rows } = await db!.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table]);
  return Boolean(rows[0]?.ok);
}

export async function getAuditInsights(days: number) {
  if (!db) return null;
  const q = (sql: string, params: unknown[] = [days]) => db!.query(sql, params).then((r) => r.rows);
  const [hasBatches, hasMaintenance] = await Promise.all([exists("gold.ml_batch_runs"), exists("nlex_maintenance_schedules")]);

  const [totals, daily, modules, pages, users, uploadsAudit, uploadsTable, dwell, turnaround, openItems, models, lastBatch] = await Promise.all([
    q(`SELECT count(*) FILTER (WHERE action <> 'page.viewed')::int AS actions,
              count(*) FILTER (WHERE action = 'page.viewed')::int AS views,
              count(DISTINCT user_id) FILTER (WHERE NOT ${UNIDENTIFIED})::int AS users,
              count(*) FILTER (WHERE action <> 'page.viewed' AND user_id IN ('dashboard', 'anonymous'))::int AS unidentified
         FROM audit_logs WHERE ${IN_WINDOW}`),
    q(`SELECT ("timestamp" AT TIME ZONE 'Asia/Manila')::date::text AS day,
              count(*) FILTER (WHERE action <> 'page.viewed')::int AS actions,
              count(*) FILTER (WHERE action = 'page.viewed')::int AS views
         FROM audit_logs WHERE ${IN_WINDOW} GROUP BY 1 ORDER BY 1`),
    q(`SELECT ${MODULE} AS module, count(*)::int AS actions
         FROM audit_logs WHERE ${IN_WINDOW} AND action <> 'page.viewed' GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT COALESCE(entity_id, target_resource) AS path, count(*)::int AS views, count(DISTINCT user_id)::int AS users
         FROM audit_logs WHERE ${IN_WINDOW} AND action = 'page.viewed' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
    q(`SELECT user_id AS "user", max(actor_role) AS role, count(*)::int AS actions, max("timestamp") AS last
         FROM audit_logs WHERE ${IN_WINDOW} AND action <> 'page.viewed' AND NOT ${UNIDENTIFIED}
        GROUP BY 1 ORDER BY 3 DESC LIMIT 5`),
    q(`SELECT count(*) FILTER (WHERE action = 'upload.checked')::int AS checked,
              avg(duration_ms) FILTER (WHERE action = 'upload.loaded') AS avg_load_ms,
              count(*) FILTER (WHERE action = 'upload.undo_refused')::int AS undo_refused
         FROM audit_logs WHERE ${IN_WINDOW}`),
    // Counts from data_uploads itself, which predates the audit entries for uploads.
    q(`SELECT count(*) FILTER (WHERE status IN ('processed', 'undone'))::int AS loaded,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE status = 'undone')::int AS undone
         FROM data_uploads WHERE uploaded_at >= now() - make_interval(days => $1)`),
    // Where the maintenance flow waits: how long schedules stayed in each status before leaving it.
    q(`SELECT from_status AS status, count(*)::int AS changes, avg(duration_ms) AS avg_ms, max(duration_ms) AS max_ms
         FROM audit_logs
        WHERE ${IN_WINDOW} AND action = 'maintenance.status_changed' AND from_status IS NOT NULL AND duration_ms IS NOT NULL
        GROUP BY 1 ORDER BY 3 DESC`),
    hasMaintenance
      ? q(`SELECT count(*)::int AS completed, avg(EXTRACT(EPOCH FROM (a."timestamp" - s.created_at)) * 1000) AS avg_ms
             FROM audit_logs a JOIN nlex_maintenance_schedules s ON a.target_resource = 'maintenance:' || s.id::text
            WHERE a."timestamp" >= now() - make_interval(days => $1) AND a.action = 'maintenance.status_changed'
              AND COALESCE(a.to_status, a.details->>'to') = 'completed'`)
      : Promise.resolve([]),
    // Open schedules, the ones off plan first: late to start, or still running past their planned end.
    hasMaintenance
      ? q(`SELECT s.id::text AS id, s.title, s.status, s.starts_at, s.ends_at,
                  COALESCE((SELECT max(a."timestamp") FROM audit_logs a
                             WHERE a.target_resource = 'maintenance:' || s.id::text
                               AND a.action IN ('maintenance.status_changed', 'maintenance.schedule_created')), s.created_at) AS since,
                  CASE WHEN s.status = 'in_progress' AND s.ends_at < now() THEN 'overrunning'
                       WHEN s.status = 'scheduled' AND s.starts_at < now() THEN 'late to start' END AS flag
             FROM nlex_maintenance_schedules s
            WHERE s.status IN ('scheduled', 'in_progress')
            ORDER BY (CASE WHEN s.status = 'in_progress' AND s.ends_at < now() THEN 0
                           WHEN s.status = 'scheduled' AND s.starts_at < now() THEN 1 ELSE 2 END), since`, [])
      : Promise.resolve([]),
    q(`SELECT DISTINCT ON (entity_id) entity_id AS "group", details->>'title' AS title, outcome, from_status, to_status, "timestamp" AS at
         FROM audit_logs WHERE module = 'model_training' AND entity_type = 'model_group'
        ORDER BY entity_id, "timestamp" DESC`, []),
    hasBatches
      ? q(`SELECT id, started_at, finished_at, trigger, status, summary FROM gold.ml_batch_runs ORDER BY id DESC LIMIT 1`, [])
      : Promise.resolve([]),
  ]);

  // Loads the models have not seen yet: since the last batch that finished, or, before the first
  // batch, since the volume models were last trained.
  const sinceTraining = hasBatches && lastBatch[0]?.finished_at
    ? lastBatch[0].finished_at
    : (await q(`SELECT max(updated_at) AS at FROM gold.ml_model_metrics WHERE target = 'Total Traffic'`, []))[0]?.at ?? null;
  const waiting = sinceTraining
    ? (await q(`SELECT count(*)::int AS n, min(uploaded_at) AS oldest FROM data_uploads WHERE status = 'processed' AND uploaded_at > $1`, [sinceTraining]))[0]
    : { n: 0, oldest: null };

  const open = openItems as { flag: string | null }[];
  return {
    days,
    totals: totals[0],
    daily,
    modules,
    pages,
    users,
    uploads: {
      ...uploadsTable[0],
      checked: uploadsAudit[0]?.checked ?? 0,
      undoRefused: uploadsAudit[0]?.undo_refused ?? 0,
      avgLoadMs: num(uploadsAudit[0]?.avg_load_ms),
      waitingForRetrain: waiting.n,
      oldestWaiting: waiting.oldest,
      lastTrained: sinceTraining,
      nextRetrain: nextRetrain(),
    },
    maintenance: {
      dwell: (dwell as { status: string; changes: number; avg_ms: unknown; max_ms: unknown }[])
        .map((d) => ({ status: d.status, changes: d.changes, avgMs: num(d.avg_ms), maxMs: num(d.max_ms) })),
      turnaround: { completed: turnaround[0]?.completed ?? 0, avgMs: num(turnaround[0]?.avg_ms) },
      open: open.length,
      overrunning: open.filter((o) => o.flag === "overrunning").length,
      lateToStart: open.filter((o) => o.flag === "late to start").length,
      items: openItems.slice(0, 6),
    },
    models: { groups: models, lastBatch: lastBatch[0] ?? null },
  };
}
