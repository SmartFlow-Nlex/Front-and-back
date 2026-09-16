import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { handleFileUpload, triggerTraining } from "../controllers/upload.controller.js";
import { uploadMiddleware } from "../middleware/upload.middleware.js";

const router = Router();

// POST /api/upload/file — Accepts multipart file upload and runs ETL pipeline
router.post("/file", uploadMiddleware.single("file"), asyncHandler(handleFileUpload));

// POST /api/upload/trigger-training — Triggers ML model training for a processed upload
router.post("/trigger-training", asyncHandler(triggerTraining));

export default router;
