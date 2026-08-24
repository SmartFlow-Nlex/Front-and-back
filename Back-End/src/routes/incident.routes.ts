import { Router } from "express";
import { getIncidentList, getIncidentMetrics, getWeatherCorrelation, getIncidentAnalytics, getIncidentPredictive } from "../controllers/incident.controller.js";
import { asyncHandler } from "../middleware/error.middleware.js";

const router = Router();

// Every handler here is async and validates its query with zod. Without
// asyncHandler a rejected promise — a ZodError from one bad query param, say
// ?months=99 — escapes the router and takes the whole process down instead of
// returning 400. The traffic routes already wrap for this reason.
router.get("/analytics", asyncHandler(getIncidentAnalytics));
router.get("/predictive", asyncHandler(getIncidentPredictive));
router.get("/list", asyncHandler(getIncidentList));
router.get("/metrics", asyncHandler(getIncidentMetrics));
router.get("/weather-correlation", asyncHandler(getWeatherCorrelation));

export default router;
