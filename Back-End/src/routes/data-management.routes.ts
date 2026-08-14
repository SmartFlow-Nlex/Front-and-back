import { Router } from "express";
import { dataManagementController } from "../controllers/data-management.controller.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.middleware.js";

const router = Router();

// Apply auth middleware to all data-management endpoints
router.use(authenticateToken);
router.use(authorizeRoles(["data-analyst"]));

router.get("/", dataManagementController);

export default router;
