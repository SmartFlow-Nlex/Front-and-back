import { Router } from "express";
import { getEmissionsIndex, getPeakPenalty, getClimateResilience, getEmissionsAnalytics } from "../controllers/emissions.controller.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.middleware.js";

const router = Router();

// Public like the traffic/incident analytics endpoints (before auth middleware)
router.get("/analytics", getEmissionsAnalytics);

// Apply auth middleware to all remaining emissions endpoints
router.use(authenticateToken);
router.use(authorizeRoles(["data-analyst"]));

router.get("/index", getEmissionsIndex);
router.get("/peak-penalty", getPeakPenalty);
router.get("/resilience", getClimateResilience);

export default router;
