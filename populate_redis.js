const REDIS_REST_URL = "https://united-mayfly-138714.upstash.io";
const REDIS_REST_TOKEN = "gQAAAAAAAh3aAAIgcDFhYjk2NjA4N2FiNDQ0YjlmYjVkOGZlOTliNGRkZDMyYw";

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
