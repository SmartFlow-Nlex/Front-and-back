import { Router } from "express";
import multer from "multer";
import { handleFileUpload, detectType, getHistory, getDatasets } from "../controllers/upload.controller.js";

const router = Router();

// Configure multer for memory storage (files stay in RAM buffer for parsing)
// 100MB limit to handle the large traffic volume CSV
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "text/csv" || file.originalname.toLowerCase().endsWith(".csv")) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are accepted"));
    }
  },
});

// Upload & ingest a CSV file into the database
router.post("/file", upload.single("file"), handleFileUpload);

// Detect dataset type from a CSV file (without ingesting)
router.post("/detect", upload.single("file"), detectType);

// Get upload history
router.get("/history", getHistory);

// Get available dataset types with current row counts
router.get("/datasets", getDatasets);

export default router;
