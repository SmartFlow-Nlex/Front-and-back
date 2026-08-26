import { Router } from "express";
import { getMapRealtime, getMapForecast, searchExits, getMapLiveOverview } from "../controllers/map-comparison.controller.js";

const router = Router();

router.get("/real-time", getMapRealtime);
router.get("/forecast", getMapForecast);
router.get("/exits", searchExits);
router.get("/live-overview", getMapLiveOverview);

export default router;
