import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import {
  modelNarrative,
  congestionNarrative,
  eventSurgeNarrative,
  insightStatus,
  explainFeature,
  incidentModelsNarrative,
  clearanceNarrative,
  incidentPriorityNarrative,
  corridorRiskNarrative,
  highIncidentDayNarrative,
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

/* The incident module's other panels. Separate endpoints because none of them
 * is scored on the forecast scale -- see ai-insight.incident.service.ts. */
router.post("/incident-models-narrative", asyncHandler(incidentModelsNarrative));
router.post("/clearance-narrative", asyncHandler(clearanceNarrative));
router.post("/incident-priority-narrative", asyncHandler(incidentPriorityNarrative));
router.post("/corridor-risk-narrative", asyncHandler(corridorRiskNarrative));
router.post("/high-incident-day-narrative", asyncHandler(highIncidentDayNarrative));

export default router;
