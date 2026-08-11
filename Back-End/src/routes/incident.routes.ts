import { Router } from "express";
import { getIncidentList, getIncidentMetrics, getWeatherCorrelation, getIncidentAnalytics, getIncidentPredictive } from "../controllers/incident.controller.js";

const router = Router();

router.get("/analytics", getIncidentAnalytics);
router.get("/predictive", getIncidentPredictive);
router.get("/list", getIncidentList);
router.get("/metrics", getIncidentMetrics);
router.get("/weather-correlation", getWeatherCorrelation);

export default router;
