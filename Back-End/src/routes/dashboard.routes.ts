import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { dashboardController, dashboardOverviewController, corridorStatusController, corridorStatusFullController } from "../controllers/dashboard.controller.js";

const router = Router();
router.get("/", asyncHandler(dashboardController));
router.get("/overview", asyncHandler(dashboardOverviewController));
router.get("/corridor-status", asyncHandler(corridorStatusController));
// Every exit in both directions, status already decided. Serves the mobile app.
router.get("/corridor-status/full", asyncHandler(corridorStatusFullController));

export default router;
