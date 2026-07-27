import type { Request, Response } from "express";
import { runPipeline } from "../etl/index.js";
import { saveUploadRecordInDb, triggerTrainingInDb } from "../services/upload.service.js";
import { UploadTriggerSchema } from "../validators/upload.validator.js";
import fs from "fs";

// [ETL] POST /api/v1/upload/file
// Accepts multipart file upload, runs the full ETL pipeline, and returns processing stats
export const handleFileUpload = async (req: Request, res: Response) => {
  try {
    const file = (req as any).file as Express.Multer.File | undefined;

    if (!file) {
      return res.status(400).json({
        success: false,
        error: "No file provided. Upload a CSV, JSON, or Excel file.",
      });
    }

    console.log(`[ETL] Processing upload: ${file.originalname} (${(file.size / 1024).toFixed(1)} KB)`);

    // Run the full ETL pipeline: Parse → Classify → Clean → Transform → Load
    const result = await runPipeline(file.path, file.originalname);

    // Clean up temp file
    try {
      fs.unlinkSync(file.path);
    } catch (_) {}

    // Save upload record to the data_uploads tracking table
    const dbRecord = await saveUploadRecordInDb(
      file.originalname,
      result.rowsInserted,
      result.datasetType,
      result.success ? "processed" : "failed"
    );

    console.log(
      `[ETL] Complete: ${result.rowsInserted} inserted, ${result.rowsRejected} rejected, ${result.rowsSkippedTransform} skipped (${result.durationMs}ms)`
    );

    return res.json({
      success: result.success,
      source: "etl_pipeline",
      data: {
        upload_id: dbRecord?.id ?? null,
        filename: result.filename,
        file_format: result.fileFormat,
        source_type: result.source,
        dataset_type: result.datasetType,
        classification: result.classification,
        stats: {
          total_rows_parsed: result.totalRowsParsed,
          rows_accepted: result.rowsAccepted,
          rows_rejected: result.rowsRejected,
          rows_inserted: result.rowsInserted,
          rows_skipped_transform: result.rowsSkippedTransform,
        },
        pipeline_gates: result.pipelineGates,
        rejected_sample: result.rejectedSample,
        errors: [...result.parseErrors, ...result.loadErrors],
        warnings: result.warnings,
        duration_ms: result.durationMs,
      },
    });
  } catch (err: any) {
    console.error("[ETL] Pipeline error:", err);
    return res.status(500).json({
      success: false,
      error: `ETL pipeline failed: ${err.message}`,
    });
  }
};

// [DEV-02] POST /api/v1/upload/trigger-training
export const triggerTraining = async (req: Request, res: Response) => {
  const parsed = UploadTriggerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid parameters" });

  const dbRow = await triggerTrainingInDb(parsed.data.upload_id, parsed.data.model_target);
  if (dbRow) {
    return res.json({ success: true, source: "database", data: dbRow });
  }

  res.json({ success: true, source: "mock", data: { upload_id: parsed.data.upload_id, status: `training_${parsed.data.model_target}` } });
};
