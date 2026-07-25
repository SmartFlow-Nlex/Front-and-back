import { z } from "zod";

export const emptySchema = z.object({
  body: z.any().optional(),
  query: z.any().optional(),
  params: z.any().optional(),
});
