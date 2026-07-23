import { Router } from "express";
import { getRealtimeTraffic, getIncidents, getForecast, getVolumeAdt, getTrafficAnalytics } from "../controllers/traffic.controller.js";

const router = Router();

router.get("/analytics", getTrafficAnalytics);
router.get("/realtime", getRealtimeTraffic);
router.get("/incidents", getIncidents);
router.get("/forecast", getForecast);
router.get("/volume-adt", getVolumeAdt);

export default router;
