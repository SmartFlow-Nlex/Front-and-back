import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { triggerSimulation, configLanes, getResults } from "../controllers/ai-sandbox.controller.js";
import { parseSandboxCommand, commandStatus, scenarioContext, demandExits, demandProfile, plazaFlows, hotspots } from "../controllers/sandbox-command.controller.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.middleware.js";

const router = Router();

/**
 * The command parser reads nothing and writes nothing, but every call costs GLM tokens, so it takes a signed-in
 * user of a role the Sandbox is open to (2 Nov 2026). It was open while the dashboard sent no session token; the
 * sandbox now sends one (lib/api.ts apiFetch). The status check stays open: it says only whether the parser is set up.
 */
router.get("/command/status", asyncHandler(commandStatus));
router.post("/command", authenticateToken, authorizeRoles(["data-analyst", "tcc-operator"]), asyncHandler(parseSandboxCommand));
router.get("/scenario", asyncHandler(scenarioContext));

/* Observed demand. Public for the same reason as the routes above: the
 * dashboard carries no session yet, and these read published warehouse
 * aggregates with no per-user content. */
router.get("/demand-exits", asyncHandler(demandExits));
router.get("/demand-profile", asyncHandler(demandProfile));
router.get("/plaza-flows", asyncHandler(plazaFlows));
// Where incidents of a kind are recorded — the published logs, aggregated; no per-user content.
router.get("/hotspots", asyncHandler(hotspots));

// Apply auth middleware to the remaining ai-sandbox endpoints
router.use(authenticateToken);
router.use(authorizeRoles(["data-analyst", "tcc-operator"]));

router.post("/simulate", asyncHandler(triggerSimulation));
router.post("/config-lanes", asyncHandler(configLanes));
router.get("/results/:id", asyncHandler(getResults));

export default router;
