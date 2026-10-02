import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { exportAuditLogs, getAuditSummary, listAuditLogs, recordActivity, writeAuditEvent } from "../controllers/audit-log.controller.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.middleware.js";

const router = Router();

// Reads are public like the other dashboard data endpoints
router.get("/list", asyncHandler(listAuditLogs));
router.get("/summary", asyncHandler(getAuditSummary));

// What a page reports about itself (viewed, signed in, signed out, exported): any user, signed in or not.
// Only those four kinds are accepted; the user is the one the token names, if any.
router.post("/activity", asyncHandler(recordActivity));

// Apply auth middleware to the remaining audit-log endpoints
router.use(authenticateToken);
router.use(authorizeRoles(["data-analyst"]));

router.post("/event", asyncHandler(writeAuditEvent));
router.get("/export", asyncHandler(exportAuditLogs));

export default router;
