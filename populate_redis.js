/**
 * Seeds sample Waze alerts/jams into Upstash Redis for the map tab.
 *
 * Credentials come from Back-End/.env (gitignored) — they used to be written
 * directly in this file, which published them, because the repository is public.
 *
 * Usage:  node populate_redis.js
 */
const fs = require("node:fs");
const path = require("node:path");

// Minimal .env reader so this script needs no dependencies of its own.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

loadEnvFile(path.join(__dirname, "Back-End", ".env"));

const REDIS_REST_URL = process.env.REDIS_REST_URL;
const REDIS_REST_TOKEN = process.env.REDIS_REST_TOKEN;

if (!REDIS_REST_URL || !REDIS_REST_TOKEN) {
  console.error(
    "Missing Upstash credentials.\n\n" +
      "Set REDIS_REST_URL and REDIS_REST_TOKEN in Back-End/.env (see Back-End/.env.example),\n" +
      "or export them in your shell before running this script.\n\n" +
      "Do not paste them into this file — the repository is public."
  );
  process.exit(1);
}

const alerts = [
  {
    uuid: "alert-nlex-1",
    street: "NLEX Balintawak",
    city: "Caloocan",
    report_description: "Accident northbound near toll exit. Stay in lane.",
    reliability: 8,
    confidence: 4,
    type: "ACCIDENT",
    subtype: "ACCIDENT_MAJOR",
    longitude: 120.9905,
    latitude: 14.673,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "alert-nlex-2",
    street: "NLEX Bocaue",
    city: "Bocaue",
    report_description: "Road hazard southbound: debris on highway.",
    reliability: 7,
    confidence: 3,
    type: "HAZARD",
    subtype: "HAZARD_ON_ROAD_OBJECT",
    longitude: 121.0172,
    latitude: 14.728,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  }
];

const jams = [
  {
    uuid: "jam-nlex-1",
    street: "NLEX Balintawak Segment",
    city: "Caloocan",
    level: 4,
    speed_kmh: 18.0,
    length_meters: 1500,
    delay_seconds: 420,
    polyline: "LINESTRING(120.9842 14.6575, 120.9905 14.673, 121.0002 14.6911)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "jam-nlex-2",
    street: "NLEX Bocaue Segment",
    city: "Bocaue",
    level: 2,
    speed_kmh: 45.0,
    length_meters: 800,
    delay_seconds: 120,
    polyline: "LINESTRING(121.009 14.7105, 121.0172 14.728)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  }
];

async function seed() {
  console.log("Seeding Upstash Redis...");
  const headers = {
    "Authorization": `Bearer ${REDIS_REST_TOKEN}`,
    "Content-Type": "application/json"
  };

  try {
    const r1 = await fetch(`${REDIS_REST_URL}/set/waze:active_alerts`, {
      method: "POST",
      headers,
      body: JSON.stringify(alerts)
    });
    console.log("Alerts result:", await r1.text());

    const r2 = await fetch(`${REDIS_REST_URL}/set/waze:active_jams`, {
      method: "POST",
      headers,
      body: JSON.stringify(jams)
    });
    console.log("Jams result:", await r2.text());
    console.log("Seeding complete!");
  } catch (err) {
    console.error("Error seeding Redis:", err);
  }
}

seed();
