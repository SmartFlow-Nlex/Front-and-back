import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  FRONTEND_ORIGIN: z.string().default("http://localhost:3002"),
  CLIMATIQ_API_KEY: z.string().optional(),
  POSTGRES_URL: z.string().optional(),
});

export const env = envSchema.parse(process.env);
