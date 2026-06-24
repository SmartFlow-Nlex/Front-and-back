import { Router } from "express";
import { handleFileUpload, triggerTraining } from "../controllers/upload.controller.js";

const router = Router();

router.post("/file", handleFileUpload);
router.post("/trigger-training", triggerTraining);

export default router;
