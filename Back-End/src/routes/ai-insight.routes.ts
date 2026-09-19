import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import {
  modelNarrative,
  congestionNarrative,
  eventSurgeNarrative,
  insightStatus,
  explainFeature,
} from "../controllers/ai-insight.controller.js";

const router = Router();

/**
 * Unauthenticated for the same reason as the sandbox command route: the
 * dashboard carries no Supabase session today, so gating this would leave the
 * button permanently failing while the chart above it worked. It reads nothing
 * and writes nothing — the metrics come from the caller — but it does spend
 * tokens, so it moves behind auth with the rest of the dashboard.
 */
router.get("/status", asyncHandler(insightStatus));
router.post("/model-narrative", asyncHandler(modelNarrative));
router.post("/congestion-narrative", asyncHandler(congestionNarrative));
router.post("/event-surge-narrative", asyncHandler(eventSurgeNarrative));
router.post("/explain", asyncHandler(explainFeature));

export default router;
