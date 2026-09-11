/**
 * Runs a .sql file against the configured warehouse — no medallion migration
 * runner existed in this repo (they were applied by hand up to now), so this
 * is a small, generic one: connect the same way init-db.ts does, execute the
 * whole file as one multi-statement query, print anything it SELECTs.
 *
 * Usage: npx tsx scripts/run-sql.ts scripts/medallion/10-bronze-accident-breakdown.sql
 */
import fs from "fs";
import { Pool } from "pg";
import { env } from "../src/config/env.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npx tsx scripts/run-sql.ts <path-to-sql-file>");
  process.exit(1);
}

if (!env.POSTGRES_URL) {
  console.error("No database configured. Set POSTGRES_URL or PG_HOST/PG_DATABASE/PG_USER/PG_PASSWORD in Back-End/.env.");
  process.exit(1);
}

const db = new Pool({
  connectionString: env.POSTGRES_URL,
  ssl: env.PG_SSL_MODE === "disable" ? undefined : { rejectUnauthorized: false },
  connectionTimeoutMillis: 45_000,
});

async function main() {
  const sql = fs.readFileSync(file, "utf8");
  const client = await db.connect();
  try {
    const who = await client.query("SELECT current_database() AS db, current_user AS usr");
    console.log(`Connected to ${who.rows[0].db} as ${who.rows[0].usr}\nRunning ${file}...\n`);

    const result = await client.query(sql);
    const results = Array.isArray(result) ? result : [result];
    for (const r of results) {
      if (r.rows && r.rows.length > 0) {
        console.table(r.rows);
      }
    }
    console.log("Done.");
  } finally {
    client.release();
    await db.end();
  }
}

main().catch((err) => {
  console.error("run-sql failed:", err.message);
  process.exit(1);
});
