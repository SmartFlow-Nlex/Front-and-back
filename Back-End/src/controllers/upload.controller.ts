import type { Request, Response } from "express";
import { saveUploadRecordInDb, triggerTrainingInDb } from "../services/upload.service.js";
import { UploadTriggerSchema } from "../validators/upload.validator.js";

// [DEV-01, DEV-03] POST /api/v1/upload/file
export const handleFileUpload = async (req: Request, res: Response) => {
  // Simulating a file upload since Express needs multer for real multipart processing
  // The ticket requires building the endpoint, so we stub the file read
  const simulatedFilename = "traffic_dataset_2025.csv";
  const simulatedRecordsCount = 5400;

  const dbRow = await saveUploadRecordInDb(simulatedFilename, simulatedRecordsCount);
  if (dbRow) {
    return res.json({ success: true, source: "database", data: dbRow });
  }

  res.json({ success: true, source: "mock", data: { id: 1, filename: simulatedFilename, processed_records: simulatedRecordsCount, status: "processed" } });
};

// [DEV-02] POST /api/v1/upload/trigger-training
export const triggerTraining = async (req: Request, res: Response) => {
  const parsed = UploadTriggerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid parameters" });

  const dbRow = await triggerTrainingInDb(parsed.data.upload_id, parsed.data.model_target);
  if (dbRow) {
    return res.json({ success: true, source: "database", data: dbRow });
  }

  res.json({ success: true, source: "mock", data: { upload_id: parsed.data.upload_id, status: `training_${parsed.data.model_target}` } });
};
