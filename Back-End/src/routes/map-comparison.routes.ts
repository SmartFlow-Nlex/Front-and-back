import { Router } from "express";
import { mapComparisonController } from "../controllers/map-comparison.controller.js";

const router = Router();
router.get("/", mapComparisonController);

export default router;
