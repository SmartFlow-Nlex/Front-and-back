import { Router } from "express";
import { getRealtimeTraffic, getIncidents, getForecast, getVolumeAdt } from "../controllers/traffic.controller.js";

const router = Router();

router.get("/realtime", getRealtimeTraffic);
router.get("/incidents", getIncidents);
router.get("/forecast", getForecast);
router.get("/volume-adt", getVolumeAdt);

export default router;
