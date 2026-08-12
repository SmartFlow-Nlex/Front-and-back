import { Router } from "express";
import { getMapRealtime, getMapForecast, searchExits } from "../controllers/map-comparison.controller.js";

const router = Router();

router.get("/real-time", getMapRealtime);
router.get("/forecast", getMapForecast);
router.get("/exits", searchExits);

export default router;
