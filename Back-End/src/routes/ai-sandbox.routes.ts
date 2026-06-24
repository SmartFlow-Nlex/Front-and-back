import { Router } from "express";
import { triggerSimulation, configLanes, getResults } from "../controllers/ai-sandbox.controller.js";

const router = Router();

router.post("/simulate", triggerSimulation);
router.post("/config-lanes", configLanes);
router.get("/results/:id", getResults);

export default router;
