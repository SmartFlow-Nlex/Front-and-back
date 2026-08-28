import { Router } from "express";
import { getIncidentList, getIncidentMetrics, getWeatherCorrelation, getIncidentAnalytics, getIncidentPredictive, getIncidentHourly, getIncidentWeatherEvidence, getIncidentVolumeEvidence } from "../controllers/incident.controller.js";
import { asyncHandler } from "../middleware/error.middleware.js";

const router = Router();

// Every handler here is async and validates its query with zod. Without
// asyncHandler a rejected promise — a ZodError from one bad query param, say
// ?months=99 — escapes the router and takes the whole process down instead of
// returning 400. The traffic routes already wrap for this reason.
router.get("/analytics", asyncHandler(getIncidentAnalytics));
router.get("/predictive", asyncHandler(getIncidentPredictive));
router.get("/hourly", asyncHandler(getIncidentHourly));
router.get("/list", asyncHandler(getIncidentList));
router.get("/metrics", asyncHandler(getIncidentMetrics));
router.get("/weather-correlation", asyncHandler(getWeatherCorrelation));
// "Does weather/volume predict incidents?" evidence panels — mirrors
// traffic's own GET /api/traffic/weather-evidence.
router.get("/weather-evidence", asyncHandler(getIncidentWeatherEvidence));
router.get("/volume-evidence", asyncHandler(getIncidentVolumeEvidence));

export default router;
