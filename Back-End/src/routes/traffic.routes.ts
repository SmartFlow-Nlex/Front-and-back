import { Router } from "express";
import { trafficController } from "../controllers/traffic.controller.js";

const router = Router();
router.get("/", trafficController);

export default router;
