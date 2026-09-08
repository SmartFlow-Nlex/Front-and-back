import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  // Comma-separated list of browser origins allowed to call the API. It was a
  // single origin, which is all the Next.js dashboard needed; the mobile app
  // adds a second client, and an Expo web build serves from its own port.
  //
  // Native mobile is unaffected either way — CORS is a browser rule, and a
  // React Native fetch sends no Origin header at all. This exists so an Expo
  // *web* build is not blocked, and so a second dev port does not require an
  // edit here.
  FRONTEND_ORIGIN: z.string().default("http://localhost:3002"),
  CLIMATIQ_API_KEY: z.string().optional(),

  // Upstash Redis (live Waze feed). No default — these are real credentials and
  // must never be committed. Without them the map falls back to sample data.
  REDIS_REST_URL: z.string().optional(),
  REDIS_REST_TOKEN: z.string().optional(),

  // Either supply POSTGRES_URL whole, or supply the PG_* parts and let
  // buildPostgresUrl() assemble it (see below).
  POSTGRES_URL: z.string().optional(),
  PG_HOST: z.string().optional(),
  PG_PORT: z.coerce.number().optional(),
  PG_DATABASE: z.string().optional(),
  PG_USER: z.string().optional(),
  PG_PASSWORD: z.string().optional(),

  // "relaxed" = encrypt but skip CA verification (needed for RDS out of the
  // box). "verify" = full chain verification, requires PG_CA_CERT.
  // "disable" = no TLS at all (local Postgres only; RDS rejects it).
  PG_SSL_MODE: z.enum(["relaxed", "verify", "disable"]).default("relaxed"),
  PG_CA_CERT: z.string().optional(),
});

const parsed = envSchema.parse(process.env);

/**
 * Assemble a libpq connection URL from the discrete PG_* variables.
 *
 * Passwords routinely contain characters that are structural in a URL ("!",
 * "@", "/", "#", ":"), so the user and password are percent-encoded here.
 * Skipping this is the classic cause of a "password authentication failed"
 * that looks like a wrong credential but is really a parsing bug.
 */
function buildPostgresUrl(): string | undefined {
  if (parsed.POSTGRES_URL && parsed.POSTGRES_URL.trim().length > 0) {
    return parsed.POSTGRES_URL.trim();
  }

  const { PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD } = parsed;
  if (!PG_HOST || !PG_DATABASE || !PG_USER) return undefined;

  const port = parsed.PG_PORT ?? 5432;
  const auth = PG_PASSWORD
    ? `${encodeURIComponent(PG_USER)}:${encodeURIComponent(PG_PASSWORD)}`
    : encodeURIComponent(PG_USER);

  return `postgresql://${auth}@${PG_HOST}:${port}/${PG_DATABASE}`;
}

export const env = {
  ...parsed,
  POSTGRES_URL: buildPostgresUrl(),
  /** FRONTEND_ORIGIN split into the list the cors middleware expects. */
  ALLOWED_ORIGINS: parsed.FRONTEND_ORIGIN.split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0),
};
