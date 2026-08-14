/**
 * File Extractor — Wraps our existing parser.ts for manual file uploads
 * This is the extractor for Source Layer → "Internal Data" and "User Input"
 */
import { parseFile } from "../parser.js";
import type { ExtractionResult } from "./types.js";

export function extractFromFile(filePath: string, originalFilename: string): ExtractionResult {
  const parsed = parseFile(filePath, originalFilename);

  return {
    source: "file_upload",
    sourceName: originalFilename,
    rows: parsed.rows,
    headers: parsed.headers,
    extractionErrors: parsed.parseErrors,
    metadata: {
      detectedFormat: parsed.detectedFormat,
      totalRows: parsed.rows.length,
    },
  };
}
