/**
 * ETL Cleaner — NLEX Corridor Validator & Data Cleaner
 * Rejects any data that does NOT belong to the NLEX corridor.
 */
import type { RawRow } from "./parser.js";
import type { DatasetType } from "./classifier.js";

export interface CleanResult {
  accepted: RawRow[];
  rejected: { row: RawRow; reason: string }[];
  warnings: string[];
}

// ── NLEX Corridor Whitelist ──────────────────────────────────────────
// The 25 official NLEX toll plazas (from nlex_exits + nlex_traffic_volume)
const NLEX_PLAZAS: string[] = [
  "Angeles",
  "Balagtas",
  "Balintawak",
  "Bocaue Barrier",
  "Bocaue Interchange",
  "Caloocan",
  "CDV",
  "CDV/PH Arena",
  "Dau",
  "Karuhatan",
  "MacArthur Ramp Off",
  "MacArthur Ramp On",
  "Marilao",
  "Mexico",
  "Meycauayan",
  "Meycauyan",
  "Mindanao",
  "NLEX Harbor Link",
  "Paso De Blas Valenzuela",
  "Pulilan",
  "R10",
  "San Fernando",
  "San Simon",
  "SCTEX Spur Road",
  "Sctex",
  "Sta. Ines",
  "Sta. Rita",
  "Sta. Rita Guiguinto",
  "Tabang Spur Road",
  "Tabang Guiguinto",
  "Tambubong",
  "Valenzuela",
];

// Normalized set for fast fuzzy lookup
const NLEX_PLAZA_NORMALIZED = new Set(
  NLEX_PLAZAS.map((p) =>
    p
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
  )
);

// NLEX corridor km-post range (Balintawak Km 0 to Sta. Ines/Dau Km ~84)
const NLEX_KM_MIN = 0;
const NLEX_KM_MAX = 84;

// ── Normalization Helpers ────────────────────────────────────────────

function normalizePlaza(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isNlexPlaza(name: string | null | undefined): boolean {
  if (!name || typeof name !== "string") return false;
  const normalized = normalizePlaza(name);
  // Direct match
  if (NLEX_PLAZA_NORMALIZED.has(normalized)) return true;
  // Partial/fuzzy match — check if any known plaza is a substring
  for (const known of NLEX_PLAZA_NORMALIZED) {
    if (normalized.includes(known) || known.includes(normalized)) return true;
  }
  return false;
}

/**
 * Extract numeric km value from strings like "Km 79+400", "Km. 14+200", "KM14+400"
 */
export function extractKmPost(location: string | null | undefined): number | null {
  if (!location || typeof location !== "string") return null;
  const match = location.match(/km\.?\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

function isNlexKmPost(km: number): boolean {
  return km >= NLEX_KM_MIN && km <= NLEX_KM_MAX;
}

/**
 * Normalize date strings to ISO format (YYYY-MM-DD)
 */
export function normalizeDate(dateStr: string | number | null): string | null {
  if (dateStr === null || dateStr === undefined) return null;
  const s = String(dateStr).trim();
  if (!s) return null;

  // Already ISO: 2022-01-15
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // US format: 01/15/2022 or 1/15/2022
  const usMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (usMatch) {
    return `${usMatch[3]}-${usMatch[1].padStart(2, "0")}-${usMatch[2].padStart(2, "0")}`;
  }

  // DD-Mon-YY: 01-Jan-22
  const monMatch = s.match(/^(\d{1,2})-([A-Za-z]+)-(\d{2,4})/);
  if (monMatch) {
    const months: Record<string, string> = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };
    const m = months[monMatch[2].toLowerCase().slice(0, 3)];
    if (m) {
      let y = monMatch[3];
      if (y.length === 2) y = parseInt(y) > 50 ? `19${y}` : `20${y}`;
      return `${y}-${m}-${monMatch[1].padStart(2, "0")}`;
    }
  }

  // Try native Date parse as fallback
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  return null;
}

/**
 * Normalize time strings to 24h format (HH:MM:SS)
 */
export function normalizeTime(timeStr: string | null): string | null {
  if (!timeStr || typeof timeStr !== "string") return null;
  const s = timeStr.trim();

  // Already 24h: 13:05:00 or 13:05
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(s)) return s.length === 5 ? `${s}:00` : s;

  // 12h: 01:03 PM, 1:05 AM
  const amPmMatch = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (amPmMatch) {
    let h = parseInt(amPmMatch[1]);
    const m = amPmMatch[2];
    const period = amPmMatch[3].toUpperCase();
    if (period === "PM" && h !== 12) h += 12;
    if (period === "AM" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${m}:00`;
  }

  return null;
}

// ── Main Cleaning Functions ──────────────────────────────────────────

function cleanTrafficVolume(rows: RawRow[]): CleanResult {
  const accepted: RawRow[] = [];
  const rejected: CleanResult["rejected"] = [];
  const warnings: string[] = [];

  for (const row of rows) {
    const plaza = String(row.toll_plaza ?? row.plaza ?? "").trim();

    if (!plaza) {
      rejected.push({ row, reason: "Missing toll_plaza/plaza column value." });
      continue;
    }

    if (!isNlexPlaza(plaza)) {
      rejected.push({ row, reason: `Location '${plaza}' is NOT part of the NLEX corridor.` });
      continue;
    }

    // Normalize date
    const normalizedDate = normalizeDate(row.date as string);
    if (!normalizedDate) {
      rejected.push({ row, reason: `Invalid date format: '${row.date}'` });
      continue;
    }

    // Validate direction
    const dir = String(row.direction ?? "").toUpperCase().trim();
    if (dir !== "NB" && dir !== "SB") {
      rejected.push({ row, reason: `Invalid direction: '${row.direction}'. Must be 'NB' or 'SB'.` });
      continue;
    }

    // Build clean row
    const clean: RawRow = {
      ...row,
      date: normalizedDate,
      direction: dir,
      toll_plaza: plaza,
    };

    accepted.push(clean);
  }

  if (rejected.length > 0) {
    warnings.push(`${rejected.length} row(s) rejected — non-NLEX locations or invalid data.`);
  }

  return { accepted, rejected, warnings };
}

function cleanIncident(rows: RawRow[], type: "road_crash" | "stalled_vehicle" | "motorcycle_crash"): CleanResult {
  const accepted: RawRow[] = [];
  const rejected: CleanResult["rejected"] = [];
  const warnings: string[] = [];

  for (const row of rows) {
    const location = String(row.location ?? "").trim();

    if (!location) {
      rejected.push({ row, reason: "Missing location value." });
      continue;
    }

    // Check if it's a known plaza name
    const isPlaza = isNlexPlaza(location);
    // Check if it's a valid km-post
    const km = extractKmPost(location);
    const isValidKm = km !== null && isNlexKmPost(km);

    if (!isPlaza && !isValidKm) {
      rejected.push({ row, reason: `Location '${location}' is NOT in the NLEX corridor (Km 0–84).` });
      continue;
    }

    // Normalize date
    const normalizedDate = normalizeDate(row.date as string);
    if (!normalizedDate) {
      rejected.push({ row, reason: `Invalid date: '${row.date}'` });
      continue;
    }

    // Normalize times
    const clean: RawRow = {
      ...row,
      date: normalizedDate,
      reported_time: normalizeTime(row.reported_time as string),
      cleared_time: normalizeTime(row.cleared_time as string),
    };

    if (type === "stalled_vehicle") {
      clean.responded_time = normalizeTime(row.responded_time as string);
    } else {
      clean.response_time = normalizeTime(row.response_time as string);
    }

    accepted.push(clean);
  }

  if (rejected.length > 0) {
    warnings.push(`${rejected.length} row(s) rejected — non-NLEX locations or invalid data.`);
  }

  return { accepted, rejected, warnings };
}

function cleanEmissions(rows: RawRow[]): CleanResult {
  const accepted: RawRow[] = [];
  const rejected: CleanResult["rejected"] = [];
  const warnings: string[] = [];

  for (const row of rows) {
    // Validate vehicle class if present
    const vc = row.vehicle_class;
    if (vc !== null && vc !== undefined) {
      const vcNum = typeof vc === "number" ? vc : parseInt(String(vc).replace(/\D/g, ""), 10);
      if (isNaN(vcNum) || vcNum < 1 || vcNum > 3) {
        rejected.push({ row, reason: `Invalid vehicle_class: '${vc}'. Must be 1, 2, or 3.` });
        continue;
      }
      row.vehicle_class = vcNum;
    }

    // Normalize date/timestamp
    const ts = row.timestamp_utc ?? row.date ?? row.timestamp;
    const normalizedDate = normalizeDate(ts as string);
    if (!normalizedDate) {
      rejected.push({ row, reason: `Invalid date/timestamp: '${ts}'` });
      continue;
    }

    const clean: RawRow = {
      ...row,
      timestamp_utc: normalizedDate,
    };

    accepted.push(clean);
  }

  if (rejected.length > 0) {
    warnings.push(`${rejected.length} row(s) rejected — invalid emissions data.`);
  }

  return { accepted, rejected, warnings };
}

/**
 * Main clean function — delegates to the correct cleaner based on dataset type
 */
export function cleanData(rows: RawRow[], datasetType: DatasetType): CleanResult {
  switch (datasetType) {
    case "traffic_volume":
      return cleanTrafficVolume(rows);
    case "road_crash":
    case "motorcycle_crash":
    case "stalled_vehicle":
      return cleanIncident(rows, datasetType);
    case "emissions":
      return cleanEmissions(rows);
    default:
      return {
        accepted: [],
        rejected: rows.map((r) => ({ row: r, reason: "Unknown dataset type — cannot clean." })),
        warnings: ["Dataset type could not be determined."],
      };
  }
}
