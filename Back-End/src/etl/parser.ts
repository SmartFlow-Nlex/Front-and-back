/**
 * ETL Parser — Universal file parser for CSV, JSON, and Excel
 * Extracts raw rows from any supported file format into a uniform array of objects.
 */
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import fs from "fs";
import path from "path";

export type RawRow = Record<string, string | number | null>;

export interface ParseResult {
  rows: RawRow[];
  originalFilename: string;
  detectedFormat: "csv" | "json" | "xlsx" | "xls" | "unknown";
  headers: string[];
  parseErrors: string[];
}

/**
 * Normalize column headers: lowercase, trim, replace spaces/special chars with underscores
 */
function normalizeHeader(h: string): string {
  return h
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Detect file format from extension
 */
function detectFormat(filename: string): ParseResult["detectedFormat"] {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".csv" || ext === ".tsv") return "csv";
  if (ext === ".json") return "json";
  if (ext === ".xlsx") return "xlsx";
  if (ext === ".xls") return "xls";
  return "unknown";
}

/**
 * Parse a CSV file buffer into rows
 */
function parseCsv(buffer: Buffer, errors: string[]): { rows: RawRow[]; headers: string[] } {
  try {
    // Auto-detect delimiter by checking first line
    const firstLine = buffer.toString("utf-8").split("\n")[0];
    const delimiter = firstLine.includes("\t") ? "\t" : firstLine.includes(";") ? ";" : ",";

    const records: string[][] = parse(buffer, {
      delimiter,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
      bom: true,
    });

    if (records.length < 2) {
      errors.push("CSV file has no data rows (only header or empty).");
      return { rows: [], headers: [] };
    }

    const rawHeaders = records[0];
    const headers = rawHeaders.map(normalizeHeader);
    const rows: RawRow[] = [];

    for (let i = 1; i < records.length; i++) {
      const row: RawRow = {};
      for (let j = 0; j < headers.length; j++) {
        const val = records[i][j];
        if (val === undefined || val === "" || val === "null" || val === "NULL") {
          row[headers[j]] = null;
        } else if (!isNaN(Number(val)) && val.trim() !== "") {
          row[headers[j]] = Number(val);
        } else {
          row[headers[j]] = val.trim();
        }
      }
      rows.push(row);
    }

    return { rows, headers };
  } catch (err: any) {
    errors.push(`CSV parse error: ${err.message}`);
    return { rows: [], headers: [] };
  }
}

/**
 * Parse a JSON file buffer into rows
 */
function parseJson(buffer: Buffer, errors: string[]): { rows: RawRow[]; headers: string[] } {
  try {
    const parsed = JSON.parse(buffer.toString("utf-8"));
    let data: any[];

    if (Array.isArray(parsed)) {
      data = parsed;
    } else if (parsed.data && Array.isArray(parsed.data)) {
      data = parsed.data;
    } else if (parsed.rows && Array.isArray(parsed.rows)) {
      data = parsed.rows;
    } else if (parsed.records && Array.isArray(parsed.records)) {
      data = parsed.records;
    } else {
      errors.push("JSON file must contain an array of objects (or have a 'data', 'rows', or 'records' key).");
      return { rows: [], headers: [] };
    }

    if (data.length === 0) {
      errors.push("JSON array is empty.");
      return { rows: [], headers: [] };
    }

    // Normalize all keys
    const rows: RawRow[] = data.map((item: any) => {
      const row: RawRow = {};
      for (const [key, val] of Object.entries(item)) {
        const nKey = normalizeHeader(key);
        if (val === null || val === undefined || val === "") {
          row[nKey] = null;
        } else if (typeof val === "number") {
          row[nKey] = val;
        } else {
          row[nKey] = String(val).trim();
        }
      }
      return row;
    });

    const headers = Object.keys(rows[0]);
    return { rows, headers };
  } catch (err: any) {
    errors.push(`JSON parse error: ${err.message}`);
    return { rows: [], headers: [] };
  }
}

/**
 * Parse an Excel file buffer into rows
 */
function parseExcel(buffer: Buffer, errors: string[]): { rows: RawRow[]; headers: string[] } {
  try {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      errors.push("Excel file has no sheets.");
      return { rows: [], headers: [] };
    }

    const sheet = workbook.Sheets[sheetName];
    const jsonData: any[] = XLSX.utils.sheet_to_json(sheet, { defval: null });

    if (jsonData.length === 0) {
      errors.push("Excel sheet is empty.");
      return { rows: [], headers: [] };
    }

    const rows: RawRow[] = jsonData.map((item: any) => {
      const row: RawRow = {};
      for (const [key, val] of Object.entries(item)) {
        const nKey = normalizeHeader(key);
        if (val === null || val === undefined) {
          row[nKey] = null;
        } else if (typeof val === "number") {
          row[nKey] = val;
        } else {
          row[nKey] = String(val).trim();
        }
      }
      return row;
    });

    const headers = Object.keys(rows[0]);
    return { rows, headers };
  } catch (err: any) {
    errors.push(`Excel parse error: ${err.message}`);
    return { rows: [], headers: [] };
  }
}

/**
 * Main parse function — detects format and delegates to the appropriate parser
 */
export function parseFile(filePath: string, originalFilename: string): ParseResult {
  const format = detectFormat(originalFilename);
  const parseErrors: string[] = [];

  if (format === "unknown") {
    return {
      rows: [],
      originalFilename,
      detectedFormat: "unknown",
      headers: [],
      parseErrors: [`Unsupported file format: ${path.extname(originalFilename)}. Accepted: .csv, .json, .xlsx, .xls`],
    };
  }

  const buffer = fs.readFileSync(filePath);

  let result: { rows: RawRow[]; headers: string[] };

  switch (format) {
    case "csv":
      result = parseCsv(buffer, parseErrors);
      break;
    case "json":
      result = parseJson(buffer, parseErrors);
      break;
    case "xlsx":
    case "xls":
      result = parseExcel(buffer, parseErrors);
      break;
    default:
      result = { rows: [], headers: [] };
      parseErrors.push("Internal error: unhandled format.");
  }

  return {
    rows: result.rows,
    originalFilename,
    detectedFormat: format,
    headers: result.headers,
    parseErrors,
  };
}
