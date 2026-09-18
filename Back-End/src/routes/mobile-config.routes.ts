import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { readMobileConfig, writeMobileConfig } from "../controllers/mobile-config.controller.js";

const router = Router();

// GET is public on purpose: the mobile app calls it on launch, before any user
// has signed in, and it returns only which screens are switched on plus an
// advisory that is meant to be broadcast. Nothing here is sensitive.
router.get("/", asyncHandler(readMobileConfig));
router.put("/", asyncHandler(writeMobileConfig));

export default router;
