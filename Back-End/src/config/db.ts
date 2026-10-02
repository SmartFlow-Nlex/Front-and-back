import fs from "node:fs";
import { Pool, type PoolConfig } from "pg";
import { env } from "../config/env.js";

/**
 * TLS settings for the connection.
 *
 * AWS RDS requires an encrypted connection (an unencrypted attempt is refused
 * by pg_hba with "no encryption"), but it presents a regional intermediate CA
 * that is not in Node's bundled trust store — so strict verification fails with
 * "self-signed certificate in certificate chain" even though the server is
 * genuine. "relaxed" encrypts the traffic while skipping chain verification.
 *
 * Note the tradeoff: relaxed mode protects against passive eavesdropping but
 * not against an active man-in-the-middle. To get full protection, download the
 * RDS CA bundle for your region and point PG_CA_CERT at it, then set
 * PG_SSL_MODE=verify.
 */
function buildSslConfig(): PoolConfig["ssl"] {
  if (env.PG_SSL_MODE === "disable") return undefined;

  if (env.PG_SSL_MODE === "verify") {
    if (!env.PG_CA_CERT) {
      throw new Error(
        "PG_SSL_MODE=verify requires PG_CA_CERT to point at the RDS CA bundle. " +
          "Download it from https://truststore.pki.rds.amazonaws.com/<region>/<region>-bundle.pem"
      );
    }
    return { ca: fs.readFileSync(env.PG_CA_CERT, "utf8"), rejectUnauthorized: true };
  }

  return { rejectUnauthorized: false };
}

function createPool(): Pool | null {
  if (!env.POSTGRES_URL) {
    console.warn(
      "[db] No POSTGRES_URL (or PG_HOST/PG_DATABASE/PG_USER) configured — " +
        "services will fall back to mock data. Copy Back-End/.env.example to Back-End/.env."
    );
    return null;
  }

  const pool = new Pool({
    connectionString: env.POSTGRES_URL,
    ssl: buildSslConfig(),
    // RDS across the public internet is slower to hand out connections than a
    // local socket; the pg default of 0 (no timeout) makes a bad host hang the
    // request forever instead of surfacing an error.
    //
    // 45s rather than 15s because this instance is shared: while a teammate runs
    // the ML pipelines, a fresh connection has been measured taking >14s, which
    // sat right on the old limit and made whole dashboards intermittently report
    // "database not reachable" even though the database was fine.
    connectionTimeoutMillis: 45_000,
    idleTimeoutMillis: 30_000,
    // Keep a few connections warm so a slow handshake is paid once, not per
    // request, during those periods.
    min: 2,
    max: 10,
  });

  // A pool-level error (dropped backend, RDS failover) is emitted on the pool,
  // not on the query — without this listener it becomes an unhandled 'error'
  // event and takes the whole process down.
  pool.on("error", (err) => {
    console.error("[db] idle client error:", err.message);
  });

  return pool;
}

/* SELF-HEALING after a network blip.
 *
 * Twice on 2026-10-01 the link to RDS dropped for a while and, once it came
 * back, this pool never did: every request waited the full 45 s for a
 * connection and failed with "timeout exceeded when trying to connect", while a
 * fresh client from the same machine connected in under half a second. Every
 * dashboard read "Live data unavailable" until the server was restarted.
 *
 * So the pool is watched: three connect timeouts inside two minutes and it is
 * replaced with a fresh one — what a restart did, without one. Callers keep
 * importing `db` as before; it forwards to whichever pool is current. During a
 * real outage this just retries with a new pool at most every couple of
 * minutes, which costs nothing. */
let current = createPool();
let connectTimeouts: number[] = [];
let replacing = false;

function noteFailure(err: unknown): void {
  if (!(err instanceof Error) || !/timeout exceeded when trying to connect/i.test(err.message)) return;
  const now = Date.now();
  connectTimeouts = connectTimeouts.filter((t) => now - t < 120_000).concat(now);
  if (connectTimeouts.length < 3 || replacing || !current) return;
  replacing = true;
  connectTimeouts = [];
  const stale = current;
  console.warn("[db] connections keep timing out — replacing the connection pool");
  current = createPool();
  stale.end().catch(() => {}).finally(() => { replacing = false; });
}

export const db: Pool | null = current
  ? new Proxy(current, {
      get(_target, prop) {
        const pool = current as any;
        if (prop === "query") {
          return (...args: any[]) => {
            const result = pool.query(...args);
            // Watch the outcome without taking it over: the caller still gets the rejection.
            if (result && typeof result.catch === "function") result.catch(noteFailure);
            return result;
          };
        }
        const value = pool[prop];
        return typeof value === "function" ? value.bind(pool) : value;
      },
    })
  : null;

/** Log connectivity once at boot so a bad credential is obvious immediately. */
export async function verifyDbConnection(): Promise<boolean> {
  if (!db) return false;
  try {
    const { rows } = await db.query(
      "SELECT current_database() AS dbname, current_user AS dbuser"
    );
    console.log(`[db] connected to ${rows[0].dbname} as ${rows[0].dbuser}`);
    return true;
  } catch (err: any) {
    console.error(`[db] CONNECTION FAILED: ${err.message}`);
    return false;
  }
}
