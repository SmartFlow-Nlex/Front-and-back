import { Router } from "express";
import { writeAuditEvent, listAuditLogs, exportAuditLogs, getAuditStats } from "../controllers/audit-log.controller.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.middleware.js";

const router = Router();

// Public read endpoints (same as other dashboard data endpoints)
router.get("/list", listAuditLogs);
router.get("/stats", getAuditStats);

// Apply auth middleware to write / export endpoints
router.use(authenticateToken);
router.use(authorizeRoles(["data-analyst"]));

router.post("/event", writeAuditEvent);
router.get("/export", exportAuditLogs);

export default router;
