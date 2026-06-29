import { Router } from "express";
import { getRealtimeTraffic, getIncidents, getForecast, getVolumeAdt, getTrafficOverview } from "../controllers/traffic.controller.js";

const router = Router();

router.get("/summary", getTrafficOverview);  // Full traffic analytics
router.get("/realtime", getRealtimeTraffic);
router.get("/incidents", getIncidents);
router.get("/forecast", getForecast);
router.get("/volume-adt", getVolumeAdt);

export default router;
