import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { healthController } from "../controllers/health.controller.js";

const router = Router();
router.get("/", asyncHandler(healthController));

export default router;
