import type { Request, Response } from "express";
import { TrafficQuerySchema, ForecastQuerySchema } from "../validators/traffic.validator.js";
import {
  hasTrafficData,
  getTrafficSummary,
  getADT,
  getDirectionalFlow,
  getVehicleClassDistribution,
  getExitDistribution,
  getHourlyPattern,
  getMonthlyADT,
} from "../services/traffic.service.js";

// ─────────────────────────────────────────────────────────
// GET /api/traffic/summary — Full traffic analytics summary
// ─────────────────────────────────────────────────────────
export const getTrafficOverview = async (_req: Request, res: Response) => {
  const hasData = await hasTrafficData();

  if (hasData) {
    const summary = await getTrafficSummary();
    return res.json({ success: true, source: "database", data: summary });
  }

  // Mock fallback when no data uploaded yet
  res.json({
    success: true,
    source: "mock",
    noData: true,
    message: "No traffic data uploaded yet. Upload traffic_volume_synthetic.csv via Data Management.",
    data: {
      adt: { adt: 125847, min_daily: 98000, max_daily: 165000, total_days: 0 },
      directional: [
        { direction: "NB", total: "180000" },
        { direction: "SB", total: "170000" },
      ],
      vehicleClass: [
        { vehicle_class: "Class 1", total: "280000" },
        { vehicle_class: "Class 2", total: "50000" },
        { vehicle_class: "Class 3", total: "20000" },
      ],
      exits: [
        { toll_plaza: "Balintawak", total: "320000" },
        { toll_plaza: "Bocaue", total: "210000" },
        { toll_plaza: "Sta. Rita", total: "160000" },
        { toll_plaza: "San Simon", total: "130000" },
        { toll_plaza: "Dau", total: "110000" },
      ],
      hourly: Array.from({ length: 24 }, (_, h) => ({
        hour: `${h.toString().padStart(2, "0")}:00`,
        avgVolume: Math.round(2000 + 3000 * Math.sin(((h - 6) / 24) * Math.PI * 2)),
      })),
      monthly: [
        { month: "2022-01", adt: 108000 }, { month: "2022-02", adt: 112000 },
        { month: "2022-03", adt: 115000 }, { month: "2022-04", adt: 118000 },
        { month: "2022-05", adt: 121000 }, { month: "2022-06", adt: 124000 },
      ],
    },
  });
};

// ─────────────────────────────────────────────────────────
// GET /api/traffic/volume-adt — ADT + directional + class
// ─────────────────────────────────────────────────────────
export const getVolumeAdt = async (_req: Request, res: Response) => {
  const [adt, directional, vehicleClass] = await Promise.all([
    getADT(),
    getDirectionalFlow(),
    getVehicleClassDistribution(),
  ]);

  if (adt) {
    return res.json({
      success: true,
      source: "database",
      data: {
        date: new Date().toISOString().split("T")[0],
        totalAdt: Number(adt.adt),
        directionalFlow: directional,
        classDistribution: vehicleClass,
      },
    });
  }

  // Mock fallback
  res.json({
    success: true,
    source: "mock",
    data: {
      date: new Date().toISOString().split("T")[0],
      totalAdt: 350000,
      directionalFlow: [
        { direction: "NB", total: 180000 },
        { direction: "SB", total: 170000 },
      ],
      classDistribution: [
        { vehicle_class: "Class 1", total: 280000 },
        { vehicle_class: "Class 2", total: 50000 },
        { vehicle_class: "Class 3", total: 20000 },
      ],
    },
  });
};

// ─────────────────────────────────────────────────────────
// GET /api/traffic/realtime — Segment-level traffic data
// ─────────────────────────────────────────────────────────
export const getRealtimeTraffic = async (req: Request, res: Response) => {
  const query = TrafficQuerySchema.parse(req.query);

  // For real-time data, use the latest traffic volume records
  const exits = await getExitDistribution();
  if (exits && exits.length > 0) {
    const segments = exits.map((exit: any, i: number) => ({
      segmentId: `SEG-${i + 1}`,
      name: exit.toll_plaza,
      direction: i % 2 === 0 ? "NB" : "SB",
      status: Number(exit.total) > 200000 ? "Heavy" : Number(exit.total) > 100000 ? "Moderate" : "Light",
      totalVolume: Number(exit.total),
      lastUpdated: new Date().toISOString(),
    }));

    const filtered = query.direction
      ? segments.filter((s: any) => s.direction === query.direction)
      : segments;

    return res.json({ success: true, source: "database", data: filtered });
  }

  // Mock fallback
  const mockData = [
    { segmentId: "NB-01", name: "Balintawak - Mindanao Ave", direction: "NB", status: "Moderate", avgSpeedKmh: 65, volumePerMin: 42, lastUpdated: new Date().toISOString() },
    { segmentId: "SB-01", name: "Mindanao Ave - Balintawak", direction: "SB", status: "Light", avgSpeedKmh: 80, volumePerMin: 25, lastUpdated: new Date().toISOString() },
    { segmentId: "NB-02", name: "Mindanao Ave - Valenzuela", direction: "NB", status: "Heavy", avgSpeedKmh: 20, volumePerMin: 85, lastUpdated: new Date().toISOString() },
  ];
  const filtered = query.direction ? mockData.filter((d) => d.direction === query.direction) : mockData;
  res.json({ success: true, source: "mock", data: filtered });
};

// ─────────────────────────────────────────────────────────
// GET /api/traffic/incidents — (kept for backward compat)
// ─────────────────────────────────────────────────────────
export const getIncidents = async (_req: Request, res: Response) => {
  const mockData = [
    { incidentId: "INC-992", type: "Traffic Jam", kmMarker: 14.5, direction: "NB", severity: "High", reportedAt: new Date().toISOString() },
    { incidentId: "INC-993", type: "Construction", kmMarker: 26.2, direction: "SB", severity: "Medium", reportedAt: new Date().toISOString() },
  ];
  res.json({ success: true, data: mockData });
};

// ─────────────────────────────────────────────────────────
// GET /api/traffic/forecast
// ─────────────────────────────────────────────────────────
export const getForecast = async (req: Request, res: Response) => {
  const query = ForecastQuerySchema.parse(req.query);

  const mockData = {
    horizon: query.horizon,
    mlConfidence: 0.89,
    segments: [
      { segmentId: "NB-01", predictedCongestion: "Medium", estimatedTravelTimeMins: 12 },
      { segmentId: "NB-02", predictedCongestion: "High", estimatedTravelTimeMins: 25 },
    ],
  };

  res.json({ success: true, data: mockData });
};
