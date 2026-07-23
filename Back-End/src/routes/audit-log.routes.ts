import { Router } from "express";
import { writeAuditEvent, listAuditLogs, exportAuditLogs } from "../controllers/audit-log.controller.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.middleware.js";

const router = Router();

// Apply auth middleware to all audit-log endpoints
router.use(authenticateToken);
router.use(authorizeRoles(["data-analyst"]));

router.post("/event", writeAuditEvent);
router.get("/list", listAuditLogs);
router.get("/export", exportAuditLogs);

export default router;
