import { z } from "zod";

export const UploadTriggerSchema = z.object({
  upload_id: z.number().int().positive(),
  model_target: z.enum(["traffic_forecast", "emissions_prediction", "incident_risk"]).default("traffic_forecast")
});
