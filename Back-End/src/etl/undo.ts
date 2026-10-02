/**
 * Undo for uploads.
 *
 * Every load keeps a journal, in the etl_undo schema, of exactly what it changed:
 *   old  a copy of every row it replaced, updated or deleted, as it was before;
 *   new  the key of every row it wrote.
 * Undo deletes the rows under the "new" keys and puts the "old" rows back, every
 * table in one transaction, so the warehouse is as it was before the load.
 *
 * The journal is written inside the load's own transaction, so a check (rolled
 * back) or a failed load leaves none. The latest UNDO_KEEP loads can be undone;
 * older journals are dropped to bound their size. A load cannot be undone while
 * a later load that is still in place changed one of the same tables: its old
 * rows would overwrite what that later load wrote. Undo the later one first.
 * Writes that bypass the upload (the loading scripts in smartflow_scripts) are
 * not journaled, so undo cannot see them.
 */
import type { PoolClient } from "pg";
import { db } from "../config/db.js";

/** How many of the latest loads keep their journal. */
export const UNDO_KEEP = 10;

/** How a table's rows are matched: key columns, and which of them may be NULL. */
export type UndoKey = { cols: string[]; nullable?: string[] };

type TableSpec = { table: string; cols: string[]; nullable: string[] };

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const journalOf = (table: string) => {
  const [schema, name] = table.split(".");
  return { name: `etl_undo.${q(`${schema}__${name}`)}`, index: q(`${schema}__${name}_batch`) };
};

async function columnsOf(c: PoolClient, table: string): Promise<{ name: string; type: string }[]> {
  const r = await c.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [table],
  );
  return r.rows;
}

export async function ensureUndoSchema(c: PoolClient): Promise<void> {
  await c.query(`CREATE SCHEMA IF NOT EXISTS etl_undo`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS etl_undo.batches (
      id           bigserial PRIMARY KEY,
      created_at   timestamptz NOT NULL DEFAULT now(),
      dataset_type text,
      upload_id    bigint,
      tables       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{table, cols, nullable}], in the order the load wrote them
      status       text NOT NULL DEFAULT 'active',      -- active | undone | expired
      undone_at    timestamptz
    )`);
}

/** The journal of one load. Open it inside the load's transaction, record before each write, close before COMMIT. */
export class UndoJournal {
  private specs = new Map<string, TableSpec>();
  private ready = new Map<string, string[]>();

  private constructor(private c: PoolClient, readonly batchId: number) {}

  static async open(c: PoolClient, datasetType: string): Promise<UndoJournal> {
    await ensureUndoSchema(c);
    const r = await c.query(`INSERT INTO etl_undo.batches (dataset_type) VALUES ($1) RETURNING id`, [datasetType]);
    return new UndoJournal(c, Number(r.rows[0].id));
  }

  /** The journal table for `table`: created on first use, and given any column the table has gained since. */
  private async prepare(table: string, key: UndoKey): Promise<{ name: string; cols: string[] }> {
    const j = journalOf(table);
    if (!this.specs.has(table)) this.specs.set(table, { table, cols: key.cols, nullable: key.nullable ?? [] });
    const known = this.ready.get(table);
    if (known) return { name: j.name, cols: known };
    // CREATE TABLE AS copies no defaults or sequences, so nothing ties a journal to its table.
    await this.c.query(
      `CREATE TABLE IF NOT EXISTS ${j.name} AS
         SELECT NULL::bigint AS undo_batch, NULL::text AS undo_kind, t.* FROM ${table} t WITH NO DATA`);
    await this.c.query(`CREATE INDEX IF NOT EXISTS ${j.index} ON ${j.name} (undo_batch, undo_kind)`);
    const live = await columnsOf(this.c, table);
    const have = new Set((await columnsOf(this.c, j.name)).map((x) => x.name));
    for (const col of live) {
      if (!have.has(col.name)) await this.c.query(`ALTER TABLE ${j.name} ADD COLUMN ${q(col.name)} ${col.type}`);
    }
    const cols = live.map((x) => x.name);
    this.ready.set(table, cols);
    return { name: j.name, cols };
  }

  /** Copy the rows of `table` that `from` selects (as alias t), as they are before the load changes them. */
  async saveOld(table: string, key: UndoKey, from: string, params: unknown[] = []): Promise<number> {
    const j = await this.prepare(table, key);
    const b = `$${params.length + 1}::bigint`;
    const r = await this.c.query(
      `INSERT INTO ${j.name} (undo_batch, undo_kind, ${j.cols.map(q).join(", ")})
       SELECT ${b}, 'old', ${j.cols.map((col) => `t.${q(col)}`).join(", ")} ${from}`,
      [...params, this.batchId],
    );
    return r.rowCount ?? 0;
  }

  /** Record the keys of the rows the load writes; `select` returns the key columns by name. */
  async saveNew(table: string, key: UndoKey, select: string, params: unknown[] = []): Promise<number> {
    const j = await this.prepare(table, key);
    const b = `$${params.length + 1}::bigint`;
    const r = await this.c.query(
      `INSERT INTO ${j.name} (undo_batch, undo_kind, ${key.cols.map(q).join(", ")})
       SELECT DISTINCT ${b}, 'new', ${key.cols.map((col) => `s.${q(col)}`).join(", ")} FROM (${select}) s`,
      [...params, this.batchId],
    );
    return r.rowCount ?? 0;
  }

  /** Write down which tables the journal covers: the load's last step before COMMIT. */
  async close(): Promise<void> {
    await this.c.query(`UPDATE etl_undo.batches SET tables = $1::jsonb WHERE id = $2`, [JSON.stringify([...this.specs.values()]), this.batchId]);
  }
}

/** Tie a committed load's journal to its row in data_uploads. */
export async function attachUndo(batchId: number, uploadId: number): Promise<void> {
  if (!db) return;
  await db.query(`UPDATE etl_undo.batches SET upload_id = $1 WHERE id = $2`, [uploadId, batchId]);
}

/** Drop the journals of all but the latest UNDO_KEEP loads still in place. */
export async function expireOldUndo(): Promise<void> {
  if (!db) return;
  const { rows } = await db.query(
    `SELECT id, tables FROM etl_undo.batches WHERE status = 'active' ORDER BY id DESC OFFSET $1`, [UNDO_KEEP]);
  for (const b of rows as { id: string; tables: TableSpec[] }[]) {
    for (const t of b.tables ?? []) {
      await db.query(`DELETE FROM ${journalOf(t.table).name} WHERE undo_batch = $1`, [b.id]).catch(() => {});
    }
    await db.query(`UPDATE etl_undo.batches SET status = 'expired' WHERE id = $1`, [b.id]);
  }
}

export interface UndoResult {
  uploadId: number;
  dryRun: boolean;
  done: boolean;
  /** Rows of the upload taken out, and rows it had replaced put back, per table. */
  tables: { table: string; removed: number; restored: number }[];
  removed: number;
  restored: number;
  error?: string;
  /** The later upload to undo first, when one blocks this. */
  blockedBy?: number | null;
}

/** For the history list (batch alias b): the first later load still in place that changed one of b's tables. */
export const LATER_OVERLAP = `
  SELECT b2.id, b2.upload_id FROM etl_undo.batches b2
   WHERE b2.id > b.id AND b2.status = 'active'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(b2.tables) x, jsonb_array_elements(b.tables) y
                  WHERE x->>'table' = y->>'table')
   ORDER BY b2.id LIMIT 1`;

/**
 * Put the warehouse back as it was before upload `uploadId`. With `dryRun` it
 * does all of it and rolls back, which is how the page shows what an undo
 * would change before anyone confirms it.
 */
export async function undoUpload(uploadId: number, opts: { dryRun?: boolean } = {}): Promise<UndoResult> {
  const out: UndoResult = { uploadId, dryRun: Boolean(opts.dryRun), done: false, tables: [], removed: 0, restored: 0 };
  if (!db) { out.error = "No database connection is configured."; return out; }
  const exists = await db.query(`SELECT to_regclass('etl_undo.batches') IS NOT NULL AS ok`);
  if (!exists.rows[0].ok) { out.error = "This upload was made before undo existed, so what it replaced was not kept."; return out; }

  const c = await db.connect();
  let refresh = false;
  try {
    await c.query("BEGIN");
    const r = await c.query(`SELECT * FROM etl_undo.batches WHERE upload_id = $1 FOR UPDATE`, [uploadId]);
    const b = r.rows[0] as { id: string; status: string; tables: TableSpec[] } | undefined;
    if (!b) {
      out.error = "This upload has no undo record: it was made before undo existed, or it wrote nothing.";
    } else if (b.status === "undone") {
      out.error = "This upload has already been undone.";
    } else if (b.status === "expired") {
      out.error = `This upload is too old to undo: only the latest ${UNDO_KEEP} loads keep what they replaced.`;
    } else {
      const later = (await c.query(
        `SELECT b2.upload_id FROM etl_undo.batches b2
          WHERE b2.id > $1 AND b2.status = 'active'
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(b2.tables) x, jsonb_array_elements($2::jsonb) y
                         WHERE x->>'table' = y->>'table')
          ORDER BY b2.id LIMIT 1`,
        [b.id, JSON.stringify(b.tables)],
      )).rows[0];
      if (later) {
        out.blockedBy = later.upload_id === null ? null : Number(later.upload_id);
        out.error = later.upload_id
          ? `Undo upload #${later.upload_id} first: it changed the same tables after this one.`
          : "A later load changed the same tables after this one; it has to be undone first.";
      }
    }
    if (out.error) {
      await c.query("ROLLBACK");
      return out;
    }

    // Reverse order: the last table the load wrote is put back first.
    for (const t of [...b!.tables].reverse()) {
      const j = journalOf(t.table).name;
      const match = t.cols
        .map((col) => (t.nullable.includes(col) ? `x.${q(col)} IS NOT DISTINCT FROM n.${q(col)}` : `x.${q(col)} = n.${q(col)}`))
        .join(" AND ");
      const del = await c.query(
        `DELETE FROM ${t.table} x
          USING (SELECT DISTINCT ${t.cols.map(q).join(", ")} FROM ${j} WHERE undo_batch = $1 AND undo_kind = 'new') n
          WHERE ${match}`,
        [b!.id],
      );
      const cols = await c.query(
        `SELECT column_name, is_generated, identity_generation FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        t.table.split("."),
      );
      const kept = new Set((await columnsOf(c, j)).map((x) => x.name));
      const live = (cols.rows as { column_name: string; is_generated: string; identity_generation: string | null }[])
        .filter((x) => kept.has(x.column_name) && x.is_generated !== "ALWAYS");
      const list = live.map((x) => q(x.column_name)).join(", ");
      const override = live.some((x) => x.identity_generation === "ALWAYS") ? "OVERRIDING SYSTEM VALUE " : "";
      const ins = await c.query(
        `INSERT INTO ${t.table} (${list}) ${override}SELECT ${list} FROM ${j} WHERE undo_batch = $1 AND undo_kind = 'old'`,
        [b!.id],
      );
      out.tables.push({ table: t.table, removed: del.rowCount ?? 0, restored: ins.rowCount ?? 0 });
      out.removed += del.rowCount ?? 0;
      out.restored += ins.rowCount ?? 0;
      if (t.table === "gold.fact_traffic_hourly") refresh = true;
    }
    out.tables.reverse();

    if (opts.dryRun) {
      await c.query("ROLLBACK");
      return out;
    }
    await c.query(`UPDATE etl_undo.batches SET status = 'undone', undone_at = now() WHERE id = $1`, [b!.id]);
    await c.query(`UPDATE data_uploads SET status = 'undone' WHERE id = $1`, [uploadId]);
    for (const t of b!.tables) await c.query(`DELETE FROM ${journalOf(t.table).name} WHERE undo_batch = $1`, [b!.id]);
    await c.query("COMMIT");
    out.done = true;
  } catch (e: any) {
    await c.query("ROLLBACK").catch(() => {});
    out.error = `Undo rolled back, nothing was changed: ${e.message}`;
    out.tables = [];
    out.removed = out.restored = 0;
    return out;
  } finally {
    c.release();
  }

  // Outside the transaction, as after a load: the Descriptive view is rebuilt from the restored record.
  if (refresh) {
    try {
      await db.query("REFRESH MATERIALIZED VIEW public.nlex_traffic_volume");
      await db.query("ANALYZE gold.fact_traffic_hourly");
      await db.query("ANALYZE gold.fact_traffic_hourly_origin");
    } catch (e: any) {
      out.error = `Undone, but the Descriptive view did not refresh (run REFRESH MATERIALIZED VIEW public.nlex_traffic_volume): ${e.message}`;
    }
  }
  return out;
}
