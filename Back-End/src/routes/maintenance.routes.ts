import { Router } from "express";
import { createSchedule, listSchedules, updateSchedule, updateScheduleStatus, deleteSchedule } from "../controllers/maintenance.controller.js";

const router = Router();

router.post("/schedule", createSchedule);
router.get("/list", listSchedules);
router.put("/:id", updateSchedule);
router.patch("/:id/status", updateScheduleStatus);
router.delete("/:id", deleteSchedule);

export default router;
