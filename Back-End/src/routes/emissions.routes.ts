import { Router } from "express";
import { getEmissionsIndex, getPeakPenalty, getClimateResilience } from "../controllers/emissions.controller.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.middleware.js";

const router = Router();

// Apply auth middleware to all emissions endpoints
router.use(authenticateToken);
router.use(authorizeRoles(["data-analyst"]));

router.get("/index", getEmissionsIndex);
router.get("/peak-penalty", getPeakPenalty);
router.get("/resilience", getClimateResilience);

export default router;
