import { Router } from "express";
import { writeAuditEvent, listAuditLogs, exportAuditLogs } from "../controllers/audit-log.controller.js";

const router = Router();

router.post("/event", writeAuditEvent);
router.get("/list", listAuditLogs);
router.get("/export", exportAuditLogs);

export default router;
