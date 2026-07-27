/**
 * ETL Transformer — Maps cleaned rows to the exact database schema
 */
import type { RawRow } from "./parser.js";
import type { DatasetType } from "./classifier.js";

export interface TransformResult {
  tableName: string;
  columns: string[];
  rows: any[][];
  skipped: number;
}

function transformTrafficVolume(rows: RawRow[]): TransformResult {
  const columns = [
    "date", "direction", "type", "toll_plaza", "vehicle_class",
    "h00", "h01", "h02", "h03", "h04", "h05", "h06", "h07",
    "h08", "h09", "h10", "h11", "h12", "h13", "h14", "h15",
    "h16", "h17", "h18", "h19", "h20", "h21", "h22", "h23",
  ];

  let skipped = 0;
  const transformed: any[][] = [];

  for (const row of rows) {
    const date = row.date;
    const direction = row.direction;
    const type = row.type ?? "Entries";
    const plaza = row.toll_plaza ?? row.plaza;
    const vc = row.vehicle_class;

    if (!date || !direction || !plaza) {
      skipped++;
      continue;
    }

    const hourlyValues: number[] = [];
    for (let h = 0; h < 24; h++) {
      const keyH = `h${String(h).padStart(2, "0")}`;
      const keyNum = `${String(h).padStart(2, "0")}_00`;
      const val = row[keyH] ?? row[keyNum];
      hourlyValues.push(typeof val === "number" ? val : (val ? parseInt(String(val).replace(/,/g, ''), 10) || 0 : 0));
    }

    transformed.push([date, direction, type, plaza, vc, ...hourlyValues]);
  }

  return { tableName: "nlex_traffic_volume", columns, rows: transformed, skipped };
}

function transformRoadCrash(rows: RawRow[]): TransformResult {
  const columns = [
    "date", "reported_time", "response_time", "cleared_time", "location",
    "lane_occupied", "no_of_vehicles_involved", "cause_of_accident",
    "type_of_accident", "weather_condition", "type_of_pavement",
    "injuries_male", "injuries_female", "fatalities_male", "fatalities_female",
    "damage_to_toll_property",
  ];

  let skipped = 0;
  const transformed: any[][] = [];

  for (const row of rows) {
    if (!row.date || !row.location) { skipped++; continue; }
    transformed.push([
      row.date, row.reported_time, row.response_time, row.cleared_time,
      row.location, row.lane_occupied,
      typeof row.no_of_vehicles_involved === "number" ? row.no_of_vehicles_involved : parseInt(String(row.no_of_vehicles_involved ?? "0"), 10),
      row.cause_of_accident, row.type_of_accident,
      row.weather_condition, row.type_of_pavement,
      row.injuries_male ?? 0, row.injuries_female ?? 0,
      row.fatalities_male ?? 0, row.fatalities_female ?? 0,
      row.damage_to_toll_property,
    ]);
  }

  return { tableName: "nlex_road_crashes", columns, rows: transformed, skipped };
}

function transformStalledVehicle(rows: RawRow[]): TransformResult {
  const columns = [
    "date", "reported_time", "responded_time", "cleared_time",
    "entry_point", "vehicle_cause", "location",
    "driver_gender", "assistance_rendered", "remarks",
  ];

  let skipped = 0;
  const transformed: any[][] = [];

  for (const row of rows) {
    if (!row.date || !row.location) { skipped++; continue; }
    transformed.push([
      row.date, row.reported_time, row.responded_time, row.cleared_time,
      row.entry_point ?? "NLEX", row.vehicle_cause, row.location,
      row.driver_gender, row.assistance_rendered, row.remarks,
    ]);
  }

  return { tableName: "nlex_stalled_vehicles", columns, rows: transformed, skipped };
}

function transformMotorcycleCrash(rows: RawRow[]): TransformResult {
  // Use same schema as road crashes — motorcycle_crashes has identical columns
  const columns = [
    "date", "reported_time", "response_time", "cleared_time", "location",
    "lane_occupied", "no_of_vehicles_involved", "cause_of_accident",
    "type_of_accident", "weather_condition", "type_of_pavement",
    "injuries_male", "injuries_female", "fatalities_male", "fatalities_female",
    "damage_to_toll_property",
  ];

  let skipped = 0;
  const transformed: any[][] = [];

  for (const row of rows) {
    if (!row.date || !row.location) { skipped++; continue; }
    transformed.push([
      row.date, row.reported_time, row.response_time, row.cleared_time,
      row.location, row.lane_occupied,
      row.no_of_vehicles_involved ?? 1,
      row.cause_of_accident, row.type_of_accident,
      row.weather_condition, row.type_of_pavement,
      row.injuries_male ?? 0, row.injuries_female ?? 0,
      row.fatalities_male ?? 0, row.fatalities_female ?? 0,
      row.damage_to_toll_property,
    ]);
  }

  return { tableName: "nlex_motorcycle_crashes", columns, rows: transformed, skipped };
}

function transformEmissions(rows: RawRow[]): TransformResult {
  // Detect if it's theoretical (Climatiq) or measured (OpenWeather)
  const hasGrams = rows[0] && ("co2_grams" in rows[0] || "co_grams" in rows[0]);

  if (hasGrams) {
    const columns = [
      "timestamp_utc", "direction", "vehicle_class", "volume",
      "segment_distance_km", "co2_grams", "co_grams", "no2_grams",
      "pm25_grams", "pm10_grams", "so2_grams", "methodology_tier",
    ];

    let skipped = 0;
    const transformed: any[][] = [];

    for (const row of rows) {
      if (!row.timestamp_utc) { skipped++; continue; }
      transformed.push([
        row.timestamp_utc, row.direction ?? "NB", row.vehicle_class ?? 1,
        row.volume ?? 0, row.segment_distance_km ?? 11.61,
        row.co2_grams ?? 0, row.co_grams ?? 0, row.no2_grams ?? 0,
        row.pm25_grams ?? 0, row.pm10_grams ?? 0, row.so2_grams ?? 0,
        row.methodology_tier ?? "Uploaded via ETL Pipeline",
      ]);
    }

    return { tableName: "nlex_theoretical_emissions", columns, rows: transformed, skipped };
  } else {
    // OpenWeather AQI format
    const columns = ["aqi", "co", "no", "no2", "o3", "so2", "nh3", "pm2_5", "pm10", "data_confidence"];

    let skipped = 0;
    const transformed: any[][] = [];

    for (const row of rows) {
      transformed.push([
        row.aqi ?? 0, row.co ?? 0, row.no ?? 0, row.no2 ?? 0,
        row.o3 ?? 0, row.so2 ?? 0, row.nh3 ?? null,
        row.pm2_5 ?? row.pm25 ?? 0, row.pm10 ?? 0,
        row.data_confidence ?? "Uploaded via ETL Pipeline",
      ]);
    }

    return { tableName: "nlex_emissions", columns, rows: transformed, skipped };
  }
}

/**
 * Main transform function — delegates to the correct transformer
 */
export function transformData(rows: RawRow[], datasetType: DatasetType): TransformResult {
  switch (datasetType) {
    case "traffic_volume":
      return transformTrafficVolume(rows);
    case "road_crash":
      return transformRoadCrash(rows);
    case "stalled_vehicle":
      return transformStalledVehicle(rows);
    case "motorcycle_crash":
      return transformMotorcycleCrash(rows);
    case "emissions":
      return transformEmissions(rows);
    default:
      return { tableName: "", columns: [], rows: [], skipped: rows.length };
  }
}
