import { db } from "../config/db.js";
import type { DatasetType } from "./csv-parser.service.js";

// ─────────────────────────────────────────────────────────
// Save upload record when ingestion starts
// ─────────────────────────────────────────────────────────
export async function createUploadRecord(filename: string, datasetType: DatasetType, totalRows: number) {
  if (!db) return null;
  try {
    const { rows } = await db.query(
      `INSERT INTO data_uploads (filename, dataset_type, status, total_rows)
       VALUES ($1, $2, 'processing', $3)
       RETURNING *`,
      [filename, datasetType, totalRows]
    );
    return rows[0];
  } catch (error) {
    console.error("DB error creating upload record:", error);
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// Update upload record when ingestion completes
// ─────────────────────────────────────────────────────────
export async function completeUploadRecord(
  id: number,
  processedRows: number,
  failedRows: number,
  errorMessage?: string
) {
  if (!db) return null;
  try {
    const status = failedRows > 0 && processedRows === 0 ? "failed" : failedRows > 0 ? "partial" : "completed";
    const { rows } = await db.query(
      `UPDATE data_uploads
       SET status = $1, processed_rows = $2, failed_rows = $3,
           error_message = $4, completed_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [status, processedRows, failedRows, errorMessage || null, id]
    );
    return rows[0];
  } catch (error) {
    console.error("DB error completing upload record:", error);
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// Get upload history
// ─────────────────────────────────────────────────────────
export async function getUploadHistory(limit = 50) {
  if (!db) return [];
  try {
    const { rows } = await db.query(
      `SELECT * FROM data_uploads ORDER BY uploaded_at DESC LIMIT $1`,
      [limit]
    );
    return rows;
  } catch (error) {
    console.error("DB error fetching upload history:", error);
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// Get row counts for each dataset table
// ─────────────────────────────────────────────────────────
export async function getDatasetCounts() {
  if (!db) return null;
  try {
    const tables = [
      { type: "traffic_volume", table: "nlex_traffic_volumes" },
      { type: "road_crash", table: "nlex_road_crashes" },
      { type: "motorcycle_crash", table: "nlex_motorcycle_crashes" },
      { type: "stalled_vehicle", table: "nlex_stalled_vehicles" },
      { type: "apprehension", table: "nlex_apprehensions" },
    ];

    const counts: Record<string, number> = {};
    for (const t of tables) {
      const { rows } = await db.query(`SELECT COUNT(*)::int as count FROM ${t.table}`);
      counts[t.type] = rows[0].count;
    }
    return counts;
  } catch (error) {
    console.error("DB error fetching dataset counts:", error);
    return null;
  }
}
