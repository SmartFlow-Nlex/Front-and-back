import type { Request, Response } from "express";
import { runPipeline } from "../etl/index.js";
import { uploadFormats } from "../etl/formats.js";
import { attachUndo, expireOldUndo, undoUpload } from "../etl/undo.js";
import { audit } from "../services/audit.js";
import { nextRetrain, RETRAIN_SCHEDULE } from "../services/retrain-schedule.js";
import { listRetrainRunsInDb, listUploadsInDb, saveUploadRecordInDb, triggerTrainingInDb } from "../services/upload.service.js";
import { UploadTriggerSchema } from "../validators/upload.validator.js";
import fs from "fs";

// [ETL] POST /api/upload/file[?mode=check]
// Accepts a multipart file, runs the full ETL pipeline and returns what it did.
// mode=check runs every gate AND the load, then rolls the load back: the file is
// tested against the warehouse as it stands, and nothing is written.
export const handleFileUpload = async (req: Request, res: Response) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) {
    return res.status(400).json({
      success: false,
      error: "No file provided. Upload a CSV, JSON, or Excel file.",
    });
  }
  const dryRun = String(req.query.mode ?? "") === "check";

  try {
    console.log(`[ETL] ${dryRun ? "Checking" : "Processing"} upload: ${file.originalname} (${(file.size / 1024).toFixed(1)} KB)`);

    // Run the full ETL pipeline: Parse → Classify → Clean → Transform → Load → Publish
    const result = await runPipeline(file.path, file.originalname, { dryRun });

    // A check changes nothing, so it is not recorded as an upload.
    const dbRecord = dryRun
      ? null
      : await saveUploadRecordInDb(
          file.originalname,
          result.rowsInserted + result.rowsUpdated,
          result.datasetType,
          result.success ? "processed" : "failed",
        );

    // The load's undo journal belongs to this upload; journals beyond the latest few are dropped.
    if (dbRecord && result.undoBatch) {
      try {
        await attachUndo(result.undoBatch, Number(dbRecord.id));
        await expireOldUndo();
      } catch (e: any) {
        console.error("[ETL] Could not record the upload's undo journal:", e.message);
      }
    }

    // The audit log: a check, a load or a failed upload, with what it did and how long it took.
    const flagged = result.comparison?.kind === "toll" ? result.comparison.flagged : undefined;
    audit(req, {
      action: dryRun ? "upload.checked" : result.success ? "upload.loaded" : "upload.failed",
      module: "data_management",
      entityType: "upload",
      entityId: dbRecord?.id ?? null,
      target: dbRecord ? `upload:${dbRecord.id}` : `file:${file.originalname}`,
      toStatus: dryRun ? null : result.success ? "processed" : "failed",
      outcome: result.success ? (dryRun ? "passed" : "success") : "failed",
      durationMs: result.durationMs,
      details: {
        filename: file.originalname,
        layout: result.datasetType,
        rows_in_file: result.totalRowsParsed,
        rows_written: result.rowsInserted,
        rows_updated: result.rowsUpdated,
        rows_set_aside: result.rowsRejected,
        rows_refused: result.rowsFailed,
        ...(flagged !== undefined ? { plaza_days_flagged: flagged } : {}),
        ...(result.success ? {} : { reason: (result.parseErrors[0] ?? result.loadErrors[0] ?? result.classification.reason ?? "").slice(0, 300) }),
      },
    });

    console.log(
      `[ETL] ${dryRun ? "Check" : "Load"} complete: ${result.rowsInserted} new, ${result.rowsUpdated} updated, ` +
        `${result.rowsAlreadyLoaded} already loaded, ${result.rowsRejected} rejected, ${result.rowsFailed} refused (${result.durationMs}ms)`,
    );

    return res.json({
      success: result.success,
      source: "etl_pipeline",
      data: {
        upload_id: dbRecord?.id ?? null,
        dry_run: result.dryRun,
        filename: result.filename,
        file_format: result.fileFormat,
        source_type: result.source,
        dataset_type: result.datasetType,
        classification: result.classification,
        destination: result.destination,
        published: result.published,
        comparison: result.comparison,
        can_undo: Boolean(dbRecord && result.undoBatch),
        stats: {
          total_rows_parsed: result.totalRowsParsed,
          rows_accepted: result.rowsAccepted,
          rows_rejected: result.rowsRejected,
          rows_inserted: result.rowsInserted,
          rows_updated: result.rowsUpdated,
          rows_already_loaded: result.rowsAlreadyLoaded,
          rows_failed: result.rowsFailed,
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
  } finally {
    // The temp file goes whatever happened, not only on success.
    try {
      fs.unlinkSync(file.path);
    } catch (_) {}
  }
};

// GET /api/upload/history?limit= — the latest uploads, newest first
export const getUploadHistory = async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 15));
  const rows = await listUploadsInDb(limit);
  if (!rows) return res.status(503).json({ success: false, error: "Upload history unavailable: database not reachable." });
  return res.json({ success: true, source: "database", data: rows });
};

// GET /api/upload/retraining — the weekly retrain schedule and its latest batches
export const getRetraining = async (req: Request, res: Response) => {
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 6));
  const runs = await listRetrainRunsInDb(limit);
  if (!runs) return res.status(503).json({ success: false, error: "Retraining history unavailable: database not reachable." });
  return res.json({ success: true, data: { schedule: { ...RETRAIN_SCHEDULE, next: nextRetrain() }, runs } });
};

// POST /api/upload/:id/undo[?mode=check] — put the warehouse back as it was before upload :id.
// mode=check does the whole undo and rolls it back: what it would remove and restore, changing nothing.
export const undoUploadHandler = async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, error: "Not an upload number." });
  const dryRun = String(req.query.mode ?? "") === "check";
  const t0 = Date.now();
  const result = await undoUpload(id, { dryRun });
  // A done undo, and an undo that was asked for and refused (the preview is not an action).
  if (!dryRun) {
    audit(req, {
      action: result.done ? "upload.undone" : "upload.undo_refused",
      module: "data_management",
      entityType: "upload",
      entityId: id,
      fromStatus: result.done ? "processed" : null,
      toStatus: result.done ? "undone" : null,
      outcome: result.done ? "success" : "refused",
      durationMs: Date.now() - t0,
      details: result.done
        ? { removed: result.removed, restored: result.restored, tables: result.tables }
        : { reason: result.error ?? "", ...(result.blockedBy ? { blocked_by: result.blockedBy } : {}) },
    });
  }
  const ok = dryRun ? !result.error : result.done;
  return res.status(ok ? 200 : 409).json({ success: ok, data: result, error: result.error });
};

// GET /api/upload/formats — what the pipeline accepts, where each lands, what a re-upload does
export const getUploadFormats = async (_req: Request, res: Response) => {
  return res.json({ success: true, source: "etl_pipeline", data: uploadFormats() });
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
