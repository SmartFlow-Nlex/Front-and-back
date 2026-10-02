/**
 * ETL Loader — writes a transformed upload into the warehouse, in one transaction.
 *
 *   1. Stage every row in a temporary table typed like the target, a batch
 *      at a time. A batch the database refuses is retried row by row, and
 *      each refused row is COUNTED and its reason kept: earlier versions
 *      skipped them silently and reported a perfect load.
 *   2. Write staged rows to the target once, one of three ways:
 *        conflict    upsert on a unique column (accident and breakdown events:
 *                    operational logs corrected after first capture, so a
 *                    later load replaces the earlier row);
 *        keyColumns  insert only rows whose natural key is not already there,
 *                    so uploading a file twice does not double what it holds;
 *        neither     plain insert.
 *   3. Publish the written rows into the silver tables the dashboards read
 *      (publish.ts).
 *   4. COMMIT, or ROLLBACK for a check-only run: every step above runs for
 *      real, so a check finds what a load would hit, and writes nothing.
 * All or nothing: no half-written upload.
 */
import type { PoolClient } from "pg";
import { db } from "../config/db.js";
import type { DatasetType } from "./classifier.js";
import { compareRecords, type UploadComparison } from "./compare.js";
import { publish, type Published } from "./publish.js";
import { UndoJournal } from "./undo.js";
import type { TransformResult } from "./transformer.js";

export interface LoadResult {
  tableName: string;
  /** Rows newly written to the target table. */
  rowsInserted: number;
  /** Rows that replaced an existing row with the same key (upserts). */
  rowsUpdated: number;
  /** Rows whose key the warehouse already held, or that repeated an earlier row of the same file: not written again. */
  rowsAlreadyLoaded: number;
  /** Rows the database refused (a value it cannot store), with the first few reasons. */
  rowsFailed: number;
  failures: string[];
  rowsSkipped: number;
  published: Published[];
  /** For an upsert: how many records the file holds that are already loaded, and how many it changes. */
  comparison: UploadComparison | null;
  /** The committed load's undo journal (undo.ts). */
  undoBatch: number | null;
  committed: boolean;
  dryRun: boolean;
  errors: string[];
  durationMs: number;
}

/**
 * Natural-key upsert config for tables where a re-run of the same source file
 * should replace the existing row rather than pile up beside it. "update" is
 * chosen over "nothing" for accident_data/breakdown_data specifically: these
 * are operational logs that get corrected after first capture (a status
 * moving from AVAILABLE to FINALIZED, a clearance timestamp filled in later,
 * a deployment record added retroactively) — DO NOTHING would permanently
 * lock in whatever was captured on the first load and silently drop any
 * later correction.
 */
export type LoadConflict = { column: string; action: "update" | "nothing" };

const BATCH_SIZE = 5_000;
const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** Every value goes up as text and is cast to the column's own type in SQL. */
function asText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

async function columnTypes(c: PoolClient, table: string, columns: string[]): Promise<string[]> {
  const r = await c.query(
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS t
       FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
    [table],
  );
  const byName = new Map(r.rows.map((x: { attname: string; t: string }) => [x.attname, x.t]));
  return columns.map((col) => {
    const t = byName.get(col);
    if (!t) throw new Error(`Column '${col}' does not exist in ${table}.`);
    return t;
  });
}

export async function loadData(t: TransformResult, opts: { dryRun?: boolean; datasetType: DatasetType }): Promise<LoadResult> {
  const start = Date.now();
  const out: LoadResult = {
    tableName: t.tableName || "unknown", rowsInserted: 0, rowsUpdated: 0, rowsAlreadyLoaded: 0,
    rowsFailed: 0, failures: [], rowsSkipped: t.skipped, published: [], comparison: null, undoBatch: null, committed: false,
    dryRun: Boolean(opts.dryRun), errors: [], durationMs: 0,
  };
  const done = () => { out.durationMs = Date.now() - start; return out; };

  if (!t.tableName || t.rows.length === 0) {
    out.errors.push("No rows to write after transformation.");
    return done();
  }
  if (!db) {
    out.errors.push("Database connection pool is not available.");
    return done();
  }

  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const types = await columnTypes(c, t.tableName, t.columns);
    const cols = t.columns.map(q).join(", ");

    // 1. Stage.
    await c.query(`CREATE TEMP TABLE etl_upload ON COMMIT DROP AS SELECT ${cols} FROM ${t.tableName} WITH NO DATA`);
    await c.query(`ALTER TABLE etl_upload ADD COLUMN __n bigint`);
    await c.query(`CREATE TEMP TABLE etl_written (id bigint, inserted boolean) ON COMMIT DROP`);
    const stage = `
      INSERT INTO etl_upload (${cols}, __n)
      SELECT ${t.columns.map((col, i) => `u.${q(col)}::${types[i]}`).join(", ")}, u.__n
        FROM unnest(${t.columns.map((_, i) => `$${i + 1}::text[]`).join(", ")}, $${t.columns.length + 1}::bigint[])
          AS u(${cols}, __n)`;
    const params = (rows: { row: unknown[]; n: number }[]) => [
      ...t.columns.map((_, j) => rows.map((r) => asText(r.row[j]))),
      rows.map((r) => r.n),
    ];
    for (let i = 0; i < t.rows.length; i += BATCH_SIZE) {
      const batch = t.rows.slice(i, i + BATCH_SIZE).map((row, k) => ({ row, n: i + k }));
      await c.query("SAVEPOINT batch");
      try {
        await c.query(stage, params(batch));
        await c.query("RELEASE SAVEPOINT batch");
      } catch {
        await c.query("ROLLBACK TO SAVEPOINT batch");
        for (const one of batch) {
          await c.query("SAVEPOINT one");
          try {
            await c.query(stage, params([one]));
            await c.query("RELEASE SAVEPOINT one");
          } catch (e: any) {
            await c.query("ROLLBACK TO SAVEPOINT one");
            out.rowsFailed++;
            if (out.failures.length < 5) out.failures.push(`Row ${one.n + 1}: ${e.message}`);
          }
        }
      }
    }

    // 2. Write, journaling for undo (undo.ts): rows an upsert replaces are copied
    //    first, and the id of every row written is recorded after.
    const staged = Number((await c.query(`SELECT COUNT(*) AS n FROM etl_upload`)).rows[0].n);
    const journal = await UndoJournal.open(c, opts.datasetType);
    const ID = { cols: ["id"] };
    if (t.conflict) {
      const key = q(t.conflict.column);
      out.comparison = await compareRecords(c, t.tableName, t.conflict.column, t.columns);
      await journal.saveOld(t.tableName, ID, `FROM ${t.tableName} t WHERE t.${key} IN (SELECT ${key} FROM etl_upload)`);
      const action = t.conflict.action === "nothing"
        ? "DO NOTHING"
        : `DO UPDATE SET ${t.columns.filter((col) => col !== t.conflict!.column).map((col) => `${q(col)} = EXCLUDED.${q(col)}`).join(", ")}, loaded_at = now()`;
      // The last occurrence of a key in the file wins: a later line is the correction.
      await c.query(`
        WITH up AS (
          INSERT INTO ${t.tableName} (${cols})
          SELECT ${cols} FROM (SELECT DISTINCT ON (${key}) * FROM etl_upload ORDER BY ${key}, __n DESC) u
          ON CONFLICT (${key}) ${action}
          RETURNING id, (xmax = 0) AS inserted)
        INSERT INTO etl_written (id, inserted) SELECT id, inserted FROM up`);
    } else if (t.keyColumns?.length) {
      const keys = t.keyColumns.map(q);
      const same = t.keyColumns.map((k) => `COALESCE(t.${q(k)}::text, '') = COALESCE(u.${q(k)}::text, '')`).join(" AND ");
      await c.query(`
        WITH ins AS (
          INSERT INTO ${t.tableName} (${cols})
          SELECT ${t.columns.map((col) => `u.${q(col)}`).join(", ")}
            FROM (SELECT DISTINCT ON (${keys.join(", ")}) * FROM etl_upload ORDER BY ${keys.join(", ")}, __n) u
           WHERE NOT EXISTS (SELECT 1 FROM ${t.tableName} t WHERE ${same})
          RETURNING id)
        INSERT INTO etl_written (id, inserted) SELECT id, true FROM ins`);
    } else {
      await c.query(`
        WITH ins AS (INSERT INTO ${t.tableName} (${cols}) SELECT ${cols} FROM etl_upload ORDER BY __n RETURNING id)
        INSERT INTO etl_written (id, inserted) SELECT id, true FROM ins`);
    }
    await journal.saveNew(t.tableName, ID, `SELECT id FROM etl_written`);
    const w = (await c.query(`SELECT COUNT(*) FILTER (WHERE inserted) AS ins, COUNT(*) FILTER (WHERE NOT inserted) AS upd FROM etl_written`)).rows[0];
    out.rowsInserted = Number(w.ins);
    out.rowsUpdated = Number(w.upd);
    out.rowsAlreadyLoaded = Math.max(0, staged - out.rowsInserted - out.rowsUpdated);

    // 3. Publish to silver.
    out.published = await publish(c, t.tableName, opts.datasetType, journal);
    await journal.close();

    // 4. Keep it, or not.
    if (opts.dryRun) {
      await c.query("ROLLBACK");
    } else {
      await c.query("COMMIT");
      out.committed = true;
      out.undoBatch = journal.batchId;
    }
  } catch (e: any) {
    await c.query("ROLLBACK").catch(() => {});
    out.errors.push(`Load rolled back, nothing was written: ${e.message}`);
    out.rowsInserted = out.rowsUpdated = out.rowsAlreadyLoaded = 0;
    out.published = [];
  } finally {
    c.release();
  }
  return done();
}
