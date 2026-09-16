import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { getEmissionsIndex, getPeakPenalty, getClimateResilience, getEmissionsAnalytics, getEmissionsForecast } from "../controllers/emissions.controller.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.middleware.js";

const router = Router();

// Public like the traffic/incident analytics endpoints (before auth middleware)
router.get("/analytics", asyncHandler(getEmissionsAnalytics));
router.get("/forecast", asyncHandler(getEmissionsForecast));

// Apply auth middleware to all remaining emissions endpoints
router.use(authenticateToken);
router.use(authorizeRoles(["data-analyst"]));

router.get("/index", asyncHandler(getEmissionsIndex));
router.get("/peak-penalty", asyncHandler(getPeakPenalty));
router.get("/resilience", asyncHandler(getClimateResilience));

export default router;
