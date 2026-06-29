import { db } from "../config/db.js";

// ─────────────────────────────────────────────────────────
// Dataset type definitions — maps CSV headers to DB tables
// ─────────────────────────────────────────────────────────

export type DatasetType =
  | "traffic_volume"
  | "road_crash"
  | "motorcycle_crash"
  | "stalled_vehicle"
  | "apprehension";

export interface IngestionResult {
  datasetType: DatasetType;
  tableName: string;
  totalRows: number;
  processedRows: number;
  failedRows: number;
  errors: string[];
  durationMs: number;
}

// Maps dataset types to their target tables
const TABLE_MAP: Record<DatasetType, string> = {
  traffic_volume: "nlex_traffic_volumes",
  road_crash: "nlex_road_crashes",
  motorcycle_crash: "nlex_motorcycle_crashes",
  stalled_vehicle: "nlex_stalled_vehicles",
  apprehension: "nlex_apprehensions",
};

// Header signatures for auto-detection
const HEADER_SIGNATURES: { type: DatasetType; requiredHeaders: string[] }[] = [
  {
    type: "traffic_volume",
    requiredHeaders: ["Date", "Direction", "Type", "Toll Plaza", "Vehicle Class", "00:00"],
  },
  {
    type: "road_crash",
    requiredHeaders: ["Reported Time", "Response Time", "Cleared Time", "Cause of Accident", "Type of Accident"],
  },
  {
    type: "motorcycle_crash",
    requiredHeaders: ["Reported Time", "Cause of Accident", "Type of Accident"],
  },
  {
    type: "stalled_vehicle",
    requiredHeaders: ["Entry Point", "Vehicle Cause", "Assistance Rendered"],
  },
  {
    type: "apprehension",
    requiredHeaders: ["Violation", "Action Taken"],
  },
];

// ─────────────────────────────────────────────────────────
// CSV Parsing
// ─────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCsvText(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error("CSV file must include a header row and at least one data row");
  }

  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine);
  return { headers, rows };
}

// ─────────────────────────────────────────────────────────
// Auto-detect dataset type from headers
// ─────────────────────────────────────────────────────────

export function detectDatasetType(headers: string[]): DatasetType | null {
  const normalizedHeaders = headers.map((h) => h.trim());

  // Traffic volume has a very distinct signature with hourly time columns
  if (normalizedHeaders.includes("Toll Plaza") && normalizedHeaders.includes("00:00")) {
    return "traffic_volume";
  }

  // Stalled vehicles have unique "Entry Point" + "Vehicle Cause" combo
  if (normalizedHeaders.includes("Entry Point") && normalizedHeaders.includes("Vehicle Cause")) {
    return "stalled_vehicle";
  }

  // Apprehension has unique "Violation" + "Action Taken" columns
  if (normalizedHeaders.includes("Violation") && normalizedHeaders.includes("Action Taken")) {
    return "apprehension";
  }

  // Both crash types have "Cause of Accident" — differentiate by context
  // (In practice they share the same schema, but we track them in separate tables)
  // The caller must specify if it's motorcycle vs road crash, or we default to road crash
  if (normalizedHeaders.includes("Cause of Accident") && normalizedHeaders.includes("Type of Accident")) {
    return "road_crash"; // Default; caller can override for motorcycle
  }

  // Fallback: try signature matching
  for (const sig of HEADER_SIGNATURES) {
    if (sig.requiredHeaders.every((h) => normalizedHeaders.includes(h))) {
      return sig.type;
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────
// Row Mappers — CSV row → SQL INSERT params
// ─────────────────────────────────────────────────────────

function mapTrafficVolumeRow(headers: string[], values: string[]) {
  const get = (name: string) => {
    const idx = headers.indexOf(name);
    return idx >= 0 ? values[idx]?.trim() || null : null;
  };
  const getInt = (name: string) => {
    const val = get(name);
    if (!val) return 0;
    const n = parseInt(val.replace(/,/g, ""), 10);
    return isNaN(n) ? 0 : n;
  };

  // Hourly columns: 00:00, 01:00, ..., 23:00
  const hourlyValues = [];
  for (let h = 0; h < 24; h++) {
    const colName = `${h.toString().padStart(2, "0")}:00`;
    hourlyValues.push(getInt(colName));
  }

  return {
    columns: "date, direction, type, toll_plaza, vehicle_class, h00, h01, h02, h03, h04, h05, h06, h07, h08, h09, h10, h11, h12, h13, h14, h15, h16, h17, h18, h19, h20, h21, h22, h23",
    values: [get("Date"), get("Direction"), get("Type"), get("Toll Plaza"), get("Vehicle Class"), ...hourlyValues],
    placeholders: Array.from({ length: 29 }, (_, i) => `$${i + 1}`).join(", "),
  };
}

function mapCrashRow(headers: string[], values: string[]) {
  const get = (name: string) => {
    const idx = headers.indexOf(name);
    return idx >= 0 ? values[idx]?.trim() || null : null;
  };
  const getInt = (name: string) => {
    const val = get(name);
    if (!val) return 0;
    const n = parseInt(val, 10);
    return isNaN(n) ? 0 : n;
  };

  return {
    columns: "no, date, reported_time, response_time, cleared_time, location, lane_occupied, no_of_vehicles_involved, cause_of_accident, type_of_accident, weather_condition, type_of_pavement, injuries_male, injuries_female, fatalities_male, fatalities_female, damage_to_toll_property",
    values: [
      getInt("No."), get("Date"), get("Reported Time"), get("Response Time"), get("Cleared Time"),
      get("Location"), get("Lane Occupied"), getInt("No. of Vehicles Involved"),
      get("Cause of Accident"), get("Type of Accident"), get("Weather Condition"),
      get("Type of Pavement"), getInt("No. of Injuries (Male)"), getInt("No. of Injuries (Female)"),
      getInt("No. of Fatalities (Male)"), getInt("No. of Fatalities (Female)"),
      get("Damage/s to Toll Road Property"),
    ],
    placeholders: Array.from({ length: 17 }, (_, i) => `$${i + 1}`).join(", "),
  };
}

function mapStalledVehicleRow(headers: string[], values: string[]) {
  const get = (name: string) => {
    const idx = headers.indexOf(name);
    return idx >= 0 ? values[idx]?.trim() || null : null;
  };
  const getInt = (name: string) => {
    const val = get(name);
    if (!val) return 0;
    const n = parseInt(val, 10);
    return isNaN(n) ? 0 : n;
  };

  return {
    columns: "no, date, reported_time, responded_time, cleared_time, entry_point, vehicle_cause, location, driver_gender, assistance_rendered, remarks",
    values: [
      getInt("No."), get("Date"), get("Reported Time"), get("Responded Time"), get("Cleared Time"),
      get("Entry Point"), get("Vehicle Cause"), get("Location"),
      get("Driver's Gender"), get("Assistance Rendered"), get("Remarks"),
    ],
    placeholders: Array.from({ length: 11 }, (_, i) => `$${i + 1}`).join(", "),
  };
}

function mapApprehensionRow(headers: string[], values: string[]) {
  const get = (name: string) => {
    const idx = headers.indexOf(name);
    return idx >= 0 ? values[idx]?.trim() || null : null;
  };
  const getInt = (name: string) => {
    const val = get(name);
    if (!val) return 0;
    const n = parseInt(val, 10);
    return isNaN(n) ? 0 : n;
  };

  return {
    columns: "no, date, time, vehicle_model, driver_gender, violation, action_taken",
    values: [
      getInt("No."), get("Date"), get("Time"), get("Vehicle Model"),
      get("Driver's Gender"), get("Violation"), get("Action Taken"),
    ],
    placeholders: Array.from({ length: 7 }, (_, i) => `$${i + 1}`).join(", "),
  };
}

// ─────────────────────────────────────────────────────────
// Main Ingestion — chunked batch insert
// ─────────────────────────────────────────────────────────

const BATCH_SIZE = 500; // rows per INSERT batch

export async function ingestCsv(
  csvText: string,
  datasetTypeOverride?: DatasetType
): Promise<IngestionResult> {
  if (!db) {
    throw new Error("Database not configured — set POSTGRES_URL in .env");
  }

  const startTime = Date.now();
  const { headers, rows } = parseCsvText(csvText);

  // Detect or use override
  const datasetType = datasetTypeOverride || detectDatasetType(headers);
  if (!datasetType) {
    throw new Error(
      `Unable to detect dataset type from CSV headers: [${headers.slice(0, 5).join(", ")}...]. ` +
      `Supported types: traffic_volume, road_crash, motorcycle_crash, stalled_vehicle, apprehension`
    );
  }

  const tableName = TABLE_MAP[datasetType];
  const errors: string[] = [];
  let processedRows = 0;
  let failedRows = 0;

  // Select the right row mapper
  const mapRow = {
    traffic_volume: mapTrafficVolumeRow,
    road_crash: mapCrashRow,
    motorcycle_crash: mapCrashRow,
    stalled_vehicle: mapStalledVehicleRow,
    apprehension: mapApprehensionRow,
  }[datasetType];

  // Process in batches for chunked ingestion
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const client = await db.connect();

    try {
      await client.query("BEGIN");

      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const rowIndex = i + j + 1;

        try {
          const mapped = mapRow(headers, row);
          await client.query(
            `INSERT INTO ${tableName} (${mapped.columns}) VALUES (${mapped.placeholders})`,
            mapped.values
          );
          processedRows++;
        } catch (rowErr: any) {
          failedRows++;
          if (errors.length < 10) {
            errors.push(`Row ${rowIndex}: ${rowErr.message}`);
          }
        }
      }

      await client.query("COMMIT");
    } catch (batchErr: any) {
      await client.query("ROLLBACK");
      failedRows += batch.length;
      errors.push(`Batch starting at row ${i + 1} failed: ${batchErr.message}`);
    } finally {
      client.release();
    }
  }

  return {
    datasetType,
    tableName,
    totalRows: rows.length,
    processedRows,
    failedRows,
    errors,
    durationMs: Date.now() - startTime,
  };
}

// ─────────────────────────────────────────────────────────
// Get available dataset types and their descriptions
// ─────────────────────────────────────────────────────────

export function getDatasetTypes() {
  return [
    {
      type: "traffic_volume",
      label: "Traffic Volume",
      table: "nlex_traffic_volumes",
      description: "Hourly traffic counts by toll plaza, direction, and vehicle class",
      requiredColumns: ["Date", "Direction", "Type", "Toll Plaza", "Vehicle Class", "00:00–23:00"],
    },
    {
      type: "road_crash",
      label: "Road Crash Reports",
      table: "nlex_road_crashes",
      description: "Road crash incidents with response times, causes, and casualties",
      requiredColumns: ["Date", "Reported Time", "Location", "Cause of Accident", "Weather Condition"],
    },
    {
      type: "motorcycle_crash",
      label: "Motorcycle Crash Reports",
      table: "nlex_motorcycle_crashes",
      description: "Motorcycle-specific crash reports (same structure as road crashes)",
      requiredColumns: ["Date", "Reported Time", "Location", "Cause of Accident"],
    },
    {
      type: "stalled_vehicle",
      label: "Stalled Vehicle Reports",
      table: "nlex_stalled_vehicles",
      description: "Stalled/breakdown incidents with response and assistance data",
      requiredColumns: ["Date", "Reported Time", "Entry Point", "Vehicle Cause", "Assistance Rendered"],
    },
    {
      type: "apprehension",
      label: "Apprehension Reports",
      table: "nlex_apprehensions",
      description: "Traffic violations and enforcement actions",
      requiredColumns: ["Date", "Time", "Violation", "Action Taken"],
    },
  ];
}
