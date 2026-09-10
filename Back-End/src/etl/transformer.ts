/**
 * ETL Transformer — Maps cleaned rows to the exact database schema
 *
 * TARGETS: the warehouse is a medallion layout (bronze -> silver -> gold), and
 * raw ingestion belongs in BRONZE. The `public` names that look like tables
 * (nlex_traffic_volume, nlex_road_crashes, ...) are views and materialized
 * views built on top of bronze, so they cannot receive inserts:
 *
 *   nlex_traffic_volume      MATERIALIZED VIEW -> write bronze.nlex_traffic_volume
 *   nlex_road_crashes        view (computed cols) -> write bronze.nlex_incidents
 *   nlex_motorcycle_crashes  view (computed cols) -> write bronze.nlex_incidents
 *   nlex_theoretical_emissions / nlex_emissions   -> bronze equivalents
 *   nlex_stalled_vehicles    real table in public (6 columns only)
 */
import type { RawRow } from "./parser.js";
import type { DatasetType } from "./classifier.js";
import { extractKmPost } from "./cleaner.js";
import {
  REFRESH_ACCIDENT_SILVER,
  REFRESH_BREAKDOWN_SILVER,
  type SilverRefresh,
} from "./silver-refresh.js";

export interface TransformResult {
  tableName: string;
  columns: string[];
  rows: any[][];
  skipped: number;
  /** Set when a materialized view must be refreshed for the load to become visible. */
  refreshMaterializedView?: string;
  /**
   * Set when a silver table must be rebuilt for the load to become visible.
   * The materialized-view field above cannot express this: accident/breakdown
   * silver is a plain table (DROP + CREATE TABLE AS), not a matview.
   */
  refreshSilver?: SilverRefresh;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                     "July", "August", "September", "October", "November", "December"];

function toInt(v: unknown): number {
  if (typeof v === "number") return Math.round(v);
  if (v === null || v === undefined || v === "") return 0;
  const n = parseInt(String(v).replace(/,/g, ""), 10);
  return Number.isNaN(n) ? 0 : n;
}

function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}

/** "Class 2" | 2 | "2" -> 2; "Total" -> null */
function parseVehicleClass(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v >= 1 && v <= 3 ? v : null;
  const s = String(v).trim();
  if (/^total$/i.test(s)) return null;
  const n = parseInt(s.replace(/\D/g, ""), 10);
  return n >= 1 && n <= 3 ? n : null;
}

/** Combine an ISO date with an HH:MM[:SS] time into a timestamp string. */
function combineDateTime(date: string, time: unknown): string | null {
  if (!time) return null;
  const t = String(time).trim();
  if (!/^\d{1,2}:\d{2}/.test(t)) return null;
  return `${date} ${t.length === 5 ? t + ":00" : t}`;
}

function minutesBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ms = Date.parse(b.replace(" ", "T")) - Date.parse(a.replace(" ", "T"));
  if (Number.isNaN(ms)) return null;
  // Crossing midnight shows up as a negative gap; wrap into the next day.
  return Math.round((ms < 0 ? ms + 86_400_000 : ms) / 60_000);
}

/**
 * Traffic volume: the upload format is WIDE (one row per date/plaza/direction/
 * vehicle_class with columns h00..h23), while bronze.nlex_traffic_volume is
 * LONG (one row per date/hour/plaza/direction, with the three classes as
 * separate columns). So each input row is unpivoted across 24 hours, and the
 * per-class rows are folded together on the shared date/hour/plaza/direction key.
 */
function transformTrafficVolume(rows: RawRow[]): TransformResult {
  const columns = [
    "date_day", "hour_of_day", "toll_plaza", "direction",
    "volume_class1", "volume_class2", "volume_class3", "total_volume",
    "day_of_week", "is_weekend", "month_name", "quarter", "is_rush_hour",
  ];

  type Bucket = {
    date: string; hour: number; plaza: string; direction: string;
    c1: number; c2: number; c3: number; total: number; sawTotal: boolean;
  };
  const buckets = new Map<string, Bucket>();
  let skipped = 0;

  for (const row of rows) {
    const date = row.date as string;
    const direction = row.direction as string;
    const plaza = (row.toll_plaza ?? row.plaza) as string;

    if (!date || !direction || !plaza) {
      skipped++;
      continue;
    }

    const vc = parseVehicleClass(row.vehicle_class);

    for (let h = 0; h < 24; h++) {
      const hh = String(h).padStart(2, "0");
      const raw = row[`h${hh}`] ?? row[`${hh}_00`];
      const value = toInt(raw);

      const key = `${date}|${hh}|${plaza}|${direction}`;
      let b = buckets.get(key);
      if (!b) {
        b = { date, hour: h, plaza, direction, c1: 0, c2: 0, c3: 0, total: 0, sawTotal: false };
        buckets.set(key, b);
      }

      if (vc === 1) b.c1 += value;
      else if (vc === 2) b.c2 += value;
      else if (vc === 3) b.c3 += value;
      else { b.total += value; b.sawTotal = true; }  // a "Total" row
    }
  }

  const transformed: any[][] = [];
  for (const b of buckets.values()) {
    // Prefer an explicit Total row; otherwise sum the classes.
    const total = b.sawTotal ? b.total : b.c1 + b.c2 + b.c3;
    const d = new Date(`${b.date}T00:00:00Z`);
    const dow = d.getUTCDay();
    const isRush = (b.hour >= 6 && b.hour <= 8) || (b.hour >= 16 && b.hour <= 18);

    transformed.push([
      b.date, b.hour, b.plaza, b.direction,
      b.c1, b.c2, b.c3, total,
      DAY_NAMES[dow], dow === 0 || dow === 6,
      MONTH_NAMES[d.getUTCMonth()], `Q${Math.floor(d.getUTCMonth() / 3) + 1}`, isRush,
    ]);
  }

  return {
    tableName: "bronze.nlex_traffic_volume",
    columns,
    rows: transformed,
    skipped,
    refreshMaterializedView: "nlex_traffic_volume",
  };
}

/**
 * Road and motorcycle crashes both land in bronze.nlex_incidents, distinguished
 * by incident_type. The public nlex_road_crashes / nlex_motorcycle_crashes views
 * derive reported_time, response_time and the `date` text column from these
 * base columns, so they must not be written to directly.
 */
function transformCrash(rows: RawRow[], incidentType: "road_crash" | "motorcycle_crash"): TransformResult {
  const columns = [
    "incident_date", "reported_time", "cleared_time", "location", "incident_type",
    "no_of_vehicles", "cause_of_accident", "type_of_accident", "weather_condition",
    "injuries_male", "injuries_female", "fatalities_male", "fatalities_female",
    "total_injuries", "total_fatalities",
    "hour_of_day", "km_value", "clearance_minutes", "severity",
  ];

  let skipped = 0;
  const transformed: any[][] = [];

  for (const row of rows) {
    const date = row.date as string;
    const location = row.location as string;
    if (!date || !location) { skipped++; continue; }

    const reported = combineDateTime(date, row.reported_time);
    const cleared = combineDateTime(date, row.cleared_time ?? row.response_time);

    const im = toInt(row.injuries_male);
    const iff = toInt(row.injuries_female);
    const fm = toInt(row.fatalities_male);
    const ff = toInt(row.fatalities_female);

    const hour = reported ? Number(reported.slice(11, 13)) : null;
    const clearance = minutesBetween(reported, cleared);

    // Severity is not supplied by the upload format; derive it the same way the
    // dashboard reads it — fatalities outrank injuries.
    const severity = fm + ff > 0 ? "Fatal" : im + iff > 0 ? "Injury" : "Property Damage";

    transformed.push([
      date, reported, cleared, location, incidentType,
      toInt(row.no_of_vehicles_involved ?? row.no_of_vehicles ?? 1),
      row.cause_of_accident ?? null, row.type_of_accident ?? null, row.weather_condition ?? null,
      im, iff, fm, ff, im + iff, fm + ff,
      hour, extractKmPost(location), clearance, severity,
    ]);
  }

  return { tableName: "bronze.nlex_incidents", columns, rows: transformed, skipped };
}

/** public.nlex_stalled_vehicles is a real table, but only has these 5 writable columns. */
function transformStalledVehicle(rows: RawRow[]): TransformResult {
  const columns = ["date", "reported_time", "responded_time", "location", "vehicle_cause"];

  let skipped = 0;
  const transformed: any[][] = [];

  for (const row of rows) {
    const date = row.date as string;
    const location = row.location as string;
    if (!date || !location) { skipped++; continue; }

    transformed.push([
      date,
      combineDateTime(date, row.reported_time),
      combineDateTime(date, row.responded_time),
      location,
      row.vehicle_cause ?? null,
    ]);
  }

  return { tableName: "nlex_stalled_vehicles", columns, rows: transformed, skipped };
}

/**
 * breakdown_data's `deployments` column is a Python-repr string of a list of
 * dicts, not valid JSON, e.g.:
 *   [{'service': 'AAP', 'dispatch_time': '2022-01-01 10:36:00', ...}]
 * Two wrinkles, both verified against all 5 years (156,939 rows) of real
 * source data:
 *   1. Multi-entry lists separate dict items with a bare newline ("}\n {")
 *      instead of a comma — inserting the comma back resolves every one of
 *      the 2,695 rows that otherwise fail to parse, and afterward the parsed
 *      list length matches the row's own deployment_count column exactly
 *      (0 mismatches across all 48,196 rows that carry deployments).
 *   2. A `remarks` value containing a literal apostrophe (7 rows) gets
 *      wrapped in double quotes instead of single quotes by whatever
 *      produced this export (the same thing Python's own repr() does) — so
 *      values must be matched in EITHER quote style; keys are always
 *      single-quoted.
 * A general Python-literal parser would need to handle far more than this;
 * since the field set is fixed and known, a targeted per-field regex
 * extractor is simpler and safer than quote-swapping the whole string.
 */
function parseDeployments(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;

  const normalized = String(raw).replace(/\}\s*\n?\s*\{/g, "}, {");
  const blocks = normalized.match(/\{[^{}]*\}/g);
  if (!blocks) return null;

  const FIELDS = [
    "service", "dispatch_time", "arrival_time", "departure_time",
    "response_time_min", "service_time_min", "remarks",
  ];

  const deployments = blocks.map((block) => {
    const record: Record<string, string | null> = {};
    for (const field of FIELDS) {
      const match = block.match(new RegExp(`'${field}':\\s*(?:'([^']*)'|"([^"]*)")`));
      record[field] = match ? (match[1] ?? match[2] ?? "") : null;
    }
    return record;
  });

  return JSON.stringify(deployments);
}

/**
 * accident_data: one row per accident event. Unlike the older road/moto
 * crash upload format, injuries/fatalities and a real scene-cleared
 * timestamp (SiteCleared) are genuine recorded values here, not always-empty
 * columns — see train_incident_severity_models.py's module docstring for
 * why that distinction matters. StartKM arrives in meters (e.g. 82500 = Km
 * 82+500); bronze keeps it raw, silver derives km_value = start_km / 1000.
 */
function transformAccidentData(rows: RawRow[]): TransformResult {
  const columns = [
    "event_number", "event_start_date", "event_type", "event_status", "direction",
    "location", "sub_location", "start_km", "type_of_event", "main_cause", "sub_cause",
    "detection", "weather_condition", "damage_to_property", "property",
    "number_of_vehicles", "number_of_injured", "number_of_fatality",
    "blockage_cleared", "site_cleared", "deployment_count", "injury_record_count", "vehicle_record_count",
  ];

  let skipped = 0;
  const transformed: any[][] = [];

  for (const row of rows) {
    const eventStartDate = row.event_start_date as string | null;
    const startKm = toNumOrNull(row.startkm);
    if (!eventStartDate || startKm === null) { skipped++; continue; }

    transformed.push([
      toNumOrNull(row.eventnumber),
      eventStartDate,
      row.eventtype ?? null,
      row.eventstatus ?? null,
      row.direction ?? null,
      row.location ?? null,
      row.sublocation ?? null,
      startKm,
      row.typeofevent ?? null,
      row.maincause ?? null,
      row.subcause ?? null,
      row.detection ?? null,
      row.weathercondition ?? null,
      row.damagetoproperty ?? null,
      row.property ?? null,
      toInt(row.numberofvehicles),
      toInt(row.numberofinjured),
      toInt(row.numberoffatality),
      row.blockagecleared ?? null,
      row.sitecleared ?? null,
      toInt(row.deployment_count),
      toInt(row.injury_record_count),
      toInt(row.vehicle_record_count),
    ]);
  }

  return {
    tableName: "bronze.nlex_accident_data",
    columns, rows: transformed, skipped,
    refreshSilver: REFRESH_ACCIDENT_SILVER,
  };
}

/**
 * breakdown_data: one row per vehicle-breakdown event, with an embedded
 * per-service (AAP/Patrol Vehicle/RAMFA/...) dispatch log in `deployments`
 * — see parseDeployments() above for why that field needs special handling.
 * MaterialTraffic is dropped: 100% NULL across all 5 years of source data.
 */
function transformBreakdownData(rows: RawRow[]): TransformResult {
  const columns = [
    "event_number", "event_encoded_date", "event_type", "event_status", "direction",
    "location", "sub_location", "start_km", "sloop", "vehicle", "vehicle_number",
    "type_of_vehicle", "vehicle_class", "plate_number", "driver", "main_cause", "sub_cause",
    "detection", "trouble_description", "detail_entry_count", "deployment_count", "deployments",
  ];

  let skipped = 0;
  const transformed: any[][] = [];

  for (const row of rows) {
    const eventDate = row.event_encoded_date as string | null;
    const startKm = toNumOrNull(row.startkm);
    if (!eventDate || startKm === null) { skipped++; continue; }

    transformed.push([
      toNumOrNull(row.eventnumber),
      eventDate,
      row.eventtype ?? null,
      row.eventstatus ?? null,
      row.direction ?? null,
      row.location ?? null,
      row.sublocation ?? null,
      startKm,
      toNumOrNull(row.sloop),
      row.vehicle ?? null,
      row.number === null || row.number === undefined ? null : String(row.number),
      row.typeofvehicle ?? null,
      row.vehicleclass ?? null,
      row.platenumber ?? null,
      row.driver ?? null,
      row.maincause ?? null,
      row.subcause ?? null,
      row.detection ?? null,
      row.troubledescription ?? null,
      toInt(row.detail_entry_count),
      toInt(row.deployment_count),
      parseDeployments(row.deployments),
    ]);
  }

  return {
    tableName: "bronze.nlex_breakdown_data",
    columns, rows: transformed, skipped,
    refreshSilver: REFRESH_BREAKDOWN_SILVER,
  };
}

function transformEmissions(rows: RawRow[]): TransformResult {
  // Theoretical (modelled, per-class grams) vs measured (OpenWeather AQI).
  const hasGrams = rows[0] && ("co2_grams" in rows[0] || "co_grams" in rows[0]);

  if (hasGrams) {
    const columns = [
      "exit_id", "timestamp_utc", "direction", "vehicle_class", "volume",
      "segment_distance_km", "co2_grams", "co_grams", "no2_grams",
      "pm25_grams", "pm10_grams", "so2_grams",
    ];

    let skipped = 0;
    const transformed: any[][] = [];

    for (const row of rows) {
      if (!row.timestamp_utc) { skipped++; continue; }
      transformed.push([
        toNumOrNull(row.exit_id),
        row.timestamp_utc,
        row.direction ?? "NB",
        parseVehicleClass(row.vehicle_class) ?? 1,
        toInt(row.volume),
        toNumOrNull(row.segment_distance_km) ?? 11.61,
        toNumOrNull(row.co2_grams) ?? 0,
        toNumOrNull(row.co_grams) ?? 0,
        toNumOrNull(row.no2_grams) ?? 0,
        toNumOrNull(row.pm25_grams),
        toNumOrNull(row.pm10_grams),
        toNumOrNull(row.so2_grams),
      ]);
    }

    return { tableName: "bronze.nlex_theoretical_emissions", columns, rows: transformed, skipped };
  }

  // Measured air quality
  const columns = [
    "exit_id", "exit_name", "direction", "latitude", "longitude",
    "aqi", "co", "no", "no2", "o3", "so2", "nh3", "pm2_5", "pm10", "recorded_at",
  ];

  let skipped = 0;
  const transformed: any[][] = [];

  for (const row of rows) {
    if (!row.timestamp_utc) { skipped++; continue; }
    transformed.push([
      toNumOrNull(row.exit_id),
      row.exit_name ?? null,
      row.direction ?? null,
      toNumOrNull(row.latitude),
      toNumOrNull(row.longitude),
      toInt(row.aqi),
      toNumOrNull(row.co) ?? 0,
      toNumOrNull(row.no) ?? 0,
      toNumOrNull(row.no2) ?? 0,
      toNumOrNull(row.o3) ?? 0,
      toNumOrNull(row.so2) ?? 0,
      toNumOrNull(row.nh3),
      toNumOrNull(row.pm2_5 ?? row.pm25) ?? 0,
      toNumOrNull(row.pm10) ?? 0,
      row.timestamp_utc,
    ]);
  }

  return { tableName: "bronze.nlex_emissions", columns, rows: transformed, skipped };
}

/**
 * Main transform function — delegates to the correct transformer
 */
export function transformData(rows: RawRow[], datasetType: DatasetType): TransformResult {
  switch (datasetType) {
    case "traffic_volume":
      return transformTrafficVolume(rows);
    case "road_crash":
      return transformCrash(rows, "road_crash");
    case "motorcycle_crash":
      return transformCrash(rows, "motorcycle_crash");
    case "stalled_vehicle":
      return transformStalledVehicle(rows);
    case "accident_data":
      return transformAccidentData(rows);
    case "breakdown_data":
      return transformBreakdownData(rows);
    case "emissions":
      return transformEmissions(rows);
    default:
      return { tableName: "", columns: [], rows: [], skipped: rows.length };
  }
}
