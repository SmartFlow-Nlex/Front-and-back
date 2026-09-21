import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { triggerSimulation, configLanes, getResults } from "../controllers/ai-sandbox.controller.js";
import { parseSandboxCommand, commandStatus, scenarioContext, demandExits, demandProfile, plazaFlows, recordedWeather } from "../controllers/sandbox-command.controller.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.middleware.js";

const router = Router();

/**
 * The command parser is mounted ahead of the auth middleware below, because the
 * dashboard sends no Supabase token today — every other tab calls its endpoints
 * unauthenticated, and gating this one alone would leave the sandbox's command
 * box permanently 401ing while the rest of the page worked.
 *
 * It is a safe thing to leave open in the sense that it reads nothing and
 * writes nothing: it takes a sentence plus the browser's own simulation state
 * and returns a proposed action list. It does cost tokens per call, so it moves
 * behind authenticateToken along with the rest of the dashboard as soon as the
 * frontend carries a session.
 */
router.get("/command/status", asyncHandler(commandStatus));
router.post("/command", asyncHandler(parseSandboxCommand));
router.get("/scenario", asyncHandler(scenarioContext));
// Recorded rain for the simulated hour. Public for the same reason: a read of
// published warehouse weather, no per-user content.
router.get("/weather", asyncHandler(recordedWeather));

/* Observed demand. Public for the same reason as the routes above: the
 * dashboard carries no session yet, and these read published warehouse
 * aggregates with no per-user content. */
router.get("/demand-exits", asyncHandler(demandExits));
router.get("/demand-profile", asyncHandler(demandProfile));
router.get("/plaza-flows", asyncHandler(plazaFlows));

// Apply auth middleware to the remaining ai-sandbox endpoints
router.use(authenticateToken);
router.use(authorizeRoles(["data-analyst", "tcc-operator"]));

router.post("/simulate", asyncHandler(triggerSimulation));
router.post("/config-lanes", asyncHandler(configLanes));
router.get("/results/:id", asyncHandler(getResults));

export default router;
