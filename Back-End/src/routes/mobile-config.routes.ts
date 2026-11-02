import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { readMobileConfig, writeMobileConfig } from "../controllers/mobile-config.controller.js";
import { authenticateToken } from "../middleware/auth.middleware.js";

const router = Router();

// GET is public on purpose: the mobile app calls it on launch, before any user
// has signed in, and it returns only which screens are switched on plus an
// advisory that is meant to be broadcast. Nothing here is sensitive.
router.get("/", asyncHandler(readMobileConfig));
// Saving puts words on drivers' phones, so it takes a signed-in user (31 Oct 2026). It was open to anyone who could
// reach the API, and the audit entry named whoever the caller claimed to be. Every role may open the Mobile App page.
router.put("/", authenticateToken, asyncHandler(writeMobileConfig));

export default router;
