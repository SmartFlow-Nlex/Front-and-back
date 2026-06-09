import { Router } from "express";
import { aiSandboxController } from "../controllers/ai-sandbox.controller.js";

const router = Router();
router.get("/", aiSandboxController);

export default router;
