const REDIS_REST_URL = "https://united-mayfly-138714.upstash.io";
const REDIS_REST_TOKEN = "gQAAAAAAAh3aAAIgcDFhYjk2NjA4N2FiNDQ0YjlmYjVkOGZlOTliNGRkZDMyYw";

// ── NLEX Corridor Waze-style Alerts (Points) ──────────────────────────
const alerts = [
  {
    uuid: "alert-nlex-001",
    street: "NLEX Balintawak Northbound",
    city: "Caloocan",
    report_description: "Major accident near Balintawak toll. Heavy congestion building up.",
    reliability: 9,
    confidence: 5,
    type: "ACCIDENT",
    subtype: "ACCIDENT_MAJOR",
    longitude: 121.0001,
    latitude: 14.6788,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "alert-nlex-002",
    street: "NLEX Valenzuela Southbound",
    city: "Valenzuela",
    report_description: "Police checkpoint ahead. Expect slowdown.",
    reliability: 8,
    confidence: 4,
    type: "POLICE",
    subtype: "POLICE_VISIBLE",
    longitude: 120.9930,
    latitude: 14.7082,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "alert-nlex-003",
    street: "NLEX Meycauayan Northbound",
    city: "Meycauayan",
    report_description: "Road construction on right lane. Merge left.",
    reliability: 7,
    confidence: 4,
    type: "CONSTRUCTION",
    subtype: "CONSTRUCTION_MINOR",
    longitude: 120.9723,
    latitude: 14.7464,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "alert-nlex-004",
    street: "NLEX Bocaue Barrier",
    city: "Bocaue",
    report_description: "Heavy traffic jam at toll barrier. Long queues.",
    reliability: 9,
    confidence: 5,
    type: "JAM",
    subtype: "JAM_HEAVY_TRAFFIC",
    longitude: 120.9425,
    latitude: 14.8025,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "alert-nlex-005",
    street: "NLEX Pulilan Segment",
    city: "Pulilan",
    report_description: "Debris on road – tire remnants on middle lane.",
    reliability: 6,
    confidence: 3,
    type: "HAZARD",
    subtype: "HAZARD_ON_ROAD_OBJECT",
    longitude: 120.8170,
    latitude: 14.9083,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "alert-nlex-006",
    street: "NLEX San Fernando Southbound",
    city: "San Fernando",
    report_description: "Minor fender bender on shoulder. Drive with caution.",
    reliability: 7,
    confidence: 4,
    type: "ACCIDENT",
    subtype: "ACCIDENT_MINOR",
    longitude: 120.6949,
    latitude: 15.0497,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "alert-nlex-007",
    street: "NLEX Angeles Northbound",
    city: "Angeles City",
    report_description: "Police speed trap reported ahead.",
    reliability: 8,
    confidence: 3,
    type: "POLICE",
    subtype: "POLICE_HIDING",
    longitude: 120.6135,
    latitude: 15.1631,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "alert-nlex-008",
    street: "NLEX Dau Interchange",
    city: "Mabalacat",
    report_description: "Construction zone near SCTEX junction. Lane closure.",
    reliability: 9,
    confidence: 5,
    type: "CONSTRUCTION",
    subtype: "CONSTRUCTION_MAJOR",
    longitude: 120.6046,
    latitude: 15.1780,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "alert-nlex-009",
    street: "NLEX Marilao Segment",
    city: "Marilao",
    report_description: "Stalled vehicle on right shoulder.",
    reliability: 6,
    confidence: 3,
    type: "HAZARD",
    subtype: "HAZARD_ON_SHOULDER_CAR_STOPPED",
    longitude: 120.9573,
    latitude: 14.7746,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "alert-nlex-010",
    street: "NLEX Mexico Northbound",
    city: "Mexico",
    report_description: "Moderate traffic building due to road work.",
    reliability: 7,
    confidence: 4,
    type: "JAM",
    subtype: "JAM_MODERATE_TRAFFIC",
    longitude: 120.6636,
    latitude: 15.1052,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  }
];

// ── NLEX Corridor Waze-style Jams (LineStrings) ──────────────────────
// Each jam follows actual NLEX road geometry along the corridor
const jams = [
  {
    uuid: "jam-nlex-001",
    street: "NLEX Balintawak to Harbor Link",
    city: "Caloocan / Valenzuela",
    level: 4,
    speed_kmh: 12.0,
    length_meters: 2800,
    delay_seconds: 540,
    polyline: "LINESTRING(121.00009 14.67877, 121.00020 14.68200, 121.00025 14.68600, 121.00031 14.69347)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "jam-nlex-002",
    street: "NLEX Harbor Link to Paso de Blas",
    city: "Valenzuela",
    level: 3,
    speed_kmh: 25.0,
    length_meters: 2100,
    delay_seconds: 300,
    polyline: "LINESTRING(121.00031 14.69347, 120.99800 14.69800, 120.99600 14.70200, 120.99300 14.70821)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "jam-nlex-003",
    street: "NLEX Paso de Blas to Meycauayan",
    city: "Valenzuela / Meycauayan",
    level: 2,
    speed_kmh: 45.0,
    length_meters: 4500,
    delay_seconds: 180,
    polyline: "LINESTRING(120.99300 14.70821, 120.98900 14.71500, 120.98400 14.72400, 120.97900 14.73400, 120.97232 14.74639)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "jam-nlex-004",
    street: "NLEX Meycauayan to Marilao",
    city: "Meycauayan / Marilao",
    level: 1,
    speed_kmh: 70.0,
    length_meters: 3500,
    delay_seconds: 60,
    polyline: "LINESTRING(120.97232 14.74639, 120.96800 14.75400, 120.96400 14.76200, 120.95727 14.77456)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "jam-nlex-005",
    street: "NLEX Marilao to CdV/Ph Arena",
    city: "Marilao / Bocaue",
    level: 2,
    speed_kmh: 40.0,
    length_meters: 2500,
    delay_seconds: 150,
    polyline: "LINESTRING(120.95727 14.77456, 120.95400 14.78100, 120.95100 14.78700, 120.94726 14.79312)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "jam-nlex-006",
    street: "NLEX CdV to Bocaue Barrier",
    city: "Bocaue",
    level: 4,
    speed_kmh: 8.0,
    length_meters: 1800,
    delay_seconds: 600,
    polyline: "LINESTRING(120.94726 14.79312, 120.94500 14.79700, 120.94350 14.80000, 120.94246 14.80246)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "jam-nlex-007",
    street: "NLEX Bocaue to Tambubong",
    city: "Bocaue",
    level: 3,
    speed_kmh: 30.0,
    length_meters: 1600,
    delay_seconds: 240,
    polyline: "LINESTRING(120.94246 14.80246, 120.94100 14.80500, 120.93940 14.80723, 120.93700 14.81100, 120.93507 14.81512)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "jam-nlex-008",
    street: "NLEX Tambubong to Tabang/Balagtas",
    city: "Bocaue / Guiguinto",
    level: 1,
    speed_kmh: 80.0,
    length_meters: 3800,
    delay_seconds: 30,
    polyline: "LINESTRING(120.93507 14.81512, 120.92800 14.82000, 120.92000 14.82500, 120.91200 14.82900, 120.90391 14.83275)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "jam-nlex-009",
    street: "NLEX Balagtas to Sta. Rita",
    city: "Balagtas / Guiguinto",
    level: 2,
    speed_kmh: 50.0,
    length_meters: 4800,
    delay_seconds: 150,
    polyline: "LINESTRING(120.90063 14.83444, 120.89500 14.83800, 120.88500 14.84500, 120.87500 14.85200, 120.86500 14.85800, 120.85889 14.86245)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "jam-nlex-010",
    street: "NLEX Sta. Rita to Pulilan",
    city: "Guiguinto / Pulilan",
    level: 1,
    speed_kmh: 85.0,
    length_meters: 6000,
    delay_seconds: 20,
    polyline: "LINESTRING(120.85889 14.86245, 120.84800 14.87200, 120.83800 14.88200, 120.82800 14.89300, 120.81702 14.90826)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "jam-nlex-011",
    street: "NLEX Pulilan to San Simon",
    city: "Pulilan / San Simon",
    level: 1,
    speed_kmh: 90.0,
    length_meters: 11000,
    delay_seconds: 15,
    polyline: "LINESTRING(120.81702 14.90826, 120.80500 14.92000, 120.79000 14.94000, 120.77500 14.96000, 120.76000 14.97500, 120.74997 14.99013)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "jam-nlex-012",
    street: "NLEX San Simon to San Fernando",
    city: "San Simon / San Fernando",
    level: 3,
    speed_kmh: 28.0,
    length_meters: 8000,
    delay_seconds: 360,
    polyline: "LINESTRING(120.74997 14.99013, 120.73800 15.00200, 120.72500 15.01500, 120.71200 15.02800, 120.70300 15.03900, 120.69486 15.04971)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "jam-nlex-013",
    street: "NLEX San Fernando to Mexico",
    city: "San Fernando / Mexico",
    level: 2,
    speed_kmh: 55.0,
    length_meters: 7000,
    delay_seconds: 120,
    polyline: "LINESTRING(120.69486 15.04971, 120.68500 15.06000, 120.67800 15.07500, 120.67000 15.09000, 120.66362 15.10522)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "jam-nlex-014",
    street: "NLEX Mexico to Angeles",
    city: "Mexico / Angeles City",
    level: 2,
    speed_kmh: 48.0,
    length_meters: 8000,
    delay_seconds: 200,
    polyline: "LINESTRING(120.66362 15.10522, 120.65200 15.12000, 120.64000 15.13500, 120.62500 15.15000, 120.61346 15.16311)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "jam-nlex-015",
    street: "NLEX Angeles to Dau/SCTEX",
    city: "Angeles / Mabalacat",
    level: 3,
    speed_kmh: 22.0,
    length_meters: 4000,
    delay_seconds: 420,
    polyline: "LINESTRING(120.61346 15.16311, 120.61000 15.16800, 120.60700 15.17300, 120.60463 15.17801, 120.59712 15.19630)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  },
  {
    uuid: "jam-nlex-016",
    street: "NLEX SCTEX to Sta. Ines",
    city: "Mabalacat",
    level: 1,
    speed_kmh: 75.0,
    length_meters: 3500,
    delay_seconds: 45,
    polyline: "LINESTRING(120.59712 15.19630, 120.59400 15.20300, 120.59100 15.21000, 120.58783 15.22204)",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  }
];

async function seed() {
  console.log("Seeding Upstash Redis with comprehensive NLEX corridor data...");
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
    console.log("Alerts result:", await r1.text(), `(${alerts.length} alerts seeded)`);

    const r2 = await fetch(`${REDIS_REST_URL}/set/waze:active_jams`, {
      method: "POST",
      headers,
      body: JSON.stringify(jams)
    });
    console.log("Jams result:", await r2.text(), `(${jams.length} jam segments seeded)`);
    console.log("Seeding complete! Full NLEX corridor from Balintawak to Sta. Ines is now populated.");
  } catch (err) {
    console.error("Error seeding Redis:", err);
  }
}

seed();
