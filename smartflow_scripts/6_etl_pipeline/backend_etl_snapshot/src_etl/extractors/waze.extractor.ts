/**
 * Waze Extractor — Routes Waze Partner Hub data through the ETL pipeline
 * Source Layer: Third-Party Data → Waze Partner Hub (MPTC)
 *
 * Waze data arrives via two channels:
 *   1. Real-time streaming from Upstash Redis (active jams/alerts)
 *   2. Historical batch data from fact_hourly_jams table
 *
 * Both channels are already geo-fenced to the NLEX corridor bounding box.
 * This extractor normalizes the Waze payloads into RawRow format so they
 * pass through the shared Validation Gates (corridor check, dedup).
 */
import type { RawRow } from "../parser.js";
import type { ExtractionResult } from "./types.js";

/**
 * Extract real-time jam data from Waze/Redis streaming payload
 */
export function extractFromWazeJams(jams: any[]): ExtractionResult {
  const errors: string[] = [];
  const rows: RawRow[] = [];

  try {
    for (const jam of jams) {
      const row: RawRow = {
        uuid: jam.uuid ?? null,
        street: jam.street ?? null,
        city: jam.city ?? null,
        level: typeof jam.level === "number" ? jam.level : Number(jam.level) || 1,
        speed_kmh: typeof jam.speed_kmh === "number" ? jam.speed_kmh : Number(jam.speed_kmh) || 0,
        length_meters: typeof jam.length_meters === "number" ? jam.length_meters : Number(jam.length_meters) || 0,
        delay_seconds: typeof jam.delay_seconds === "number" ? jam.delay_seconds : Number(jam.delay_seconds) || 0,
        first_seen_at: jam.first_seen_at ?? null,
        last_seen_at: jam.last_seen_at ?? null,
        polyline: jam.polyline ?? null,
      };
      rows.push(row);
    }
  } catch (err: any) {
    errors.push(`Waze jam extraction error: ${err.message}`);
  }

  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];

  return {
    source: "api_waze",
    sourceName: "Waze Partner Hub — Real-Time Jams (Redis Stream)",
    rows,
    headers,
    extractionErrors: errors,
    metadata: {
      dataProvider: "Waze / MPTC",
      channel: "Upstash Redis Streaming",
      geofence: "NLEX Corridor Bounding Box",
      totalRows: rows.length,
    },
  };
}

/**
 * Extract real-time alert data from Waze/Redis streaming payload
 */
export function extractFromWazeAlerts(alerts: any[]): ExtractionResult {
  const errors: string[] = [];
  const rows: RawRow[] = [];

  try {
    for (const alert of alerts) {
      const row: RawRow = {
        uuid: alert.uuid ?? null,
        type: alert.type ?? "HAZARD",
        subtype: alert.subtype ?? null,
        street: alert.street ?? null,
        city: alert.city ?? null,
        latitude: typeof alert.latitude === "number" ? alert.latitude : Number(alert.latitude) || null,
        longitude: typeof alert.longitude === "number" ? alert.longitude : Number(alert.longitude) || null,
        report_description: alert.report_description ?? null,
        reliability: typeof alert.reliability === "number" ? alert.reliability : Number(alert.reliability) || 0,
        confidence: typeof alert.confidence === "number" ? alert.confidence : Number(alert.confidence) || 0,
        first_seen_at: alert.first_seen_at ?? null,
        last_seen_at: alert.last_seen_at ?? null,
      };
      rows.push(row);
    }
  } catch (err: any) {
    errors.push(`Waze alert extraction error: ${err.message}`);
  }

  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];

  return {
    source: "api_waze",
    sourceName: "Waze Partner Hub — Real-Time Alerts (Redis Stream)",
    rows,
    headers,
    extractionErrors: errors,
    metadata: {
      dataProvider: "Waze / MPTC",
      channel: "Upstash Redis Streaming",
      geofence: "NLEX Corridor Bounding Box",
      totalRows: rows.length,
    },
  };
}

/**
 * Extract historical jam data from the fact_hourly_jams batch load
 */
export function extractFromWazeHistorical(batchRows: any[]): ExtractionResult {
  const errors: string[] = [];
  const rows: RawRow[] = [];

  try {
    for (const entry of batchRows) {
      const row: RawRow = {};
      for (const [key, val] of Object.entries(entry)) {
        row[key.toLowerCase()] = val === undefined ? null : (val as any);
      }
      rows.push(row);
    }
  } catch (err: any) {
    errors.push(`Waze historical extraction error: ${err.message}`);
  }

  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];

  return {
    source: "api_waze",
    sourceName: "Waze Partner Hub — Historical Batch (fact_hourly_jams)",
    rows,
    headers,
    extractionErrors: errors,
    metadata: {
      dataProvider: "Waze / MPTC",
      channel: "Historical CSV Batch Import",
      geofence: "NLEX Corridor — Pre-filtered during ingestion",
      totalRows: rows.length,
    },
  };
}
