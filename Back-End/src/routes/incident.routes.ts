import { Router } from "express";
import { getIncidentList, getIncidentMetrics, getWeatherCorrelation, getIncidentAnalytics, getIncidentPredictive, getIncidentSpatial } from "../controllers/incident.controller.js";

const router = Router();

router.get("/analytics", getIncidentAnalytics);
router.get("/predictive", getIncidentPredictive);
router.get("/spatial", getIncidentSpatial);
router.get("/list", getIncidentList);
router.get("/metrics", getIncidentMetrics);
router.get("/weather-correlation", getWeatherCorrelation);

export default router;
