/**
 * Weather Extractor — Routes OpenWeather API data through the ETL pipeline
 * Source Layer: Third-Party API → Weather API
 * 
 * The OpenWeather API is already configured to fetch data scoped to NLEX
 * corridor coordinates (lat: 14.75, lon: 120.95). This extractor normalizes
 * the API response into RawRow format so it passes through the shared
 * Validation Gates (corridor check, dedup, schema conformity).
 */
import type { RawRow } from "../parser.js";
import type { ExtractionResult } from "./types.js";

/**
 * Extract weather/AQI data from an OpenWeather API response payload.
 * Called after the API fetch — this normalizes the response into ETL-compatible rows.
 */
export function extractFromWeatherApi(apiResponse: any): ExtractionResult {
  const errors: string[] = [];
  const rows: RawRow[] = [];

  try {
    // OpenWeather Air Pollution API returns a `list` array
    const dataList = apiResponse?.list ?? apiResponse?.data ?? (Array.isArray(apiResponse) ? apiResponse : [apiResponse]);

    for (const entry of dataList) {
      const components = entry.components ?? entry;
      const row: RawRow = {
        timestamp_utc: entry.dt
          ? new Date(entry.dt * 1000).toISOString()
          : entry.timestamp_utc ?? entry.date ?? new Date().toISOString(),
        aqi: entry.main?.aqi ?? entry.aqi ?? null,
        co: components.co ?? null,
        no: components.no ?? null,
        no2: components.no2 ?? null,
        o3: components.o3 ?? null,
        so2: components.so2 ?? null,
        nh3: components.nh3 ?? null,
        pm2_5: components.pm2_5 ?? null,
        pm10: components.pm10 ?? null,
        data_confidence: "OpenWeather API — NLEX Corridor (14.75°N, 120.95°E)",
      };
      rows.push(row);
    }
  } catch (err: any) {
    errors.push(`Weather extraction error: ${err.message}`);
  }

  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];

  return {
    source: "api_weather",
    sourceName: "OpenWeather Air Pollution API",
    rows,
    headers,
    extractionErrors: errors,
    metadata: {
      apiProvider: "OpenWeather",
      endpoint: "/air_pollution",
      nlexCoordinates: { lat: 14.75, lon: 120.95 },
      totalRows: rows.length,
    },
  };
}
