import { Router } from "express";
import { triggerSimulation, configLanes, getResults } from "../controllers/ai-sandbox.controller.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.middleware.js";

const router = Router();

// Apply auth middleware to all ai-sandbox endpoints
router.use(authenticateToken);
router.use(authorizeRoles(["data-analyst", "tcc-operator"]));

router.post("/simulate", triggerSimulation);
router.post("/config-lanes", configLanes);
router.get("/results/:id", getResults);

export default router;
