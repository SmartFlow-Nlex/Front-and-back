import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { getEmissionsIndex, getPeakPenalty, getClimateResilience, getEmissionsAnalytics, getEmissionsForecast, getEmissionsPrescriptive } from "../controllers/emissions.controller.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.middleware.js";

const router = Router();

// Public like the traffic/incident analytics endpoints (before auth middleware)
router.get("/analytics", asyncHandler(getEmissionsAnalytics));
router.get("/forecast", asyncHandler(getEmissionsForecast));
// Public for the same reason as the two above: it is the prescriptive third
// of one panel, and exposes nothing the descriptive third does not already.
router.get("/prescriptive", asyncHandler(getEmissionsPrescriptive));

// Apply auth middleware to all remaining emissions endpoints
router.use(authenticateToken);
router.use(authorizeRoles(["data-analyst"]));

router.get("/index", asyncHandler(getEmissionsIndex));
router.get("/peak-penalty", asyncHandler(getPeakPenalty));
router.get("/resilience", asyncHandler(getClimateResilience));

export default router;
