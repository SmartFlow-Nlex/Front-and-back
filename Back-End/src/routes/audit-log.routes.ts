import { Router } from "express";
import { writeAuditEvent, listAuditLogs, exportAuditLogs, getAuditAnalytics } from "../controllers/audit-log.controller.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.middleware.js";

const router = Router();

// Read endpoints are public like the other dashboard data endpoints. Analytics
// sits here rather than behind the auth block because it is derived entirely
// from rows /list already exposes — gating it would add no protection while
// breaking the dashboard panel.
router.get("/list", listAuditLogs);
router.get("/analytics", getAuditAnalytics);

// Apply auth middleware to the remaining audit-log endpoints
router.use(authenticateToken);
router.use(authorizeRoles(["data-analyst"]));

router.post("/event", writeAuditEvent);
router.get("/export", exportAuditLogs);

export default router;
