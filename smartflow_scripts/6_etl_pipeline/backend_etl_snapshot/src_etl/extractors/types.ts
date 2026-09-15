/**
 * ETL Extractor Interface — Unified contract for all data sources
 * Every data source (file upload, API, streaming) implements this interface
 * so they all feed into the shared ETL core.
 */
import type { RawRow } from "../parser.js";

export type SourceType = "file_upload" | "api_weather" | "api_emissions" | "api_waze" | "api_events";

export interface ExtractionResult {
  source: SourceType;
  sourceName: string;         // e.g. "OpenWeather API", "traffic_data_2025.csv"
  rows: RawRow[];
  headers: string[];
  extractionErrors: string[];
  metadata: Record<string, any>;
}
