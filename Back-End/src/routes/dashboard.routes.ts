import { Router } from "express";
import { dashboardController, dashboardOverviewController, corridorStatusController, corridorStatusFullController } from "../controllers/dashboard.controller.js";

const router = Router();
router.get("/", dashboardController);
router.get("/overview", dashboardOverviewController);
router.get("/corridor-status", corridorStatusController);
// Every exit in both directions, status already decided. Serves the mobile app.
router.get("/corridor-status/full", corridorStatusFullController);

export default router;
