import { Router } from "express";
import { getRealtimeTraffic, getIncidents, getForecast, getForecastHourly, getVolumeAdt, getTrafficAnalytics } from "../controllers/traffic.controller.js";
import { asyncHandler } from "../middleware/error.middleware.js";

const router = Router();

router.get("/analytics", asyncHandler(getTrafficAnalytics));
router.get("/realtime", asyncHandler(getRealtimeTraffic));
router.get("/incidents", asyncHandler(getIncidents));
router.get("/forecast", asyncHandler(getForecast));
router.get("/forecast/hourly", asyncHandler(getForecastHourly));
router.get("/volume-adt", asyncHandler(getVolumeAdt));

export default router;
