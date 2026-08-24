import type { Request, Response } from "express";
import { z } from "zod";
import { searchExitsInDb, getForecastCongestionFromDb } from "../services/map-comparison.service.js";
import { ExitSearchSchema } from "../validators/map-comparison.validator.js";
import { env } from "../config/env.js";

/** gold.ml_predictive_congestion carries horizons 1-12 hours ahead. */
const ForecastHorizonSchema = z.object({
  hours: z.coerce.number().int().min(1).max(12).optional().default(1),
});

/** Served only when the database itself is unreachable. */
const fallbackForecast = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { feature_type: "forecast", congestion_score: 0.78, horizon: "1h", segment_id: "NLEX Balintawak" },
      geometry: {
        type: "LineString",
        coordinates: [
          [120.9842, 14.6575],
          [120.9905, 14.673],
          [121.0002, 14.6911],
          [121.009, 14.7105],
          [121.0172, 14.728],
        ],
      },
    },
  ],
};

// Upstash credentials come from Back-End/.env only — never from a literal in
// source. An earlier version kept the real token here as a fallback, and since
// the repository is public that published it to anyone who looked.
const REDIS_REST_URL = env.REDIS_REST_URL;
const REDIS_REST_TOKEN = env.REDIS_REST_TOKEN;

let warnedMissingRedis = false;

/** Returns the Upstash config, or null when it is not fully configured. */
function redisConfig(): { url: string; token: string } | null {
  if (REDIS_REST_URL && REDIS_REST_TOKEN) {
    return { url: REDIS_REST_URL.replace(/\/$/, ""), token: REDIS_REST_TOKEN };
  }
  if (!warnedMissingRedis) {
    warnedMissingRedis = true;
    console.warn(
      "[map-comparison] REDIS_REST_URL / REDIS_REST_TOKEN are not set — " +
        "serving sample map data. Add them to Back-End/.env to use the live Waze feed."
    );
  }
  return null;
}

const fallbackRealtime = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {
        feature_type: "jam",
        level: 3,
        speed: 42,
        street: "NLEX Balintawak to Paso de Blas",
        city: "Caloocan / Valenzuela",
        delay_seconds: 180,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [121.00009, 14.67877],
          [121.00020, 14.68200],
          [121.00025, 14.68600],
          [121.00031, 14.69347],
          [120.99800, 14.69800],
          [120.99600, 14.70200],
          [120.99300, 14.70821],
        ],
      },
    },
  ],
};

function parseWktLineString(wkt: string): [number, number][] {
  if (!wkt) return [];
  const match = wkt.match(/LINESTRING\s*\((.*)\)/i);
  if (!match) return [];
  const coordsStr = match[1];
  return coordsStr.split(",").map(pair => {
    const [lon, lat] = pair.trim().split(/\s+/).map(Number);
    return [lon, lat] as [number, number];
  }).filter(c => !isNaN(c[0]) && !isNaN(c[1]));
}

function isNlexCorridor(street: string): boolean {
  const s = (street || "").toLowerCase();
  // Ensure it explicitly matches NLEX, rather than generic terms like "expressway" or "ah26" which leak into SLEX/EDSA.
  const hasNlex = s.includes("nlex") || s.includes("north luzon");
  const isServiceOrCrossRoad = s.includes("service") || s.includes("crossing") || s.includes("exit rd") || s.includes("interchange service") || s.includes("halili") || s.includes("dulalia") || s.includes("tullahan") || s.includes("libtong") || s.includes("slex") || s.includes("skyway") || s.includes("sctex") || s.includes("tplex") || s.includes("cavitex");
  return hasNlex && !isServiceOrCrossRoad;
}

// [DEV-01, DEV-03] GET /api/v1/map-comparison/real-time
export const getMapRealtime = async (_req: Request, res: Response) => {
  const redis = redisConfig();
  if (!redis) {
    return res.json(fallbackRealtime);
  }

  try {
    const headers = {
      Authorization: `Bearer ${redis.token}`,
      "Content-Type": "application/json",
    };

    const [alertsRes, jamsRes] = await Promise.all([
      fetch(`${redis.url}/get/waze:active_alerts`, { headers }),
      fetch(`${redis.url}/get/waze:active_jams`, { headers }),
    ]);

    const [alertsData, jamsData] = (await Promise.all([
      alertsRes.json(),
      jamsRes.json(),
    ])) as any[];

    const rawAlerts = alertsData.result ? JSON.parse(alertsData.result) : [];
    const rawJams = jamsData.result ? JSON.parse(jamsData.result) : [];

    const features: any[] = [];

    // Transform Waze active alerts
    for (const alert of rawAlerts) {
      const street = alert.street || "";
      const lat = Number(alert.latitude);
      const lon = Number(alert.longitude);
      const type = (alert.type || "HAZARD").toUpperCase();
      
      // Skip JAM point alerts to prevent red dots on top of traffic lines
      if (type === "JAM") continue;

      if (alert.longitude !== undefined && alert.latitude !== undefined && isNlexCorridor(street) && lat >= 14.63) {
        features.push({
          type: "Feature",
          properties: {
            feature_type: "alert",
            uuid: alert.uuid,
            street,
            city: alert.city || "",
            report_description: alert.report_description || "",
            reliability: alert.reliability || 0,
            confidence: alert.confidence || 0,
            type,
            subtype: alert.subtype || "",
            first_seen_at: alert.first_seen_at || "",
            last_seen_at: alert.last_seen_at || "",
          },
          geometry: {
            type: "Point",
            coordinates: [lon, lat],
          },
        });
      }
    }

    // Transform Waze active jams
    for (const jam of rawJams) {
      const street = jam.street || "";
      if (isNlexCorridor(street)) {
        const coords = parseWktLineString(jam.polyline);
        const isNlexBounds = coords.some(c => c[1] >= 14.63);
        if (coords.length >= 2 && isNlexBounds) {
          features.push({
            type: "Feature",
            properties: {
              feature_type: "jam",
              uuid: jam.uuid,
              street,
              city: jam.city || "",
              level: Number(jam.level) || 1,
              speed: Number(jam.speed_kmh) || 0,
              length_meters: Number(jam.length_meters) || 0,
              delay_seconds: Number(jam.delay_seconds) || 0,
              first_seen_at: jam.first_seen_at || "",
              last_seen_at: jam.last_seen_at || "",
            },
            geometry: {
              type: "LineString",
              coordinates: coords,
            },
          });
        }
      }
    }

    res.json({
      type: "FeatureCollection",
      features,
    });
  } catch (error) {
    console.error("Failed to fetch Waze data from Upstash Redis in Backend:", error);
    res.json(fallbackRealtime);
  }
};

// [DEV-02] GET /api/v1/map-comparison/forecast?hours=1
// Predicted congestion per corridor segment, from gold.ml_predictive_congestion.
export const getMapForecast = async (req: Request, res: Response) => {
  const parsed = ForecastHorizonSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: "hours must be an integer between 1 and 12" });
  }

  const features = await getForecastCongestionFromDb(parsed.data.hours);

  // Only fall back when the database is unreachable. An empty result is a real
  // answer — the pipeline has no prediction for that horizon — and must not be
  // dressed up as sample data.
  if (features === null) {
    return res.json(fallbackForecast);
  }

  res.json({ type: "FeatureCollection", features });
};

// [DEV-04] GET /api/v1/map-comparison/exits
export const searchExits = async (req: Request, res: Response) => {
  const query = ExitSearchSchema.safeParse(req.query);
  if (!query.success) return res.status(400).json({ success: false, error: "Invalid query" });

  // Empty query = the full corridor list, ordered Balintawak -> Sta. Ines.
  const dbRows = await searchExitsInDb(query.data.query);
  if (dbRows) {
    return res.json({ success: true, source: "database", data: dbRows });
  }

  res.status(503).json({ success: false, message: "Exit list unavailable: database not reachable" });
};

