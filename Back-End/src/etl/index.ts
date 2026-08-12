/**
 * ETL Pipeline — Unified Orchestrator
 * 
 * This is the single entry point for ALL data flowing into SmartFlow.
 * Whether the data comes from a manual file upload, a live API call,
 * or a real-time stream, it ALL passes through the same pipeline:
 * 
 *   Source → Extractor → Classifier → Cleaner → Transformer → Loader
 *               ↑              ↑            ↑           ↑          ↑
 *          (Validation    (Validation   (Validation  (Validation  (Validation
 *           Gate 1)        Gate 2)       Gate 3)      Gate 4)      Gate 5)
 *
 * Architecture: Medallion (Bronze → Silver → Gold)
 * Sources: File Upload | OpenWeather API | Climatiq API | Waze Partner Hub | Events Scraper
 */
import { parseFile, type ParseResult } from "./parser.js";
import { classifyDataset, type ClassifyResult, type DatasetType } from "./classifier.js";
import { cleanData, type CleanResult } from "./cleaner.js";
import { transformData, type TransformResult } from "./transformer.js";
import { loadData, type LoadResult } from "./loader.js";
import type { ExtractionResult, SourceType } from "./extractors/types.js";

export interface PipelineResult {
  success: boolean;
  filename: string;
  fileFormat: string;
  source: SourceType;
  datasetType: DatasetType;
  classification: ClassifyResult;
  totalRowsParsed: number;
  rowsAccepted: number;
  rowsRejected: number;
  rowsInserted: number;
  rowsSkippedTransform: number;
  rejectedSample: { row: Record<string, any>; reason: string }[];
  loadErrors: string[];
  parseErrors: string[];
  warnings: string[];
  durationMs: number;
  pipelineGates: PipelineGateLog[];
}

/** Logs which validation gates the data passed through */
export interface PipelineGateLog {
  gate: string;
  passed: boolean;
  details: string;
}

// ── PIPELINE: File Upload ────────────────────────────────────────────

/**
 * Run the full ETL pipeline on a manually uploaded file.
 * Source Layer → Extract Layer → Transform Layer → Load & Data Warehouse Layer
 */
export async function runPipeline(filePath: string, originalFilename: string): Promise<PipelineResult> {
  const start = Date.now();
  const gates: PipelineGateLog[] = [];

  // ── Validation Gate 1: Source Availability ──
  const parsed: ParseResult = parseFile(filePath, originalFilename);
  gates.push({
    gate: "Gate 1 — Source Availability & Schema Check",
    passed: parsed.parseErrors.length === 0 && parsed.rows.length > 0,
    details: parsed.parseErrors.length > 0
      ? `Parse errors: ${parsed.parseErrors.join("; ")}`
      : `Successfully parsed ${parsed.rows.length} rows from ${parsed.detectedFormat} file.`,
  });

  if (parsed.parseErrors.length > 0 || parsed.rows.length === 0) {
    return buildFailResult(originalFilename, parsed.detectedFormat, "file_upload", "unknown", gates, parsed.parseErrors, start);
  }

  // Continue through shared core
  return runSharedPipeline({
    source: "file_upload",
    sourceName: originalFilename,
    rows: parsed.rows,
    headers: parsed.headers,
    extractionErrors: parsed.parseErrors,
    metadata: { detectedFormat: parsed.detectedFormat },
  }, gates, start);
}

// ── PIPELINE: API Sources ────────────────────────────────────────────

/**
 * Run the ETL pipeline on data extracted from any API source.
 * This is the unified entry point for OpenWeather, Climatiq, Waze, and Events data.
 * The data has already been extracted by the source-specific extractor —
 * this function runs it through the shared Validation Gates 2–4.
 */
export async function runApiPipeline(extraction: ExtractionResult): Promise<PipelineResult> {
  const start = Date.now();
  const gates: PipelineGateLog[] = [];

  // ── Validation Gate 1: Source Availability ──
  gates.push({
    gate: "Gate 1 — Source Availability & Schema Check",
    passed: extraction.extractionErrors.length === 0 && extraction.rows.length > 0,
    details: extraction.extractionErrors.length > 0
      ? `Extraction errors: ${extraction.extractionErrors.join("; ")}`
      : `Successfully extracted ${extraction.rows.length} rows from ${extraction.sourceName}.`,
  });

  if (extraction.extractionErrors.length > 0 || extraction.rows.length === 0) {
    return buildFailResult(
      extraction.sourceName, "api", extraction.source, "unknown",
      gates, extraction.extractionErrors, start
    );
  }

  return runSharedPipeline(extraction, gates, start);
}

// ── SHARED CORE PIPELINE ─────────────────────────────────────────────

/**
 * The shared ETL core that ALL sources converge into.
 * Runs Validation Gates 2–4, then Transform and Load.
 */
async function runSharedPipeline(
  extraction: ExtractionResult,
  gates: PipelineGateLog[],
  start: number
): Promise<PipelineResult> {

  // ── Validation Gate 2: Field Completeness & Data Type Conformity ──
  const classification: ClassifyResult = classifyDataset(extraction.headers, extraction.rows.slice(0, 5));
  gates.push({
    gate: "Gate 2 — Field Completeness & Data Type Conformity",
    passed: classification.type !== "unknown",
    details: classification.reason,
  });

  if (classification.type === "unknown") {
    return buildFailResult(
      extraction.sourceName,
      extraction.metadata?.detectedFormat ?? "api",
      extraction.source,
      "unknown",
      gates,
      [classification.reason],
      start
    );
  }

  // ── Validation Gate 3: NLEX Corridor Filter & Referential Integrity ──
  const cleaned: CleanResult = cleanData(extraction.rows, classification.type);
  gates.push({
    gate: "Gate 3 — NLEX Corridor Filter & Referential Integrity",
    passed: cleaned.accepted.length > 0,
    details: `Accepted: ${cleaned.accepted.length} | Rejected: ${cleaned.rejected.length} (non-NLEX or invalid data). ${cleaned.warnings.join("; ")}`,
  });

  // ── Validation Gate 4: Schema Transformation & Business Rules ──
  const transformed: TransformResult = transformData(cleaned.accepted, classification.type);
  gates.push({
    gate: "Gate 4 — Schema Transformation & Business Rule Enforcement",
    passed: transformed.rows.length > 0,
    details: `Transformed ${transformed.rows.length} rows for table '${transformed.tableName}'. Skipped: ${transformed.skipped}.`,
  });

  // ── Load into Data Warehouse (Silver Layer) ──
  const loaded: LoadResult = await loadData(transformed);
  gates.push({
    gate: "Load — Silver Layer (Data Warehouse)",
    passed: loaded.errors.length === 0 && loaded.rowsInserted > 0,
    details: `Inserted ${loaded.rowsInserted} rows into '${loaded.tableName}' in ${loaded.durationMs}ms.`,
  });

  return {
    success: loaded.errors.length === 0 && loaded.rowsInserted > 0,
    filename: extraction.sourceName,
    fileFormat: extraction.metadata?.detectedFormat ?? "api",
    source: extraction.source,
    datasetType: classification.type,
    classification,
    totalRowsParsed: extraction.rows.length,
    rowsAccepted: cleaned.accepted.length,
    rowsRejected: cleaned.rejected.length,
    rowsInserted: loaded.rowsInserted,
    rowsSkippedTransform: transformed.skipped,
    rejectedSample: cleaned.rejected.slice(0, 10),
    loadErrors: loaded.errors,
    parseErrors: extraction.extractionErrors,
    warnings: cleaned.warnings,
    durationMs: Date.now() - start,
    pipelineGates: gates,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildFailResult(
  filename: string,
  format: string,
  source: SourceType,
  datasetType: DatasetType,
  gates: PipelineGateLog[],
  errors: string[],
  start: number
): PipelineResult {
  return {
    success: false,
    filename,
    fileFormat: format,
    source,
    datasetType,
    classification: { type: "unknown", confidence: 0, reason: "Pipeline halted at validation gate." },
    totalRowsParsed: 0,
    rowsAccepted: 0,
    rowsRejected: 0,
    rowsInserted: 0,
    rowsSkippedTransform: 0,
    rejectedSample: [],
    loadErrors: [],
    parseErrors: errors,
    warnings: [],
    durationMs: Date.now() - start,
    pipelineGates: gates,
  };
}

// Re-export types for convenience
export type { DatasetType, ClassifyResult, CleanResult, TransformResult, LoadResult };
export type { SourceType, ExtractionResult };
