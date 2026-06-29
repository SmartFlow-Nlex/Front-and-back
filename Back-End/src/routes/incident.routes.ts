import { Router } from "express";
import { getIncidentOverview, getIncidentList, getIncidentMetrics, getWeatherCorrelation } from "../controllers/incident.controller.js";

const router = Router();

router.get("/summary", getIncidentOverview);  // Full incident analytics
router.get("/list", getIncidentList);
router.get("/metrics", getIncidentMetrics);
router.get("/weather-correlation", getWeatherCorrelation);

export default router;
