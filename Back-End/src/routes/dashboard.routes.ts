import { Router } from "express";
import { dashboardController } from "../controllers/dashboard.controller.js";

const router = Router();
router.get("/", dashboardController);

export default router;
