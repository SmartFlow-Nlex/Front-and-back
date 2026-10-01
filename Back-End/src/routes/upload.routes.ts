import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { handleFileUpload, triggerTraining } from "../controllers/upload.controller.js";
import { uploadMiddleware } from "../middleware/upload.middleware.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.middleware.js";

const router = Router();

/*
 * Both endpoints below were unauthenticated.
 *
 * The Data Management page that calls them is already restricted to the
 * data-analyst role in the interface, which made them look protected without
 * being so: the route sits behind a hidden sidebar link, not behind a check.
 * Anyone able to reach the API could post a file into the ETL pipeline or start
 * a model training run without presenting a credential, and neither action is
 * reversible from the dashboard.
 *
 * Mounted ahead of the route definitions so that an endpoint added later is
 * protected by default rather than by whoever remembers to add it.
 */
router.use(authenticateToken);
router.use(authorizeRoles(["data-analyst"]));

// POST /api/upload/file — Accepts multipart file upload and runs ETL pipeline
router.post("/file", uploadMiddleware.single("file"), asyncHandler(handleFileUpload));

// POST /api/upload/trigger-training — Triggers ML model training for a processed upload
router.post("/trigger-training", asyncHandler(triggerTraining));

export default router;
