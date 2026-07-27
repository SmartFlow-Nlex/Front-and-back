import { Pool } from "pg";

// Credentials come from the environment (see Back-End/.env, which is gitignored).
// This was previously a hardcoded connection string including the password.
const connectionString = process.env.POSTGRES_URL;
if (!connectionString) {
  throw new Error("POSTGRES_URL is not set. Add it to Back-End/.env before running migrations.");
}
const pool = new Pool({ connectionString });

async function run() {
  try {
    console.log("Connecting to AWS RDS PostgreSQL...");
    const client = await pool.connect();
    console.log("Connected successfully!");

    const migrationSql = `
      ALTER TABLE audit_logs
        ADD COLUMN IF NOT EXISTS severity       TEXT    NOT NULL DEFAULT 'info',
        ADD COLUMN IF NOT EXISTS module         TEXT,
        ADD COLUMN IF NOT EXISTS previous_status TEXT,
        ADD COLUMN IF NOT EXISTS new_status      TEXT;

      UPDATE audit_logs
         SET module = split_part(action, '.', 1)
       WHERE module IS NULL AND action LIKE '%.%';

      CREATE INDEX IF NOT EXISTS idx_audit_logs_module_ts
        ON audit_logs (module, timestamp DESC);

      CREATE INDEX IF NOT EXISTS idx_audit_logs_severity
        ON audit_logs (severity);
    `;

    console.log("Running migration...");
    await client.query(migrationSql);
    console.log("Migration completed successfully!");

    const res = await client.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'audit_logs';"
    );
    console.log("Current audit_logs columns:", res.rows);

    client.release();
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await pool.end();
  }
}

run();
