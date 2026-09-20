/**
 * ETL Loader — Batch-inserts transformed rows into AWS PostgreSQL
 */
import { db } from "../config/db.js";
import type { TransformResult } from "./transformer.js";

export interface LoadResult {
  tableName: string;
  rowsInserted: number;
  rowsSkipped: number;
  errors: string[];
  durationMs: number;
}

const BATCH_SIZE = 1000;

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

/**
 * Build a parameterized INSERT query for a batch of rows
 */
function buildBatchInsert(
  tableName: string,
  columns: string[],
  rows: any[][],
  conflict?: LoadConflict
): { text: string; values: any[] } {
  const values: any[] = [];
  const valueClauses: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const placeholders: string[] = [];
    for (let j = 0; j < rows[i].length; j++) {
      values.push(rows[i][j]);
      placeholders.push(`$${values.length}`);
    }
    valueClauses.push(`(${placeholders.join(", ")})`);
  }

  const colList = columns.map((c) => `"${c}"`).join(", ");
  let text = `INSERT INTO ${tableName} (${colList}) VALUES ${valueClauses.join(", ")}`;

  if (conflict) {
    if (conflict.action === "nothing") {
      text += ` ON CONFLICT ("${conflict.column}") DO NOTHING`;
    } else {
      // loaded_at is set explicitly here because it only defaults on a fresh
      // INSERT — the UPDATE branch of an upsert doesn't see that default, and
      // without this the row's freshness would stop advancing on repeat loads.
      const updateCols = columns.filter((c) => c !== conflict.column);
      const setClause = updateCols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(", ");
      text += ` ON CONFLICT ("${conflict.column}") DO UPDATE SET ${setClause}, loaded_at = now()`;
    }
  }

  return { text, values };
}

/**
 * Load transformed data into the database in batches
 */
export async function loadData(transformResult: TransformResult): Promise<LoadResult> {
  const start = Date.now();
  const errors: string[] = [];
  let totalInserted = 0;

  if (!transformResult.tableName || transformResult.rows.length === 0) {
    return {
      tableName: transformResult.tableName || "unknown",
      rowsInserted: 0,
      rowsSkipped: transformResult.skipped,
      errors: transformResult.rows.length === 0 ? ["No rows to insert after transformation."] : [],
      durationMs: Date.now() - start,
    };
  }

  if (!db) {
    return {
      tableName: transformResult.tableName,
      rowsInserted: 0,
      rowsSkipped: transformResult.skipped,
      errors: ["Database connection pool is not available."],
      durationMs: Date.now() - start,
    };
  }

  const { tableName, columns, rows, conflict } = transformResult;

  // Process in batches
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    try {
      const query = buildBatchInsert(tableName, columns, batch, conflict);
      const result = await db.query(query.text, query.values);
      totalInserted += result.rowCount ?? batch.length;
    } catch (err: any) {
      errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1} error: ${err.message}`);
      // Try individual row inserts as fallback. Also covers the one case a
      // DO UPDATE conflict can't handle within a single batch statement — two
      // rows in the same batch sharing a conflict key ("ON CONFLICT DO UPDATE
      // command cannot affect row a second time") — since each row here is
      // its own statement, the second one just upserts against the first.
      for (const row of batch) {
        try {
          const singleQuery = buildBatchInsert(tableName, columns, [row], conflict);
          const sResult = await db.query(singleQuery.text, singleQuery.values);
          totalInserted += sResult.rowCount ?? 1;
        } catch (singleErr: any) {
          // Skip this row entirely
        }
      }
    }
  }

  // The dashboard reads traffic volume through the nlex_traffic_volume
  // materialized view, so a bronze insert stays invisible until it is
  // refreshed. Do this once after the batches, not per batch.
  if (totalInserted > 0 && transformResult.refreshMaterializedView) {
    try {
      await db.query(`REFRESH MATERIALIZED VIEW ${transformResult.refreshMaterializedView}`);
    } catch (err: any) {
      errors.push(
        `Rows loaded, but refreshing materialized view ` +
          `'${transformResult.refreshMaterializedView}' failed: ${err.message}. ` +
          `The new rows will not appear on the dashboard until it is refreshed.`
      );
    }
  }

  return {
    tableName,
    rowsInserted: totalInserted,
    rowsSkipped: transformResult.skipped,
    errors,
    durationMs: Date.now() - start,
  };
}
