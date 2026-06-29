import type { Request, Response } from "express";
import { ingestCsv, detectDatasetType, getDatasetTypes, type DatasetType } from "../services/csv-parser.service.js";
import { createUploadRecord, completeUploadRecord, getUploadHistory, getDatasetCounts } from "../services/upload.service.js";

// ─────────────────────────────────────────────────────────
// POST /api/upload/file  — Real CSV file upload & ingestion
// ─────────────────────────────────────────────────────────
export const handleFileUpload = async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, message: "No file uploaded. Please select a CSV file." });
    }

    // Read the CSV content from the uploaded file buffer
    const csvText = file.buffer.toString("utf-8");

    // Optional: caller can specify dataset type, otherwise auto-detect
    const datasetTypeOverride = req.body?.dataset_type as DatasetType | undefined;

    // Run ingestion
    const result = await ingestCsv(csvText, datasetTypeOverride);

    // Track the upload in the database
    const uploadRecord = await createUploadRecord(file.originalname, result.datasetType, result.totalRows);
    if (uploadRecord) {
      await completeUploadRecord(
        uploadRecord.id,
        result.processedRows,
        result.failedRows,
        result.errors.length > 0 ? result.errors.join("; ") : undefined
      );
    }

    res.json({
      success: true,
      data: {
        filename: file.originalname,
        fileSize: file.size,
        datasetType: result.datasetType,
        tableName: result.tableName,
        totalRows: result.totalRows,
        processedRows: result.processedRows,
        failedRows: result.failedRows,
        durationMs: result.durationMs,
        errors: result.errors.slice(0, 10), // Cap errors in response
        uploadId: uploadRecord?.id || null,
      },
    });
  } catch (error: any) {
    console.error("Upload error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to process uploaded file",
    });
  }
};

// ─────────────────────────────────────────────────────────
// POST /api/upload/detect  — Detect dataset type from headers only
// ─────────────────────────────────────────────────────────
export const detectType = async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const csvText = file.buffer.toString("utf-8");
    const firstLine = csvText.split(/\r?\n/)[0];
    const headers = firstLine.split(",").map((h) => h.trim());
    const detectedType = detectDatasetType(headers);

    res.json({
      success: true,
      data: {
        detectedType,
        headers: headers.slice(0, 10), // Show first 10 headers
        totalHeaders: headers.length,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────
// GET /api/upload/history  — Past upload records
// ─────────────────────────────────────────────────────────
export const getHistory = async (_req: Request, res: Response) => {
  const history = await getUploadHistory();
  res.json({ success: true, data: history });
};

// ─────────────────────────────────────────────────────────
// GET /api/upload/datasets  — Available dataset types + row counts
// ─────────────────────────────────────────────────────────
export const getDatasets = async (_req: Request, res: Response) => {
  const types = getDatasetTypes();
  const counts = await getDatasetCounts();

  const enriched = types.map((t) => ({
    ...t,
    currentRows: counts ? counts[t.type] || 0 : 0,
  }));

  res.json({ success: true, data: enriched });
};
