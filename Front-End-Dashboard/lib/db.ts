import { Pool } from "pg";

let pool: Pool | null = null;

export function getDbPool(): Pool | null {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) return null;

  if (!pool) {
    pool = new Pool({ connectionString });
  }

  return pool;
}
