import { Router } from "express";
import { carbonEmissionBatchController, carbonEmissionController, emissionsController } from "../controllers/emissions.controller.js";

const router = Router();
router.get("/", emissionsController);
router.post("/calculate", carbonEmissionController);
router.post("/calculate/batch", carbonEmissionBatchController);

export default router;
