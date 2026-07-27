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
 * Build a parameterized INSERT query for a batch of rows
 */
function buildBatchInsert(tableName: string, columns: string[], rows: any[][]): { text: string; values: any[] } {
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
  const text = `INSERT INTO ${tableName} (${colList}) VALUES ${valueClauses.join(", ")}`;

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

  const { tableName, columns, rows } = transformResult;

  // Process in batches
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    try {
      const query = buildBatchInsert(tableName, columns, batch);
      const result = await db.query(query.text, query.values);
      totalInserted += result.rowCount ?? batch.length;
    } catch (err: any) {
      errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1} error: ${err.message}`);
      // Try individual row inserts as fallback
      for (const row of batch) {
        try {
          const singleQuery = buildBatchInsert(tableName, columns, [row]);
          const sResult = await db.query(singleQuery.text, singleQuery.values);
          totalInserted += sResult.rowCount ?? 1;
        } catch (singleErr: any) {
          // Skip this row entirely
        }
      }
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
