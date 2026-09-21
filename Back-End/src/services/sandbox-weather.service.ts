import { db } from "../config/db.js";

/* ══════════════════════════════════════════════════════════════════════════════
   RECORDED RAIN FOR A SANDBOX SCENARIO

   The predictive modules read public.hourly_weather — ERA5 and Open-Meteo, one
   row per weather location per hour, at the 20 exits' own coordinates. This
   serves one reading from it: the rain recorded at the location nearest the
   simulated stretch, for the forecast day and hour being simulated.

   It is RECORDED weather, not forecast weather. The traffic forecast for the
   same day was deliberately made without it (the volume model uses
   day-of-year climatology over its forecast window so it cannot see the
   future), so the sandbox labels this as recorded and keeps the two apart.

   The reading is classed by PAGASA's hourly rainfall intensity (memorandum of
   20 June 2012). The simulation models light, moderate and heavy only — the
   HCM studies behind its rain effects do not reach PAGASA's "intense"
   (15-30 mm/h) or "torrential" (> 30 mm/h) — so those hours are simulated as
   heavy and flagged as capped rather than extrapolated.
══════════════════════════════════════════════════════════════════════════════ */

export type PagasaClass = "none" | "light" | "moderate" | "heavy" | "intense" | "torrential";
export type SimRainLevel = "dry" | "light" | "moderate" | "heavy";

export type RecordedRain = {
  date: string;
  hour: number;
  location: string;
  distanceKm: number;
  /** Rain over the hour, mm — i.e. the hour's intensity in mm/h. */
  rainfallMm: number;
  source: string;
  /** The row was filled in where the source had a gap. */
  imputed: boolean;
  pagasaClass: PagasaClass;
  /** What the simulation runs with. */
  simLevel: SimRainLevel;
  /** True when the recorded class is heavier than the simulation models. */
  capped: boolean;
};

export function pagasaClass(mmPerHour: number): PagasaClass {
  if (!(mmPerHour > 0)) return "none";
  if (mmPerHour < 2.5) return "light";
  if (mmPerHour < 7.5) return "moderate";
  if (mmPerHour < 15) return "heavy";
  if (mmPerHour <= 30) return "intense";
  return "torrential";
}

const toSim = (c: PagasaClass): SimRainLevel =>
  c === "none" ? "dry" : c === "intense" || c === "torrential" ? "heavy" : c;

const haversineKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
};

/**
 * Rain recorded at the weather location nearest (lat, lon) during the given
 * Manila-time hour. Null when the warehouse is unreachable or holds no reading
 * for that hour.
 */
export async function getRecordedRain(
  date: string,
  hour: number,
  lat: number,
  lon: number,
): Promise<RecordedRain | null> {
  if (!db) return null;
  // The sandbox's days and hours are Manila local time; the table is UTC.
  const ts = `${date}T${String(hour).padStart(2, "0")}:00:00+08:00`;
  const { rows } = await db.query<{
    location_name: string;
    lat: number;
    lon: number;
    rainfall: number;
    rainfall_source: string | null;
    is_imputed: boolean | null;
  }>(
    `SELECT location_name, latitude::float AS lat, longitude::float AS lon,
            rainfall::float AS rainfall, rainfall_source, is_imputed
       FROM public.hourly_weather
      WHERE timestamp_utc = $1::timestamptz AND rainfall IS NOT NULL
      ORDER BY (latitude - $2) ^ 2 + ((longitude - $3) * cos(radians($2))) ^ 2
      LIMIT 1`,
    [ts, lat, lon],
  );
  const row = rows[0];
  if (!row) return null;

  const cls = pagasaClass(row.rainfall);
  return {
    date,
    hour,
    location: row.location_name,
    distanceKm: Math.round(haversineKm(lat, lon, row.lat, row.lon) * 100) / 100,
    rainfallMm: Math.round(row.rainfall * 100) / 100,
    source: row.rainfall_source === "era5" ? "ERA5" : row.rainfall_source === "open_meteo" ? "Open-Meteo" : row.rainfall_source ?? "unknown",
    imputed: Boolean(row.is_imputed),
    pagasaClass: cls,
    simLevel: toSim(cls),
    capped: cls === "intense" || cls === "torrential",
  };
}
