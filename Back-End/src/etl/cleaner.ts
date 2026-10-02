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
  "Cdv/Ph Arena",
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

// NLEX corridor km-post range, on the DPWH national-highway scale (measured from
// Manila; Balintawak sits at ~km 12) that accident_data/breakdown_data's StartKM and the
// legacy "Km N" location text both use. The mainline ends at Sta. Ines, km 88.70
// (published posts: Dau 83.35, SCTEX 85.56, Sta. Ines 88.70). This was 84 — a figure
// written as "Sta. Ines/Dau Km ~84", i.e. Dau's post mistaken for Sta. Ines' — and it
// silently rejected everything from Dau to Sta. Ines: 376 accident and 1,516 breakdown
// rows in the client's 2022-2026 CSVs (km 84.1-88.9), leaving SCTEX and Sta. Ines with no
// incident history at all. 89.0 = Sta. Ines plus a 0.3 km buffer; the only CSV rows
// beyond it are six breakdowns at km 90.0, 96.0, 97.2 and 98.0, well past the terminus.
const NLEX_KM_MIN = 0;
const NLEX_KM_MAX = 89;

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
 * Extract the km post from strings like "Km 79+400", "Km. 14+200", "KM14+400":
 * 79.4, 14.2, 14.4. The metres after the "+" used to be dropped, filing an
 * incident at Km 79+900 under Km 79 while every row already in the warehouse
 * keeps them (15.6, 14.4, ...).
 */
export function extractKmPost(location: string | null | undefined): number | null {
  if (!location || typeof location !== "string") return null;
  const match = location.match(/km\.?\s*(\d+)(?:\s*\+\s*(\d{1,3}))?/i);
  if (!match) return null;
  const metres = match[2] ? Number(match[2].padEnd(3, "0")) : 0;
  return parseInt(match[1], 10) + metres / 1000;
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
 * Normalize a date-and-time to "YYYY-MM-DD HH:MM:SS", keeping the time. A
 * value with no time is midnight. Emission rows are HOURLY: normalizing them
 * with normalizeDate(), as this file used to, put all 24 hours of a day on
 * 00:00.
 */
export function normalizeTimestamp(v: string | number | null): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    if (!m[2]) return `${m[1]} 00:00:00`;
    return `${m[1]} ${m[2].padStart(2, "0")}:${m[3]}:${m[4] ?? "00"}`;
  }
  const date = normalizeDate(s);
  return date ? `${date} 00:00:00` : null;
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
      rejected.push({ row, reason: `Location '${location}' is NOT in the NLEX corridor (Km ${NLEX_KM_MIN}–${NLEX_KM_MAX}).` });
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

/**
 * accident_data / breakdown_data events: unlike cleanIncident()'s format,
 * `location` here is a location-TYPE enum (Carriageway/Toll Plaza/
 * Interchange/...), not a plaza name or a "Km 79+400" string — the corridor
 * position lives in the separate `startkm` column, in METERS (e.g. 82500 =
 * Km 82+500), so the corridor check keys off that instead of parsing text.
 */
function cleanAccidentBreakdownEvent(rows: RawRow[], type: "accident_data" | "breakdown_data"): CleanResult {
  const accepted: RawRow[] = [];
  const rejected: CleanResult["rejected"] = [];
  const warnings: string[] = [];
  const dateField = type === "accident_data" ? "event_start_date" : "event_encoded_date";

  for (const row of rows) {
    const rawKm = row.startkm;
    const km = rawKm === null || rawKm === undefined || rawKm === "" ? null : Number(rawKm) / 1000;

    if (km === null || Number.isNaN(km)) {
      rejected.push({ row, reason: "Missing or invalid startkm value." });
      continue;
    }

    if (!isNlexKmPost(km)) {
      rejected.push({ row, reason: `Km ${km.toFixed(1)} is NOT in the NLEX corridor (Km ${NLEX_KM_MIN}-${NLEX_KM_MAX}).` });
      continue;
    }

    if (!row[dateField]) {
      rejected.push({ row, reason: `Missing ${dateField} value.` });
      continue;
    }

    accepted.push(row);
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

    // Normalize the timestamp, keeping its hour.
    const ts = row.timestamp_utc ?? row.date ?? row.timestamp;
    const normalized = normalizeTimestamp(ts as string);
    if (!normalized) {
      rejected.push({ row, reason: `Invalid date/timestamp: '${ts}'` });
      continue;
    }

    const clean: RawRow = {
      ...row,
      timestamp_utc: normalized,
    };

    accepted.push(clean);
  }

  if (rejected.length > 0) {
    warnings.push(`${rejected.length} row(s) rejected — invalid emissions data.`);
  }

  return { accepted, rejected, warnings };
}

/**
 * The day a cleaned row of a record dataset belongs to (YYYY-MM-DD), or null
 * for datasets that are not part of the corridor record. Air quality is a
 * sensor feed that runs past the record, so it is not cut.
 */
export function recordDay(row: RawRow, datasetType: DatasetType): string | null {
  const day = (v: unknown) => (v === null || v === undefined ? null : String(v).slice(0, 10));
  switch (datasetType) {
    case "road_crash":
    case "motorcycle_crash":
    case "stalled_vehicle":
      return day(row.date);
    case "accident_data":
      return day(row.event_start_date);
    case "breakdown_data":
      return day(row.event_encoded_date);
    case "emissions":
      return "co2_grams" in row || "co_grams" in row ? day(row.timestamp_utc) : null;
    default:
      return null;
  }
}

/**
 * Main clean function — delegates to the correct cleaner based on dataset type
 */
export function cleanData(rows: RawRow[], datasetType: DatasetType): CleanResult {
  switch (datasetType) {
    case "road_crash":
    case "motorcycle_crash":
    case "stalled_vehicle":
      return cleanIncident(rows, datasetType);
    case "accident_data":
    case "breakdown_data":
      return cleanAccidentBreakdownEvent(rows, datasetType);
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
