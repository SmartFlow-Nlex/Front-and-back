/**
 * The audit log: one entry per thing that happened, written so it can be
 * analysed later, not only read.
 *
 * Every entry says who did it (the logged-in user, checked against Supabase,
 * and their role), what was done, to which record, when, in which module, the
 * record's status before and after, the outcome, and how long the step took.
 * Those columns are what turnaround, bottleneck and usage figures on the Audit
 * Log page are computed from (audit-insights.service.ts).
 *
 * Writing an entry never blocks or fails the action it records: audit() is
 * fire-and-forget, and a failed write is only reported to the server log.
 * Entries are only ever added, never edited: the record of what happened stays
 * as it was written.
 */
import { randomUUID } from "crypto";
import type { Request } from "express";
import { db } from "../config/db.js";
import { verifiedUser } from "../middleware/auth.middleware.js";

/** The part of the system an entry belongs to. */
export type AuditModule =
  | "data_management"
  | "maintenance"
  | "mobile_app"
  | "model_training"
  | "navigation"
  | "session"
  | "audit_log";

export interface AuditEvent {
  /** "<area>.<what happened>", e.g. "upload.loaded", "maintenance.status_changed". */
  action: string;
  module: AuditModule;
  /** The record it happened to. */
  entityType?: string;
  entityId?: string | number | null;
  /** A readable label for the record; defaults to "<entityType>:<entityId>". */
  target?: string;
  /** The record's status before and after. */
  fromStatus?: string | null;
  toStatus?: string | null;
  /** success | failed | refused | passed | retrained | kept previous ... */
  outcome?: string | null;
  /** How long the step took: the action itself, or the time spent in the previous status. */
  durationMs?: number | null;
  details?: Record<string, unknown>;
}

export interface Actor {
  user: string;
  role: string | null;
  /** True when the user came from a token Supabase accepted; false for a name the client only claimed. */
  verified: boolean;
}

/** Who made the request: the bearer token's user if Supabase accepts it, else the name the page sent, else anonymous. */
export async function actorOf(req: Request): Promise<Actor> {
  const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
  const user = await verifiedUser(token);
  if (user) return { user: user.email, role: user.role, verified: true };
  const claimed = req.header("x-user");
  return { user: claimed || "anonymous", role: null, verified: false };
}

let schemaReady: Promise<void> | null = null;

/** The structured columns and indexes, added once per process if the table lacks them. */
function ensureAuditSchema(): Promise<void> {
  if (!db) return Promise.resolve();
  schemaReady ??= (async () => {
    await db!.query(`
      ALTER TABLE audit_logs
        ADD COLUMN IF NOT EXISTS module text,
        ADD COLUMN IF NOT EXISTS entity_type text,
        ADD COLUMN IF NOT EXISTS entity_id text,
        ADD COLUMN IF NOT EXISTS from_status text,
        ADD COLUMN IF NOT EXISTS to_status text,
        ADD COLUMN IF NOT EXISTS outcome text,
        ADD COLUMN IF NOT EXISTS duration_ms bigint,
        ADD COLUMN IF NOT EXISTS actor_role text,
        ADD COLUMN IF NOT EXISTS request_id text`);
    // The names the warehouse already uses for these, so an existing database gets no duplicates.
    await db!.query(`CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit_logs ("timestamp" DESC)`);
    await db!.query(`CREATE INDEX IF NOT EXISTS audit_logs_module_time_idx ON audit_logs (module, "timestamp" DESC)`);
    await db!.query(`CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs (entity_type, entity_id, "timestamp")`);
  })().catch((e) => {
    schemaReady = null;
    throw e;
  });
  return schemaReady;
}

/** Write one entry and return it. */
export async function writeAudit(actor: Actor, e: AuditEvent, requestId?: string) {
  if (!db) return null;
  await ensureAuditSchema();
  const entityId = e.entityId === null || e.entityId === undefined ? null : String(e.entityId);
  const target = e.target ?? (e.entityType ? `${e.entityType}${entityId ? `:${entityId}` : ""}` : e.module);
  const details = { ...(e.details ?? {}), ...(actor.verified ? {} : { actor_verified: false }) };
  const { rows } = await db.query(
    `INSERT INTO audit_logs
       (user_id, action, target_resource, details, module, entity_type, entity_id, from_status, to_status,
        outcome, duration_ms, actor_role, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      actor.user, e.action, target, JSON.stringify(details), e.module, e.entityType ?? null, entityId,
      e.fromStatus ?? null, e.toStatus ?? null, e.outcome ?? null,
      e.durationMs === null || e.durationMs === undefined ? null : Math.round(e.durationMs),
      actor.role, requestId ?? null,
    ],
  );
  return rows[0];
}

/** The id that ties together the entries one request writes. */
export function requestIdOf(req: Request): string {
  const r = req as Request & { auditRequestId?: string };
  r.auditRequestId ??= req.header("x-request-id") || randomUUID();
  return r.auditRequestId;
}

/** Record what a request did. Fire-and-forget: never delays or fails the request. */
export function audit(req: Request, e: AuditEvent): void {
  const requestId = requestIdOf(req);
  void actorOf(req)
    .then((actor) => writeAudit(actor, e, requestId))
    .catch((err) => console.error(`[audit] could not record ${e.action}:`, err?.message ?? err));
}
