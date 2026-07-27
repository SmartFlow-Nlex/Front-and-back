import { z } from "zod";

export const SimulationRequestSchema = z.object({
  parameters: z.object({
    vehicleDensity: z.number().min(0).max(100),
    weather: z.enum(["clear", "rain", "storm"]),
  }),
});

export const ConfigLaneSchema = z.object({
  laneId: z.string(),
  status: z.enum(["open", "closed", "restricted"]),
});
