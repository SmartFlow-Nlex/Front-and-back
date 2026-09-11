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

/**
 * POST /api/ai-sandbox/command — natural-language control of the sandbox.
 *
 * The context block mirrors the browser-side simulation's current shape. It is
 * sent by the client rather than held server-side because the sim lives
 * entirely in the browser (see Front-End-Dashboard/app/dashboard/ai-sandbox/
 * simulation.ts); the backend holds no session for it.
 */
export const SandboxCommandSchema = z.object({
  command: z.string().trim().min(1, "Command is empty").max(500),
  context: z.object({
    laneCount: z.number().int().min(1).max(6),
    segmentLengthM: z.number().positive().max(10_000),
    closedLanes: z.array(z.number().int()).max(6).default([]),
    speedLimitKmh: z.number().nullable().default(null),
    incidentCount: z.number().int().min(0).default(0),
    exits: z
      .array(z.object({ exit_id: z.number().int(), exit_name: z.string() }))
      .max(100)
      .default([]),
  }),
});
