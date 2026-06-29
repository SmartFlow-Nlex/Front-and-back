import { Router } from "express";
import { createSchedule, listSchedules, deleteSchedule } from "../controllers/maintenance.controller.js";

const router = Router();

router.post("/schedule", createSchedule);
router.get("/list", listSchedules);
router.delete("/:id", deleteSchedule);

export default router;
