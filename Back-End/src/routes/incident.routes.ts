import { Router } from "express";
import { incidentController } from "../controllers/incident.controller.js";

const router = Router();
router.get("/", incidentController);

export default router;
