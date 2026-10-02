import { db } from "../config/db.js";
import { LATER_OVERLAP } from "../etl/undo.js";

// [ETL] Save Upload Record with detailed processing stats
export async function saveUploadRecordInDb(
  filename: string,
  records: number,
  datasetType?: string,
  status?: string
) {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      INSERT INTO data_uploads (filename, processed_records, dataset_type, status) 
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [filename, records, datasetType ?? "unknown", status ?? "processed"]);
    return rows[0];
  } catch (error: any) {
    // If dataset_type column doesn't exist yet, fall back to original schema
    if (error.code === "42703") {
      try {
        const { rows } = await db.query(`
          INSERT INTO data_uploads (filename, processed_records, status) 
          VALUES ($1, $2, $3)
          RETURNING *
        `, [filename, records, status ?? "processed"]);
        return rows[0];
      } catch (fallbackErr) {
        console.error("Database query failed for file upload save (fallback):", fallbackErr);
        return null;
      }
    }
    console.error("Database query failed for file upload save:", error);
    return null;
  }
}

/**
 * The latest uploads, newest first, for the Data Management page's history,
 * each with whether it can be undone (etl/undo.ts):
 *   available  its undo journal is kept and nothing later is in the way
 *   blocked    a later load still in place changed the same tables (undo_blocked_by: that upload)
 *   undone     already undone
 *   expired    too old: its journal was dropped
 *   null       made before undo existed, or it wrote nothing
 */
export async function listUploadsInDb(limit: number) {
  if (!db) return null;
  try {
    const { rows: [u] } = await db.query(`SELECT to_regclass('etl_undo.batches') IS NOT NULL AS ok`);
    const { rows } = u?.ok
      ? await db.query(
          `SELECT u.id, u.filename, u.dataset_type, u.status, u.processed_records, u.uploaded_at,
                  CASE WHEN b.id IS NULL THEN NULL
                       WHEN b.status <> 'active' THEN b.status
                       WHEN blk.id IS NOT NULL THEN 'blocked'
                       ELSE 'available' END AS undo,
                  blk.upload_id AS undo_blocked_by
             FROM data_uploads u
             LEFT JOIN etl_undo.batches b ON b.upload_id = u.id
             LEFT JOIN LATERAL (${LATER_OVERLAP}) blk ON b.id IS NOT NULL
            ORDER BY u.id DESC LIMIT $1`,
          [limit],
        )
      : await db.query(
          `SELECT id, filename, dataset_type, status, processed_records, uploaded_at, NULL AS undo, NULL AS undo_blocked_by
             FROM data_uploads ORDER BY id DESC LIMIT $1`,
          [limit],
        );
    return rows;
  } catch (error) {
    console.error("Database query failed for upload history:", error);
    return null;
  }
}

/**
 * The weekly retrain batches, newest first (gold.ml_batch_runs, written by
 * smartflow_scripts/3_training_testing/weekly_retrain/weekly_retrain.py). The
 * table appears with the first batch, so before then this is an empty list.
 */
export async function listRetrainRunsInDb(limit: number) {
  if (!db) return null;
  try {
    const { rows: [t] } = await db.query(`SELECT to_regclass('gold.ml_batch_runs') IS NOT NULL AS ok`);
    if (!t?.ok) return [];
    const { rows } = await db.query(
      `SELECT id, started_at, finished_at, trigger, status, summary, groups
         FROM gold.ml_batch_runs ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    return rows;
  } catch (error) {
    console.error("Database query failed for retrain runs:", error);
    return null;
  }
}

// [DEV-02] Trigger Model Training
// Not called by the dashboard: models are not retrained per upload but in the
// weekly batch (see listRetrainRunsInDb). This only relabels an upload's status.
export async function triggerTrainingInDb(uploadId: number, modelTarget: string) {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      UPDATE data_uploads SET status = $1 WHERE id = $2 RETURNING *
    `, [`training_${modelTarget}`, uploadId]);
    return rows[0];
  } catch (error) {
    console.error("Database query failed for trigger training:", error);
    return null;
  }
}
