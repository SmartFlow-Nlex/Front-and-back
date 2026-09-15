/**
 * Extractors — Barrel Export
 * All data source extractors in one place.
 */
export { extractFromFile } from "./file.extractor.js";
export { extractFromWeatherApi } from "./weather.extractor.js";
export { extractFromClimatiqApi } from "./emissions.extractor.js";
export { extractFromWazeJams, extractFromWazeAlerts, extractFromWazeHistorical } from "./waze.extractor.js";
export { extractFromEvents } from "./events.extractor.js";
export type { SourceType, ExtractionResult } from "./types.js";
