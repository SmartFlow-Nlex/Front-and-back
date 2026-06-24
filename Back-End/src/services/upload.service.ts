import { db } from "../config/db.js";

// [DEV-01 & DEV-03] Save Upload Record
export async function saveUploadRecordInDb(filename: string, records: number) {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      INSERT INTO data_uploads (filename, processed_records, status) 
      VALUES ($1, $2, 'processed')
      RETURNING *
    `, [filename, records]);
    return rows[0];
  } catch (error) {
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
