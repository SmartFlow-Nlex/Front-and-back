/**
 * ETL Classifier — Auto-detects the dataset type by analyzing column headers
 */
import type { RawRow } from "./parser.js";

export type DatasetType =
  | "traffic_volume"
  | "road_crash"
  | "stalled_vehicle"
  | "motorcycle_crash"
  | "emissions"
  | "accident_data"
  | "breakdown_data"
  | "unknown";

export interface ClassifyResult {
  type: DatasetType;
  confidence: number; // 0-1
  reason: string;
}

// Column signature patterns for each dataset type
const TRAFFIC_SIGNALS = ["toll_plaza", "plaza", "vehicle_class", "direction", "h00", "h01", "h02", "h03"];
const ROAD_CRASH_SIGNALS = ["cause_of_accident", "type_of_accident", "no_of_vehicles_involved", "injuries_male", "fatalities_male"];
const STALLED_SIGNALS = ["vehicle_cause", "assistance_rendered", "entry_point", "driver_gender"];
const MOTORCYCLE_SIGNALS = ["cause_of_accident", "type_of_accident", "rider"];
const EMISSION_SIGNALS = ["co2_grams", "co_grams", "no2_grams", "pm25_grams", "pm10_grams", "methodology_tier"];
const EMISSION_AQI_SIGNALS = ["aqi", "co", "no2", "o3", "so2", "pm2_5", "pm10"];
// Header normalization lowercases and strips separators but does NOT split
// camelCase, so "EventNumber"/"StartKM"/"TypeOfEvent" arrive as a single
// run-together token ("eventnumber"/"startkm"/"typeofevent") — these signals
// are written against that exact normalized form, not a guessed snake_case.
const ACCIDENT_DATA_SIGNALS = ["typeofevent", "numberofinjured", "numberoffatality", "blockagecleared", "sitecleared", "damagetoproperty"];
const BREAKDOWN_DATA_SIGNALS = ["sloop", "platenumber", "vehicleclass", "troubledescription", "deployments", "typeofvehicle"];

function countMatches(headers: string[], signals: string[]): number {
  const headerSet = new Set(headers);
  return signals.filter((s) => headerSet.has(s)).length;
}

/**
 * Classify a dataset based on its column headers
 */
export function classifyDataset(headers: string[], sampleRows: RawRow[]): ClassifyResult {
  const h = headers.map((s) => s.toLowerCase().trim());

  // Score each type
  const scores: { type: DatasetType; score: number; total: number }[] = [
    { type: "traffic_volume", score: countMatches(h, TRAFFIC_SIGNALS), total: TRAFFIC_SIGNALS.length },
    { type: "road_crash", score: countMatches(h, ROAD_CRASH_SIGNALS), total: ROAD_CRASH_SIGNALS.length },
    { type: "stalled_vehicle", score: countMatches(h, STALLED_SIGNALS), total: STALLED_SIGNALS.length },
    { type: "emissions", score: countMatches(h, EMISSION_SIGNALS), total: EMISSION_SIGNALS.length },
    { type: "accident_data", score: countMatches(h, ACCIDENT_DATA_SIGNALS), total: ACCIDENT_DATA_SIGNALS.length },
    { type: "breakdown_data", score: countMatches(h, BREAKDOWN_DATA_SIGNALS), total: BREAKDOWN_DATA_SIGNALS.length },
  ];

  // Check for AQI-based emissions (OpenWeather style)
  const aqiScore = countMatches(h, EMISSION_AQI_SIGNALS);
  if (aqiScore >= 4) {
    scores.push({ type: "emissions", score: aqiScore, total: EMISSION_AQI_SIGNALS.length });
  }

  // Check for motorcycle crash (subset of road crash but with rider columns)
  const motorcycleScore = countMatches(h, MOTORCYCLE_SIGNALS);
  if (motorcycleScore >= 2 && h.some((col) => col.includes("rider") || col.includes("motorcycle"))) {
    scores.push({ type: "motorcycle_crash", score: motorcycleScore + 1, total: MOTORCYCLE_SIGNALS.length });
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];

  if (best.score === 0) {
    return {
      type: "unknown",
      confidence: 0,
      reason: `Could not match any known dataset type. Columns found: [${h.join(", ")}]`,
    };
  }

  // Minimum threshold: at least 2 matching columns
  if (best.score < 2) {
    return {
      type: "unknown",
      confidence: best.score / best.total,
      reason: `Only ${best.score} column(s) matched '${best.type}'. Need at least 2 for classification. Columns: [${h.join(", ")}]`,
    };
  }

  const confidence = Math.min(best.score / best.total, 1);

  return {
    type: best.type,
    confidence,
    reason: `Detected '${best.type}' with ${best.score}/${best.total} matching columns (${(confidence * 100).toFixed(0)}% confidence).`,
  };
}
