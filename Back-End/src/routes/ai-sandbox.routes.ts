import { Router } from "express";
import { triggerSimulation, configLanes, getResults } from "../controllers/ai-sandbox.controller.js";
import { parseSandboxCommand, commandStatus, scenarioContext } from "../controllers/sandbox-command.controller.js";
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
router.get("/command/status", commandStatus);
router.post("/command", parseSandboxCommand);
router.get("/scenario", scenarioContext);

// Apply auth middleware to the remaining ai-sandbox endpoints
router.use(authenticateToken);
router.use(authorizeRoles(["data-analyst", "tcc-operator"]));

router.post("/simulate", triggerSimulation);
router.post("/config-lanes", configLanes);
router.get("/results/:id", getResults);

export default router;
