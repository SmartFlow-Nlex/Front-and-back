import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { writeAuditEvent, listAuditLogs, exportAuditLogs } from "../controllers/audit-log.controller.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.middleware.js";

const router = Router();

// Read endpoint is public like the other dashboard data endpoints
router.get("/list", asyncHandler(listAuditLogs));

// Apply auth middleware to the remaining audit-log endpoints
router.use(authenticateToken);
router.use(authorizeRoles(["data-analyst"]));

router.post("/event", asyncHandler(writeAuditEvent));
router.get("/export", asyncHandler(exportAuditLogs));

export default router;
