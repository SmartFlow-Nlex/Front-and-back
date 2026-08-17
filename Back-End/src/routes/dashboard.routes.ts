import { Router } from "express";
import { dashboardController, dashboardOverviewController } from "../controllers/dashboard.controller.js";

const router = Router();
router.get("/", dashboardController);
router.get("/overview", dashboardOverviewController);

export default router;
