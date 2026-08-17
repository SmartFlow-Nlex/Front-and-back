import { Router } from "express";
import { dashboardController, dashboardOverviewController, corridorStatusController } from "../controllers/dashboard.controller.js";

const router = Router();
router.get("/", dashboardController);
router.get("/overview", dashboardOverviewController);
router.get("/corridor-status", corridorStatusController);

export default router;
