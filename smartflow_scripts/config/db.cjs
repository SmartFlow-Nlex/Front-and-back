/**
 * Connection settings and shared paths for every Node script in smartflow_scripts.
 *
 * Values come from config/.env (copy .env.example to .env and fill it in). Real
 * environment variables override the file.
 *
 *   const { poolConfig, setting, WORK } = require("../config/db.cjs");
 *   new Pool(poolConfig)
 *
 * ES modules (.mjs) load it with createRequire(import.meta.url).
 */
const fs = require("fs");
const path = require("path");

const ENV_FILE = path.join(__dirname, ".env");
const fileVals = {};
if (fs.existsSync(ENV_FILE)) {
  for (const raw of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    fileVals[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

function setting(name, fallback, required = false) {
  const v = process.env[name] ?? fileVals[name] ?? fallback;
  if (required && !v) {
    console.error(`config: ${name} is not set. Copy config/.env.example to config/.env and fill it in.`);
    process.exit(1);
  }
  return v;
}

const sslmode = setting("DB_SSLMODE", "require");
const poolConfig = {
  host: setting("DB_HOST", undefined, true),
  port: Number(setting("DB_PORT", "5432")),
  database: setting("DB_NAME", "nlex_capstone"),
  user: setting("DB_USER", "postgres"),
  password: setting("DB_PASSWORD", undefined, true),
  // RDS presents an Amazon-issued certificate that Node does not trust by default.
  ssl: sslmode === "disable" ? false : { rejectUnauthorized: false },
  // A cold TLS handshake to RDS has taken ~19 s; the default 0 would wait forever.
  connectionTimeoutMillis: 60000,
};

const WORK = path.join(__dirname, "..", "_work");
for (const d of ["cache", "outputs", "logs"]) fs.mkdirSync(path.join(WORK, d), { recursive: true });

module.exports = { poolConfig, setting, WORK };
