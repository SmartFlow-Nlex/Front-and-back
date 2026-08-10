import { Pool } from "pg";
import { env } from "../config/env.js";

// AWS RDS requires SSL; without it pg_hba.conf rejects the connection before
// credentials are even checked (surfaces as "no encryption" / no matching entry).
export const db = env.POSTGRES_URL
  ? new Pool({ connectionString: env.POSTGRES_URL, ssl: { rejectUnauthorized: false } })
  : null;
