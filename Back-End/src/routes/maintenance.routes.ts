import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { createSchedule, listSchedules, updateSchedule, updateScheduleStatus, deleteSchedule } from "../controllers/maintenance.controller.js";

const router = Router();

router.post("/schedule", asyncHandler(createSchedule));
router.get("/list", asyncHandler(listSchedules));
router.put("/:id", asyncHandler(updateSchedule));
router.patch("/:id/status", asyncHandler(updateScheduleStatus));
router.delete("/:id", asyncHandler(deleteSchedule));

export default router;
