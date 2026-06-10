import { Router } from "express";
import { auditLogController } from "../controllers/audit-log.controller.js";

const router = Router();
router.get("/", auditLogController);

export default router;
