import { Router } from "express";
import { dataManagementController } from "../controllers/data-management.controller.js";

const router = Router();
router.get("/", dataManagementController);

export default router;
