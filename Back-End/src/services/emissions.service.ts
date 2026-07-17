import { env } from "../config/env.js";

type CarbonEmissionInput = {
  time_reported: string;
  time_cleared: string;
  daily_volume: number;
};

type CarbonEmissionResult = {
  row_index: number;
  time_reported: string;
  time_cleared: string;
  daily_volume: number;
  delay_minutes: number;
  trapped_vehicles: number;
  idling_penalty_co2_kg: number;
};

type ClimatiqEstimateResponse = {
  co2e?: number;
};

function parseTimeToSeconds(value: string) {
  const [hours, minutes, seconds] = value.split(":").map(Number);

  if ([hours, minutes, seconds].some((part) => Number.isNaN(part))) {
    throw new Error("time_reported and time_cleared must use HH:MM:SS format");
  }

  return hours * 3600 + minutes * 60 + seconds;
}

async function getIdlingFactor() {
  if (!env.CLIMATIQ_API_KEY) {
    throw new Error("Missing CLIMATIQ_API_KEY");
  }

  const response = await fetch("https://beta4.api.climatiq.io/estimate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLIMATIQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      emission_factor: {
        activity_id: "passenger_vehicle-vehicle_type_car-fuel_source_petrol",
        region: "GLOBAL",
      },
      parameters: {
        distance: 1,
        distance_unit: "km",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Climatiq request failed with status ${response.status}`);
  }

  const data = (await response.json()) as ClimatiqEstimateResponse;
  return Number(data.co2e ?? 0) * 0.10;
}

function calculateRow(input: CarbonEmissionInput, rowIndex: number, idlingFactor: number): CarbonEmissionResult {
  const reportedSeconds = parseTimeToSeconds(input.time_reported);
  const clearedSeconds = parseTimeToSeconds(input.time_cleared);

  let delayMinutes = (clearedSeconds - reportedSeconds) / 60;
  if (delayMinutes < 0) {
    delayMinutes += 24 * 60;
  }

  const delayMinutesRounded = Number(delayMinutes.toFixed(2));
  const trappedVehicles = Math.round((input.daily_volume / 1440) * delayMinutesRounded);
  const idlingPenaltyCo2Kg = Number((trappedVehicles * delayMinutesRounded * idlingFactor).toFixed(2));

  return {
    row_index: rowIndex,
    time_reported: input.time_reported,
    time_cleared: input.time_cleared,
    daily_volume: input.daily_volume,
    delay_minutes: delayMinutesRounded,
    trapped_vehicles: trappedVehicles,
    idling_penalty_co2_kg: idlingPenaltyCo2Kg,
  };
}

import { db } from "../config/db.js";

// ---------------------------------------------------------------------------
// Emissions analytics for the descriptive dashboard.
// Sources: nlex_theoretical_emissions (hourly modeled CO2/pollutants per exit,
// direction, and vehicle class, from traffic volume x IPCC Tier 2 factors),
// nlex_emissions (measured air quality from OpenWeatherMap, AQI 1-5),
// nlex_emission_factors (per-class g/km factors), nlex_exits (segment names).
// All timestamps are UTC; local time = UTC+8.
// ---------------------------------------------------------------------------

export type EmissionsAnalyticsFilters = {
  months: "3" | "12" | "all";
  from?: string;
  to?: string;
};

type EmissionsCacheEntry = { at: number; data: unknown };
const emissionsCache = new Map<string, EmissionsCacheEntry>();
const EMISSIONS_CACHE_TTL_MS = 10 * 60 * 1000;

const LOCAL_DATE = `(timestamp_utc + interval '8 hours')::date`;
const LOCAL_HOUR = `EXTRACT(hour FROM timestamp_utc + interval '8 hours')::int`;

export async function getEmissionsAnalyticsFromDb(filters: EmissionsAnalyticsFilters) {
  if (!db) return null;

  const cacheKey = JSON.stringify(filters);
  const cached = emissionsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < EMISSIONS_CACHE_TTL_MS) return cached.data;

  try {
    const bounds = await db.query(
      `SELECT min(${LOCAL_DATE})::text AS lo, max(${LOCAL_DATE})::text AS hi FROM nlex_theoretical_emissions`
    );
    const minDate: string = bounds.rows[0].lo;
    const maxDate: string = bounds.rows[0].hi;

    let lo: string;
    let hi: string;
    if (filters.from && filters.to) {
      const [f, t] = filters.from <= filters.to ? [filters.from, filters.to] : [filters.to, filters.from];
      lo = f < minDate ? minDate : f;
      hi = t > maxDate ? maxDate : t;
    } else {
      // Month ranges anchor at the default year (2025), clamped to available data:
      // "12 mo" opens as calendar 2025, "3 mo" as Jan-Apr 2025.
      const anchor = "2025-01-01";
      lo = anchor < minDate ? minDate : anchor > maxDate ? minDate : anchor;
      hi =
        filters.months === "all"
          ? maxDate
          : (
              await db.query(`SELECT LEAST(($1::date + ($2 || ' months')::interval)::date, $3::date)::text AS hi`, [lo, filters.months, maxDate]))
              .rows[0].hi;
    }

    const params = [lo, hi];
    const WHERE = `${LOCAL_DATE} BETWEEN $1 AND $2`;

    const [trend, heatmap, classes, kpi, aqiMonthly, aqiKpi] = await Promise.all([
      // Daily CO2 (tonnes) by vehicle class and direction (client rolls up)
      db.query(
        `SELECT ${LOCAL_DATE}::text AS d,
                ROUND((SUM(co2_grams) FILTER (WHERE vehicle_class = 1) / 1e6)::numeric, 2)::float AS c1,
                ROUND((SUM(co2_grams) FILTER (WHERE vehicle_class = 2) / 1e6)::numeric, 2)::float AS c2,
                ROUND((SUM(co2_grams) FILTER (WHERE vehicle_class = 3) / 1e6)::numeric, 2)::float AS c3,
                ROUND((COALESCE(SUM(co2_grams) FILTER (WHERE direction = 'NB'), 0) / 1e6)::numeric, 2)::float AS nb,
                ROUND((COALESCE(SUM(co2_grams) FILTER (WHERE direction = 'SB'), 0) / 1e6)::numeric, 2)::float AS sb
         FROM nlex_theoretical_emissions WHERE ${WHERE}
         GROUP BY 1 ORDER BY 1`,
        params
      ),
      // CO2 tonnes per hour-of-day x day-of-week (client derives weekday/weekend profile)
      db.query(
        `SELECT EXTRACT(dow FROM ${LOCAL_DATE})::int AS dow, ${LOCAL_HOUR} AS hour,
                ROUND((SUM(co2_grams) / 1e6)::numeric, 2)::float AS v
         FROM nlex_theoretical_emissions WHERE ${WHERE}
         GROUP BY 1, 2 ORDER BY 1, 2`,
        params
      ),
      // Volume and emissions by vehicle class, with the per-km factors
      db.query(
        `SELECT t.vehicle_class AS class, MAX(f.class_label) AS label,
                MAX(f.co2_g_per_km)::float AS co2_g_per_km,
                SUM(t.volume)::bigint AS volume,
                ROUND((SUM(t.co2_grams) / 1e6)::numeric, 1)::float AS co2_t,
                ROUND((SUM(t.pm25_grams) / 1e3)::numeric, 1)::float AS pm25_kg,
                ROUND((SUM(t.no2_grams) / 1e3)::numeric, 1)::float AS no2_kg
         FROM nlex_theoretical_emissions t
         LEFT JOIN nlex_emission_factors f ON f.vehicle_class = t.vehicle_class
         WHERE ${WHERE}
         GROUP BY 1 ORDER BY 1`,
        params
      ),
      // KPI: current vs previous period CO2 (tonnes)
      db.query(
        `SELECT
           ROUND((SUM(co2_grams) FILTER (WHERE ${WHERE}) / 1e6)::numeric, 1)::float AS cur_t,
           ROUND((SUM(co2_grams) FILTER (WHERE ${LOCAL_DATE} >= $1::date - ($2::date - $1::date + 1) AND ${LOCAL_DATE} < $1::date) / 1e6)::numeric, 1)::float AS prev_t
         FROM nlex_theoretical_emissions
         WHERE ${LOCAL_DATE} >= $1::date - ($2::date - $1::date + 1) AND ${LOCAL_DATE} <= $2`,
        params
      ),
      // Measured air quality: monthly hours per AQI level + avg PM2.5
      db.query(
        `SELECT to_char(to_timestamp(api_dt) + interval '8 hours', 'YYYY-MM') AS m,
                COUNT(*) FILTER (WHERE aqi <= 2)::int AS good,
                COUNT(*) FILTER (WHERE aqi = 3)::int AS moderate,
                COUNT(*) FILTER (WHERE aqi >= 4)::int AS poor,
                ROUND(AVG(pm2_5)::numeric, 1)::float AS pm25
         FROM nlex_emissions
         WHERE (to_timestamp(api_dt) + interval '8 hours')::date BETWEEN $1 AND $2
         GROUP BY 1 ORDER BY 1`,
        params
      ),
      // Measured air quality KPI: avg AQI + sample count in range
      db.query(
        `SELECT ROUND(AVG(aqi)::numeric, 2)::float AS avg_aqi, COUNT(*)::int AS samples,
                ROUND(AVG(pm2_5)::numeric, 1)::float AS avg_pm25
         FROM nlex_emissions
         WHERE (to_timestamp(api_dt) + interval '8 hours')::date BETWEEN $1 AND $2`,
        params
      ),
    ]);

    const data = {
      range: { from: lo, to: hi },
      meta: { minDate, maxDate },
      kpis: {
        totalCo2T: kpi.rows[0].cur_t ?? 0,
        prevCo2T: kpi.rows[0].prev_t ?? 0,
        avgAqi: aqiKpi.rows[0].avg_aqi,
        aqiSamples: aqiKpi.rows[0].samples,
        avgPm25: aqiKpi.rows[0].avg_pm25,
      },
      dailyTrend: trend.rows,
      heatmap: heatmap.rows,
      classes: classes.rows.map((r) => ({ ...r, volume: Number(r.volume) })),
      aqiMonthly: aqiMonthly.rows,
    };

    emissionsCache.set(cacheKey, { at: Date.now(), data });
    return data;
  } catch (error) {
    console.error("Database query failed for emissions analytics:", error);
    return null;
  }
}

// [DEV-01] Get Emissions Index and AQI
export async function getEmissionsIndexFromDb() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`SELECT * FROM emissions_log ORDER BY recorded_at DESC LIMIT 1`);
    return rows[0];
  } catch (error) {
    console.error("Database query failed for emissions index:", error);
    return null;
  }
}

// [DEV-01] Get Peak Penalty
export async function getPeakPenaltyFromDb() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT COUNT(*) as penalty_count, SUM(co2_emissions_tons) as excess_emissions
      FROM emissions_log
      WHERE peak_penalty_applied = TRUE
    `);
    return rows[0];
  } catch (error) {
    console.error("Database query failed for peak penalty:", error);
    return null;
  }
}

// [DEV-02] Get Climate Resilience Metrics
export async function getClimateResilienceFromDb() {
  if (!db) return null;
  try {
    // A simplified metric joining incident weather data
    const { rows } = await db.query(`
      SELECT weather_condition, COUNT(*) as preventable_incidents
      FROM incidents_table
      GROUP BY weather_condition
    `);
    return rows;
  } catch (error) {
    console.error("Database query failed for climate resilience:", error);
    return null;
  }
}

export async function getEmissionsData() {
  return {
    module: "emissions",
    message: "emissions API ready",
    updatedAt: new Date().toISOString(),
  };
}

export async function calculateCarbonEmissionData(input: CarbonEmissionInput) {
  const idlingFactor = await getIdlingFactor();
  return calculateRow(input, 1, idlingFactor);
}

export async function calculateCarbonEmissionBatch(inputs: CarbonEmissionInput[]) {
  const idlingFactor = await getIdlingFactor();
  return inputs.map((input, index) => calculateRow(input, index + 1, idlingFactor));
}
