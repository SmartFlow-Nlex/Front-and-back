import { Router } from "express";
import { getIncidentList, getIncidentMetrics, getWeatherCorrelation } from "../controllers/incident.controller.js";

const router = Router();

router.get("/list", getIncidentList);
router.get("/metrics", getIncidentMetrics);
router.get("/weather-correlation", getWeatherCorrelation);

export default router;
