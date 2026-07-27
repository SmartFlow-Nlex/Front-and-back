import { db } from "../config/db.js";

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

// [DEV-02] Trigger Model Training
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
