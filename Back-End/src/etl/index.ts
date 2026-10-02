/**
 * ETL Pipeline — Unified Orchestrator
 *
 * This is the single entry point for ALL data flowing into SmartFlow.
 * Whether the data comes from a manual file upload, a live API call,
 * or a real-time stream, it ALL passes through the same pipeline:
 *
 *   Source → Extractor → Classifier → Cleaner → Transformer → Loader → Publish
 *               ↑              ↑            ↑           ↑          ↑
 *          (Validation    (Validation   (Validation  (Validation  (Validation
 *           Gate 1)        Gate 2)       Gate 3)      Gate 4)      Gate 5)
 *
 * Architecture: Medallion (Bronze → Silver → Gold). A load writes bronze and
 * publishes the same rows to the silver tables the dashboards read
 * (publish.ts); hourly toll files go straight to the gold traffic record
 * (toll-hourly.ts). Every load is one transaction, and a "check" runs every
 * step and rolls it back.
 * Sources: File Upload | OpenWeather API | Climatiq API | Waze Partner Hub | Events Scraper
 */
import { parseFile, type ParseResult } from "./parser.js";
import { classifyDataset, type ClassifyResult, type DatasetType } from "./classifier.js";
import { cleanData, recordDay, type CleanResult } from "./cleaner.js";
import { transformData, type TransformResult } from "./transformer.js";
import { loadData, type LoadResult } from "./loader.js";
import type { Published } from "./publish.js";
import type { UploadComparison } from "./compare.js";
import { aggregateTollHourly, loadCutoff, loadTollHourly } from "./toll-hourly.js";
import type { ExtractionResult, SourceType } from "./extractors/types.js";

export interface PipelineResult {
  success: boolean;
  /** True for a check: every step ran, and nothing was kept. */
  dryRun: boolean;
  filename: string;
  fileFormat: string;
  source: SourceType;
  datasetType: DatasetType;
  classification: ClassifyResult;
  totalRowsParsed: number;
  rowsAccepted: number;
  rowsRejected: number;
  /** Rows written: new rows in the destination table. */
  rowsInserted: number;
  /** Rows that replaced an existing record with the same key. */
  rowsUpdated: number;
  /** Rows the warehouse already held: not written twice. */
  rowsAlreadyLoaded: number;
  /** Rows the database refused, with reasons in loadErrors. */
  rowsFailed: number;
  rowsSkippedTransform: number;
  /** The table the upload lands in, and the ones it is published on to. */
  destination: string | null;
  published: Published[];
  /** The file against what the warehouse already holds for the same keys ("is this the right file?"). */
  comparison: UploadComparison | null;
  /** The committed load's undo journal (undo.ts); null for a check or a failed load. */
  undoBatch: number | null;
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

export interface PipelineOptions {
  /** Run every step, then roll the load back. */
  dryRun?: boolean;
}

const n = (v: number) => v.toLocaleString("en-US");
/** "1 row", "2 rows". */
const rows = (v: number) => `${n(v)} ${v === 1 ? "row" : "rows"}`;

// ── PIPELINE: File Upload ────────────────────────────────────────────

/**
 * Run the full ETL pipeline on a manually uploaded file.
 * Source Layer → Extract Layer → Transform Layer → Load & Data Warehouse Layer
 */
export async function runPipeline(filePath: string, originalFilename: string, opts: PipelineOptions = {}): Promise<PipelineResult> {
  const start = Date.now();
  const gates: PipelineGateLog[] = [];

  // ── Validation Gate 1: Source Availability ──
  const parsed: ParseResult = parseFile(filePath, originalFilename);
  gates.push({
    gate: "Gate 1 — Source Availability & Schema Check",
    passed: parsed.parseErrors.length === 0 && parsed.rows.length > 0,
    details: parsed.parseErrors.length > 0
      ? `Parse errors: ${parsed.parseErrors.join("; ")}`
      : `Successfully parsed ${n(parsed.rows.length)} rows from ${parsed.detectedFormat} file.`,
  });

  if (parsed.parseErrors.length > 0 || parsed.rows.length === 0) {
    return buildFailResult(originalFilename, parsed.detectedFormat, "file_upload", "unknown", gates, parsed.parseErrors, start, opts, parsed.rows.length);
  }

  // Continue through shared core
  return runSharedPipeline({
    source: "file_upload",
    sourceName: originalFilename,
    rows: parsed.rows,
    headers: parsed.headers,
    extractionErrors: parsed.parseErrors,
    metadata: { detectedFormat: parsed.detectedFormat },
  }, gates, start, opts);
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
      gates, extraction.extractionErrors, start, {}, extraction.rows.length
    );
  }

  return runSharedPipeline(extraction, gates, start, {});
}

// ── SHARED CORE PIPELINE ─────────────────────────────────────────────

/**
 * The shared ETL core that ALL sources converge into.
 * Runs Validation Gates 2–4, then Transform, Load and Publish.
 */
async function runSharedPipeline(
  extraction: ExtractionResult,
  gates: PipelineGateLog[],
  start: number,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const format = extraction.metadata?.detectedFormat ?? "api";

  // ── Validation Gate 2: Field Completeness & Data Type Conformity ──
  const classification: ClassifyResult = classifyDataset(extraction.headers, extraction.rows.slice(0, 5));
  gates.push({
    gate: "Gate 2 — Field Completeness & Data Type Conformity",
    passed: classification.type !== "unknown",
    details: classification.reason,
  });

  if (classification.type === "unknown") {
    return buildFailResult(extraction.sourceName, format, extraction.source, "unknown", gates, [classification.reason], start, opts, extraction.rows.length);
  }

  // Hourly toll transactions aggregate into the warehouse's traffic record
  // rather than mapping row for row into one table: toll-hourly.ts.
  if (classification.type === "toll_hourly") {
    return runTollHourlyPipeline(extraction, classification, gates, start, opts);
  }

  /* The old wide traffic layout (one column per hour) used to load into
     bronze.nlex_traffic_volume, which no dashboard reads: every traffic page
     and model is built from gold.fact_traffic_hourly. An upload that
     "succeeds" into a table nobody reads is worse than a refusal. */
  if (classification.type === "traffic_volume") {
    const why =
      "Not loaded: this is the old wide traffic layout (a column per hour), which only ever reached bronze.nlex_traffic_volume, " +
      "a table no dashboard reads. The traffic record is built from hourly toll files: one row per entry plaza, exit plaza and hour " +
      "(date, hour, exit_plaza, entry_plaza, entry_plaza_name, class_1, class_2, class_3, total, exit_plaza_name).";
    gates.push({ gate: "Gate 3 — NLEX Corridor Filter & Referential Integrity", passed: false, details: why });
    return buildFailResult(extraction.sourceName, format, extraction.source, classification.type, gates, [why], start, opts, extraction.rows.length);
  }

  // ── Validation Gate 3: NLEX Corridor Filter & Referential Integrity ──
  const cleaned: CleanResult = cleanData(extraction.rows, classification.type);

  /* The corridor record ends on RECORD_END (toll-hourly.ts): a file's rows
     after it are held back, the same rule the traffic record follows, so
     incidents, events and emissions cover the days traffic does. Only for
     uploads: live feeds run on, and air quality is not part of the record. */
  const held: string[] = [];
  if (extraction.source === "file_upload") {
    const cutoff = loadCutoff();
    let late = 0;
    const kept = [];
    for (const row of cleaned.accepted) {
      const day = recordDay(row, classification.type);
      if (day && day > cutoff.date) {
        late++;
        if (cleaned.rejected.length < 5000) {
          cleaned.rejected.push({
            row,
            reason: cutoff.why === "today"
              ? `dated after today (${cutoff.date}): not yet observed`
              : `dated after ${cutoff.date}, where the corridor's record ends`,
          });
        }
      } else kept.push(row);
    }
    cleaned.accepted = kept;
    if (late > 0) {
      held.push(`${rows(late)} dated after ${cutoff.date} held back: ${cutoff.why === "today" ? "that is today" : "the corridor's record ends there"}`);
    }
  }
  const rejectedCount = extraction.rows.length - cleaned.accepted.length;
  gates.push({
    gate: "Gate 3 — NLEX Corridor Filter & Referential Integrity",
    passed: cleaned.accepted.length > 0,
    details: `Accepted: ${n(cleaned.accepted.length)} | Rejected: ${n(rejectedCount)} (non-NLEX, invalid or after the record's end).${[...cleaned.warnings, ...held].length ? " " + [...cleaned.warnings, ...held].join(" ") : ""}`,
  });

  // ── Validation Gate 4: Schema Transformation & Business Rules ──
  const transformed: TransformResult = transformData(cleaned.accepted, classification.type);
  gates.push({
    gate: "Gate 4 — Schema Transformation & Business Rule Enforcement",
    passed: transformed.rows.length > 0,
    details: `Transformed ${n(transformed.rows.length)} rows for '${transformed.tableName}'. Skipped: ${n(transformed.skipped)}.`,
  });

  // ── Load into bronze, publish to silver ──
  const loaded: LoadResult = await loadData(transformed, { dryRun: opts.dryRun, datasetType: classification.type });
  const kept = loaded.committed || (opts.dryRun && loaded.errors.length === 0);
  const pub = loaded.published.map((p) => `${n(p.rows)} published to ${p.table}`);
  const counts = [
    `${rows(loaded.rowsInserted)} new`,
    loaded.rowsUpdated ? `${n(loaded.rowsUpdated)} updated` : null,
    loaded.rowsAlreadyLoaded ? `${n(loaded.rowsAlreadyLoaded)} already in the warehouse` : null,
    loaded.rowsFailed ? `${n(loaded.rowsFailed)} refused by the database` : null,
  ].filter(Boolean).join(", ");
  gates.push({
    gate: opts.dryRun ? "Load — Check only (rolled back, nothing written)" : "Load — Data Warehouse (bronze, then silver)",
    passed: Boolean(kept) && loaded.rowsFailed === 0,
    details: loaded.errors.length
      ? loaded.errors.join(" ")
      : `${opts.dryRun ? "Would write" : "Wrote"} ${counts} in '${loaded.tableName}'${pub.length ? `; ${pub.join("; ")}` : ""} (${(loaded.durationMs / 1000).toFixed(1)} s).`,
  });

  const warnings = [...cleaned.warnings, ...held];
  if (loaded.rowsAlreadyLoaded > 0) {
    warnings.push(`${rows(loaded.rowsAlreadyLoaded)} already in the warehouse (same record key), not written twice.`);
  }
  if (classification.type === "stalled_vehicle" && kept) {
    warnings.push("Stalled vehicles are read directly from public.nlex_stalled_vehicles: no publish step is needed.");
  }

  return {
    success: Boolean(kept) && loaded.errors.length === 0,
    dryRun: Boolean(opts.dryRun),
    filename: extraction.sourceName,
    fileFormat: format,
    source: extraction.source,
    datasetType: classification.type,
    classification,
    totalRowsParsed: extraction.rows.length,
    rowsAccepted: cleaned.accepted.length,
    rowsRejected: rejectedCount,
    rowsInserted: loaded.rowsInserted,
    rowsUpdated: loaded.rowsUpdated,
    rowsAlreadyLoaded: loaded.rowsAlreadyLoaded,
    rowsFailed: loaded.rowsFailed,
    rowsSkippedTransform: transformed.skipped,
    destination: loaded.tableName,
    published: loaded.published,
    comparison: loaded.comparison,
    undoBatch: loaded.undoBatch,
    rejectedSample: cleaned.rejected.slice(0, 10),
    loadErrors: [...loaded.errors, ...loaded.failures],
    parseErrors: extraction.extractionErrors,
    warnings,
    durationMs: Date.now() - start,
    pipelineGates: gates,
  };
}

// ── Hourly toll transactions ─────────────────────────────────────────

/**
 * Gates 3 and 4 and the load for an nlex_traffic_hourly file. Same gates as
 * every other dataset, so the page reads the same; what differs is that the
 * rows are aggregated to the warehouse grain and replace the days they cover
 * in four tables at once (see toll-hourly.ts).
 */
async function runTollHourlyPipeline(
  extraction: ExtractionResult,
  classification: ClassifyResult,
  gates: PipelineGateLog[],
  start: number,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const agg = aggregateTollHourly(extraction.rows);
  const first = agg.dates[0];
  const last = agg.dates[agg.dates.length - 1];
  const format = extraction.metadata?.detectedFormat ?? "csv";

  const held: string[] = [];
  if (agg.heldBack.late > 0 && agg.lateDates) {
    held.push(`${rows(agg.heldBack.late)} dated ${agg.lateDates.first} to ${agg.lateDates.last} (${agg.lateDates.days} days) held back: they are after ${agg.cutoff.date}, ${agg.cutoff.why === "today" ? "today" : "where the corridor's record ends"}`);
  }
  if (agg.heldBack.offCorridorExit > 0) {
    held.push(`${rows(agg.heldBack.offCorridorExit)} whose exit is not one of the 20 NLEX exits (Lingunan) held back, as they were from the 2025 record`);
  }
  if (agg.heldBack.malformed > 0) held.push(`${rows(agg.heldBack.malformed)} malformed, rejected`);
  gates.push({
    gate: "Gate 3 — NLEX Corridor Filter & Referential Integrity",
    passed: agg.rowsAccepted > 0,
    details: agg.rowsAccepted > 0
      ? `Accepted ${n(agg.rowsAccepted)} rows on ${agg.dates.length} days (${first} to ${last}).${held.length ? " " + held.join(". ") + "." : ""}`
      : `No row can be loaded. ${held.join(". ")}.`,
  });
  if (agg.rowsAccepted === 0) {
    return buildFailResult(extraction.sourceName, format, extraction.source, "toll_hourly", gates, held, start, opts, extraction.rows.length);
  }

  gates.push({
    gate: "Gate 4 — Schema Transformation & Business Rule Enforcement",
    passed: agg.fact.size > 0,
    details: `Aggregated to the warehouse grain: ${n(agg.fact.size)} hourly rows by the plaza each trip paid at, ${n(agg.origin.size)} by the plaza it entered. Each plaza-hour in the file replaces the warehouse's figure for it; plazas and hours it does not hold are left alone.`,
  });

  const loaded = await loadTollHourly(agg, { dryRun: opts.dryRun });
  const kept = loaded.committed || (opts.dryRun && loaded.errors.length === 0);
  gates.push({
    gate: opts.dryRun ? "Load — Check only (rolled back, nothing written)" : "Load — Gold Layer (Data Warehouse)",
    passed: Boolean(kept) && loaded.errors.length === 0,
    details: kept
      ? `${opts.dryRun ? "Would write" : "Wrote"} ${n(loaded.factRows)} plaza-hours over ${loaded.days} ${loaded.days === 1 ? "day" : "days"} in ${(loaded.durationMs / 1000).toFixed(0)} s: ${n(loaded.factRows)} rows into gold.fact_traffic_hourly, ${n(loaded.originRows)} into gold.fact_traffic_hourly_origin, ${n(loaded.dailyRows)} into gold.daily_traffic_volume_corrected, ${n(loaded.emissionRows)} into gold.fact_emissions_hourly.${loaded.viewRefreshed ? " Descriptive view refreshed." : ""}`
      : loaded.errors.join(" "),
  });

  const warnings = [...held];
  if (agg.unplacedOrigins > 0) {
    warnings.push(`${n(agg.unplacedOrigins)} rows are in the traffic record but not in the origin table: their entry plaza (Lingunan) is not one of the NLEX exits`);
  }
  if (loaded.committed) {
    warnings.push("The forecasts do not move until the models are retrained: each starts the day after its last training day.");
  }

  return {
    success: Boolean(kept) && loaded.errors.length === 0,
    dryRun: Boolean(opts.dryRun),
    filename: extraction.sourceName,
    fileFormat: format,
    source: extraction.source,
    datasetType: "toll_hourly",
    classification,
    totalRowsParsed: extraction.rows.length,
    rowsAccepted: agg.rowsAccepted,
    rowsRejected: agg.rowsRejected,
    rowsInserted: loaded.factRows,
    rowsUpdated: 0,
    rowsAlreadyLoaded: 0,
    rowsFailed: 0,
    rowsSkippedTransform: 0,
    destination: "gold.fact_traffic_hourly",
    published: [
      { table: "gold.fact_traffic_hourly_origin", rows: loaded.originRows },
      { table: "gold.daily_traffic_volume_corrected", rows: loaded.dailyRows },
      { table: "gold.fact_emissions_hourly", rows: loaded.emissionRows },
    ],
    comparison: loaded.comparison,
    undoBatch: loaded.undoBatch,
    rejectedSample: agg.rejectedSample,
    loadErrors: loaded.errors,
    parseErrors: extraction.extractionErrors,
    warnings,
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
  start: number,
  opts: PipelineOptions,
  parsedRows = 0,
): PipelineResult {
  return {
    success: false,
    dryRun: Boolean(opts.dryRun),
    filename,
    fileFormat: format,
    source,
    datasetType,
    classification: { type: datasetType, confidence: 0, reason: errors[0] ?? "Pipeline halted at validation gate." },
    totalRowsParsed: parsedRows,
    rowsAccepted: 0,
    rowsRejected: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsAlreadyLoaded: 0,
    rowsFailed: 0,
    rowsSkippedTransform: 0,
    destination: null,
    published: [],
    comparison: null,
    undoBatch: null,
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
