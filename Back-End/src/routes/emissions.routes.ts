import { Router } from "express";
import { getEmissionsIndex, getPeakPenalty, getClimateResilience } from "../controllers/emissions.controller.js";

const router = Router();

router.get("/index", getEmissionsIndex);
router.get("/peak-penalty", getPeakPenalty);
router.get("/resilience", getClimateResilience);

export default router;
