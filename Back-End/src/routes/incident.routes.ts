import { Router } from "express";
import { getIncidentList, getIncidentMetrics, getWeatherCorrelation, getIncidentAnalytics } from "../controllers/incident.controller.js";

const router = Router();

router.get("/analytics", getIncidentAnalytics);
router.get("/list", getIncidentList);
router.get("/metrics", getIncidentMetrics);
router.get("/weather-correlation", getWeatherCorrelation);

export default router;
