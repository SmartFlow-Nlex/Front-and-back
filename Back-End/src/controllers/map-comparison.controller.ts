import type { Request, Response } from "express";
import { searchExitsInDb } from "../services/map-comparison.service.js";
import { ExitSearchSchema } from "../validators/map-comparison.validator.js";

const REDIS_REST_URL = process.env.REDIS_REST_URL || "https://united-mayfly-138714.upstash.io";
const REDIS_REST_TOKEN = process.env.REDIS_REST_TOKEN || "gQAAAAAAAh3aAAIgcDFhYjk2NjA4N2FiNDQ0YjlmYjVkOGZlOTliNGRkZDMyYw";

const fallbackRealtime = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {
        feature_type: "jam",
        level: 3,
        speed: 42,
        street: "NLEX Balintawak",
        city: "Caloocan",
        delay_seconds: 180,
      },
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
    {
      type: "Feature",
      properties: {
        feature_type: "alert",
        type: "ACCIDENT",
        subtype: "ACCIDENT_MINOR",
        street: "NLEX Bocaue",
        city: "Bocaue",
        report_description: "Minor collision on northbound lane. Drive carefully.",
        reliability: 6,
        confidence: 4,
      },
      geometry: {
        type: "Point",
        coordinates: [121.0172, 14.728],
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

// [DEV-01, DEV-03] GET /api/v1/map-comparison/real-time
export const getMapRealtime = async (_req: Request, res: Response) => {
  try {
    const headers = {
      Authorization: `Bearer ${REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    };

    const [alertsRes, jamsRes] = await Promise.all([
      fetch(`${REDIS_REST_URL.replace(/\/$/, "")}/get/waze:active_alerts`, { headers }),
      fetch(`${REDIS_REST_URL.replace(/\/$/, "")}/get/waze:active_jams`, { headers }),
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
      if (alert.longitude !== undefined && alert.latitude !== undefined) {
        features.push({
          type: "Feature",
          properties: {
            feature_type: "alert",
            uuid: alert.uuid,
            street: alert.street || "",
            city: alert.city || "",
            report_description: alert.report_description || "",
            reliability: alert.reliability || 0,
            confidence: alert.confidence || 0,
            type: (alert.type || "HAZARD").toUpperCase(),
            subtype: alert.subtype || "",
            first_seen_at: alert.first_seen_at || "",
            last_seen_at: alert.last_seen_at || "",
          },
          geometry: {
            type: "Point",
            coordinates: [Number(alert.longitude), Number(alert.latitude)],
          },
        });
      }
    }

    // Transform Waze active jams
    for (const jam of rawJams) {
      const coords = parseWktLineString(jam.polyline);
      if (coords.length >= 2) {
        features.push({
          type: "Feature",
          properties: {
            feature_type: "jam",
            uuid: jam.uuid,
            street: jam.street || "",
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

    if (features.length === 0) {
      return res.json(fallbackRealtime);
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

// [DEV-02] GET /api/v1/map-comparison/forecast
export const getMapForecast = async (_req: Request, res: Response) => {
  res.json({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { congestion_score: 0.78, horizon: "2h", segment_id: "NLEX Balintawak" },
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
  });
};

// [DEV-04] GET /api/v1/map-comparison/exits
export const searchExits = async (req: Request, res: Response) => {
  const query = ExitSearchSchema.safeParse(req.query);
  if (!query.success) return res.status(400).json({ success: false, error: "Missing query" });

  const dbRows = await searchExitsInDb(query.data.query);
  if (dbRows) {
    return res.json({ success: true, source: "database", data: dbRows });
  }

  res.json({ success: true, source: "mock", data: [{ exit: "Balintawak" }] });
};

