import { Pool } from "pg";
import { env } from "../config/env.js";

export const db = env.POSTGRES_URL
  ? new Pool({ 
      connectionString: env.POSTGRES_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;
