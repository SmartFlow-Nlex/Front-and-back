import type { Request, Response } from "express";
import { TrafficQuerySchema, IncidentQuerySchema, ForecastQuerySchema } from "../validators/traffic.validator.js";
import { getTrafficVolumesFromDb, getDirectionalFlowFromDb, getVehicleClassDistributionFromDb } from "../services/traffic.service.js";

// [REQ-01] GET /api/v1/traffic/realtime
export const getRealtimeTraffic = async (req: Request, res: Response) => {
  const query = TrafficQuerySchema.parse(req.query);
  
  // Try fetching from the PostgreSQL DB
  const dbRows = await getTrafficVolumesFromDb(query.direction);
  
  if (dbRows && dbRows.length > 0) {
    // Map DB rows to response schema
    const mappedData = dbRows.map(row => ({
      segmentId: row.segmentId,
      name: `NLEX Segment ${row.segmentId}`, // Or join with a segments table
      direction: row.segmentId.startsWith("NB") ? "NB" : "SB",
      status: row.avgSpeedKmh < 30 ? "Heavy" : row.avgSpeedKmh < 60 ? "Moderate" : "Light",
      avgSpeedKmh: row.avgSpeedKmh,
      volumePerMin: row.volumePerMin,
      lastUpdated: new Date().toISOString()
    }));
    return res.json({ success: true, source: "database", data: mappedData });
  }

  // Graceful Mock Fallback if DB is unavailable
  const mockData = [
    { segmentId: "NB-01", name: "Balintawak - Mindanao Ave", direction: "NB", status: "Moderate", avgSpeedKmh: 65, volumePerMin: 42, lastUpdated: new Date().toISOString() },
    { segmentId: "SB-01", name: "Mindanao Ave - Balintawak", direction: "SB", status: "Light", avgSpeedKmh: 80, volumePerMin: 25, lastUpdated: new Date().toISOString() },
    { segmentId: "NB-02", name: "Mindanao Ave - Valenzuela", direction: "NB", status: "Heavy", avgSpeedKmh: 20, volumePerMin: 85, lastUpdated: new Date().toISOString() }
  ];

  const filtered = query.direction ? mockData.filter(d => d.direction === query.direction) : mockData;
  res.json({ success: true, source: "mock", data: filtered });
};

// [REQ-01] GET /api/v1/traffic/incidents
export const getIncidents = async (req: Request, res: Response) => {
  const _query = IncidentQuerySchema.parse(req.query);
  
  // Mock data representing Waze Reports
  const mockData = [
    { incidentId: "INC-992", type: "Traffic Jam", kmMarker: 14.5, direction: "NB", severity: "High", reportedAt: new Date().toISOString() },
    { incidentId: "INC-993", type: "Construction", kmMarker: 26.2, direction: "SB", severity: "Medium", reportedAt: new Date().toISOString() },
    { incidentId: "INC-994", type: "Accident", kmMarker: 12.0, direction: "NB", severity: "Critical", reportedAt: new Date().toISOString() }
  ];

  res.json({ success: true, data: mockData });
};

// [REQ-01] GET /api/v1/traffic/forecast
export const getForecast = async (req: Request, res: Response) => {
  const query = ForecastQuerySchema.parse(req.query);
  
  // Mock data for AI Predictions
  const mockData = {
    horizon: query.horizon,
    mlConfidence: 0.89,
    segments: [
      { segmentId: "NB-01", predictedCongestion: "Medium", estimatedTravelTimeMins: 12 },
      { segmentId: "NB-02", predictedCongestion: "High", estimatedTravelTimeMins: 25 }
    ]
  };

  res.json({ success: true, data: mockData });
};

// [REQ-01, DEV-01, DEV-02, DEV-03] GET /api/v1/traffic/volume-adt
export const getVolumeAdt = async (_req: Request, res: Response) => {
  
  // Try fetching from the PostgreSQL DB
  const [flowRows, classRows] = await Promise.all([
    getDirectionalFlowFromDb(),
    getVehicleClassDistributionFromDb()
  ]);

  if (flowRows && classRows && flowRows.length > 0) {
    let totalAdt = 0;
    flowRows.forEach(r => totalAdt += Number(r.total));

    const classDistribution = { class1: 0, class2: 0, class3: 0 };
    classRows.forEach(r => {
      if (r.class_type === 1) classDistribution.class1 = Number(r.count);
      if (r.class_type === 2) classDistribution.class2 = Number(r.count);
      if (r.class_type === 3) classDistribution.class3 = Number(r.count);
    });

    return res.json({ 
      success: true, 
      source: "database",
      data: {
        date: new Date().toISOString().split('T')[0],
        totalAdt,
        directionalFlow: flowRows,
        classDistribution
      } 
    });
  }

  // Graceful Mock Fallback
  const mockData = {
    date: new Date().toISOString().split('T')[0],
    totalAdt: 350000,
    directionalFlow: [
      { direction: "NB", total: 180000 },
      { direction: "SB", total: 170000 }
    ],
    classDistribution: {
      class1: 280000, // Cars
      class2: 50000,  // Buses/Light Trucks
      class3: 20000   // Heavy Trucks
    }
  };

  res.json({ success: true, source: "mock", data: mockData });
};
