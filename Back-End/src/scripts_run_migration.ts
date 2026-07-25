import { Pool } from "pg";

const connectionString = "postgresql://postgres:Hanszy123@smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone?sslmode=no-verify";
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
