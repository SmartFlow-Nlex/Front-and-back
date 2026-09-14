/**
 * Emissions Extractor — Routes Climatiq API data through the ETL pipeline
 * Source Layer: Third-Party API → Climatiq (IPCC Tier 2 Emission Factors)
 *
 * Climatiq is called on-demand with NLEX traffic volumes that are already
 * corridor-scoped. This extractor normalizes the computed emission results
 * into RawRow format so they flow through the shared Validation Gates.
 */
import type { RawRow } from "../parser.js";
import type { ExtractionResult } from "./types.js";

export interface ClimatiqComputedRow {
  timestamp_utc: string;
  direction: string;
  vehicle_class: number;
  volume: number;
  segment_distance_km: number;
  co2_grams: number;
  co_grams: number;
  no2_grams: number;
  pm25_grams: number;
  pm10_grams: number;
  so2_grams: number;
  methodology_tier: string;
}

/**
 * Extract emissions data from Climatiq computation results.
 * Called after the Climatiq API computes emission factors — this normalizes
 * the results into ETL-compatible rows for pipeline processing.
 */
export function extractFromClimatiqApi(computedRows: ClimatiqComputedRow[]): ExtractionResult {
  const errors: string[] = [];
  const rows: RawRow[] = [];

  try {
    for (const entry of computedRows) {
      const row: RawRow = {
        timestamp_utc: entry.timestamp_utc,
        direction: entry.direction ?? "NB",
        vehicle_class: entry.vehicle_class ?? 1,
        volume: entry.volume ?? 0,
        segment_distance_km: entry.segment_distance_km ?? 11.61,
        co2_grams: entry.co2_grams ?? 0,
        co_grams: entry.co_grams ?? 0,
        no2_grams: entry.no2_grams ?? 0,
        pm25_grams: entry.pm25_grams ?? 0,
        pm10_grams: entry.pm10_grams ?? 0,
        so2_grams: entry.so2_grams ?? 0,
        methodology_tier: entry.methodology_tier ?? "Climatiq IPCC Tier 2",
      };
      rows.push(row);
    }
  } catch (err: any) {
    errors.push(`Emissions extraction error: ${err.message}`);
  }

  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];

  return {
    source: "api_emissions",
    sourceName: "Climatiq API (IPCC Tier 2)",
    rows,
    headers,
    extractionErrors: errors,
    metadata: {
      apiProvider: "Climatiq",
      methodology: "IPCC Tier 2 Emission Factors",
      activityId: "passenger_vehicle-vehicle_type_car-fuel_source_petrol",
      region: "GLOBAL",
      totalRows: rows.length,
    },
  };
}
