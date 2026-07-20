import { Pool } from "pg";
import { env } from "../config/env.js";

export const db = env.POSTGRES_URL
  ? new Pool({ 
      connectionString: env.POSTGRES_URL.replace(/[?&]ssl=true/, ''),
      ssl: env.POSTGRES_URL.includes("ssl=true") ? { rejectUnauthorized: false } : undefined
    })
  : null;
