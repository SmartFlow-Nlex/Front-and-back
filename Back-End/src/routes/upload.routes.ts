import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { getRetraining, getUploadFormats, getUploadHistory, handleFileUpload, triggerTraining, undoUploadHandler } from "../controllers/upload.controller.js";
import { uploadMiddleware } from "../middleware/upload.middleware.js";

const router = Router();

// POST /api/upload/file[?mode=check] — Accepts multipart file upload and runs the ETL pipeline
// (mode=check: every step, then rolled back)
router.post("/file", uploadMiddleware.single("file"), asyncHandler(handleFileUpload));

// GET /api/upload/history — The latest uploads, newest first
router.get("/history", asyncHandler(getUploadHistory));

// GET /api/upload/formats — The file layouts the pipeline accepts and where each lands
router.get("/formats", asyncHandler(getUploadFormats));

// POST /api/upload/:id/undo[?mode=check] — Undo a load: remove what it wrote, put back what it replaced
router.post("/:id/undo", asyncHandler(undoUploadHandler));

// GET /api/upload/retraining — The weekly retrain schedule (every Sunday 22:00) and its latest batches
router.get("/retraining", asyncHandler(getRetraining));

// POST /api/upload/trigger-training — Relabels an upload's status only; models retrain in the weekly batch
router.post("/trigger-training", asyncHandler(triggerTraining));

export default router;
