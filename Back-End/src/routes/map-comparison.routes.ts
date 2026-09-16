import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { getMapRealtime, getMapForecast, searchExits, getMapLiveOverview } from "../controllers/map-comparison.controller.js";

const router = Router();

router.get("/real-time", asyncHandler(getMapRealtime));
router.get("/forecast", asyncHandler(getMapForecast));
router.get("/exits", asyncHandler(searchExits));
router.get("/live-overview", asyncHandler(getMapLiveOverview));

export default router;
