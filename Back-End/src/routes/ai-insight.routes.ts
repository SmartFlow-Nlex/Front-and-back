import { Router } from "express";
import { modelNarrative, insightStatus, explainFeature } from "../controllers/ai-insight.controller.js";

const router = Router();

/**
 * Unauthenticated for the same reason as the sandbox command route: the
 * dashboard carries no Supabase session today, so gating this would leave the
 * button permanently failing while the chart above it worked. It reads nothing
 * and writes nothing — the metrics come from the caller — but it does spend
 * tokens, so it moves behind auth with the rest of the dashboard.
 */
router.get("/status", insightStatus);
router.post("/model-narrative", modelNarrative);
router.post("/explain", explainFeature);

export default router;
