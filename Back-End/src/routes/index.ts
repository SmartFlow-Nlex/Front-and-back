import { Router } from "express";
import healthRoutes from "./health.routes.js";
import dashboardRoutes from "./dashboard.routes.js";
import trafficRoutes from "./traffic.routes.js";
import incidentRoutes from "./incident.routes.js";
import emissionsRoutes from "./emissions.routes.js";
import mapComparisonRoutes from "./map-comparison.routes.js";
import aiSandboxRoutes from "./ai-sandbox.routes.js";
import dataManagementRoutes from "./data-management.routes.js";
import auditLogRoutes from "./audit-log.routes.js";

const router = Router();

router.use("/health", healthRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/traffic", trafficRoutes);
router.use("/incident", incidentRoutes);
router.use("/emissions", emissionsRoutes);
router.use("/map-comparison", mapComparisonRoutes);
router.use("/ai-sandbox", aiSandboxRoutes);
router.use("/data-management", dataManagementRoutes);
router.use("/audit-log", auditLogRoutes);

export default router;
