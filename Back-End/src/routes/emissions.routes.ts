import { Router } from "express";
import {
  getSustainabilityOverview,
  getEmissionsIndex,
  getPeakPenalty,
  getClimateResilienceEndpoint
} from "../controllers/emissions.controller.js";

const router = Router();

// User requested to skip auth middleware for now for development
router.get("/summary", getSustainabilityOverview);
router.get("/index", getEmissionsIndex);
router.get("/peak-penalty", getPeakPenalty);
router.get("/resilience", getClimateResilienceEndpoint);

export default router;
