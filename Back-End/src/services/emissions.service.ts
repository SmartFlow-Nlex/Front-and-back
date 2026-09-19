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

// nlex_theoretical_emissions.timestamp_utc is a naive `timestamp without time
// zone` that, despite the column name, already holds Philippine local time.
// Verified against the toll matview, whose h00..h23 columns are local hours:
// the unshifted emissions volume peaks at 07:00 and 17:00, matching the toll
// peaks exactly, while adding 8 hours moves them to 01:00 and 15:00.
//
// So no offset is applied here. (The measured-AQI queries further down do add
// 8 hours, correctly — those read nlex_emissions.api_dt, a real Unix epoch.)
// Measured AQI carries a real timestamptz observation time (silver derives it
// from the source's api_dt epoch), so local time is a timezone conversion rather
// than a manual +8h on a naive value.
const AQI_LOCAL = `recorded_at AT TIME ZONE 'Asia/Manila'`;

const LOCAL_DATE = `timestamp_utc::date`;
const LOCAL_HOUR = `EXTRACT(hour FROM timestamp_utc)::int`;

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
        `SELECT to_char(${AQI_LOCAL}, 'YYYY-MM') AS m,
                COUNT(*) FILTER (WHERE aqi <= 2)::int AS good,
                COUNT(*) FILTER (WHERE aqi = 3)::int AS moderate,
                COUNT(*) FILTER (WHERE aqi >= 4)::int AS poor,
                ROUND(AVG(pm2_5)::numeric, 1)::float AS pm25
         FROM nlex_emissions
         WHERE (${AQI_LOCAL})::date BETWEEN $1 AND $2
         GROUP BY 1 ORDER BY 1`,
        params
      ),
      // Measured air quality KPI: avg AQI + sample count in range
      db.query(
        `SELECT ROUND(AVG(aqi)::numeric, 2)::float AS avg_aqi, COUNT(*)::int AS samples,
                ROUND(AVG(pm2_5)::numeric, 1)::float AS avg_pm25
         FROM nlex_emissions
         WHERE (${AQI_LOCAL})::date BETWEEN $1 AND $2`,
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

// Measured air quality lives in nlex_emissions (OpenWeather per-exit readings)
// and modelled output in nlex_theoretical_emissions. The flat emissions_log /
// incidents_table from the original schema were never loaded, so the three
// endpoints below read the populated tables and keep the original result keys.

// [DEV-01] Get Emissions Index and AQI
export async function getEmissionsIndexFromDb() {
  if (!db) return null;
  try {
    // Corridor-wide snapshot at the most recent reading timestamp, rather than
    // a single exit's row — one exit is not representative of the corridor.
    const { rows } = await db.query(`
      WITH latest AS (SELECT MAX(recorded_at) AS ts FROM nlex_emissions)
      SELECT ROUND(AVG(e.aqi)::numeric, 2)::float    AS aqi_level,
             ROUND(AVG(e.pm2_5)::numeric, 2)::float  AS pm2_5,
             ROUND(AVG(e.pm10)::numeric, 2)::float   AS pm10,
             ROUND(AVG(e.no2)::numeric, 2)::float    AS no2,
             ROUND(AVG(e.co)::numeric, 2)::float     AS co,
             ROUND(AVG(e.o3)::numeric, 2)::float     AS o3,
             COUNT(*)::int                           AS exits_sampled,
             latest.ts                               AS recorded_at
      FROM nlex_emissions e, latest
      WHERE e.recorded_at = latest.ts
      GROUP BY latest.ts
    `);
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
    // "Peak penalty" = the extra CO2 emitted during rush hours (06:00-09:00 and
    // 16:00-19:00 PHT) above the same period's off-peak hourly average.
    // The original peak_penalty_applied flag has no equivalent in this
    // warehouse, so it is derived from the modelled hourly emissions instead.
    const { rows } = await db.query(`
      WITH hourly AS (
        SELECT ${LOCAL_HOUR} AS h,
               SUM(co2_grams) / 1e6 AS co2_tons
        FROM nlex_theoretical_emissions
        WHERE co2_grams IS NOT NULL AND co2_grams::text <> 'NaN'
        GROUP BY 1
      ), split AS (
        SELECT
          SUM(co2_tons) FILTER (WHERE h BETWEEN 6 AND 8 OR h BETWEEN 16 AND 18) AS peak_total,
          COUNT(*)      FILTER (WHERE h BETWEEN 6 AND 8 OR h BETWEEN 16 AND 18) AS peak_hours,
          AVG(co2_tons) FILTER (WHERE NOT (h BETWEEN 6 AND 8 OR h BETWEEN 16 AND 18)) AS offpeak_avg
        FROM hourly
      )
      SELECT peak_hours::int                                              AS penalty_count,
             ROUND((peak_total - offpeak_avg * peak_hours)::numeric, 1)::float AS excess_emissions,
             ROUND(peak_total::numeric, 1)::float                         AS peak_emissions,
             ROUND((offpeak_avg * peak_hours)::numeric, 1)::float         AS baseline_emissions
      FROM split
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
    // Incidents grouped by the weather at the hour they were reported, using
    // the same >0.3mm wet/dry rule as the incident dashboard.
    const { rows } = await db.query(`
      WITH wx AS (
        SELECT (timestamp_utc + interval '8 hours')::date AS d,
               EXTRACT(hour FROM timestamp_utc + interval '8 hours')::int AS h,
               AVG(rainfall) > 0.3 AS wet
        FROM hourly_weather
        GROUP BY 1, 2
      )
      SELECT CASE WHEN w.wet THEN 'Rainy' ELSE 'Clear' END AS weather_condition,
             COUNT(*)::int AS preventable_incidents
      FROM fact_incident_log f
      JOIN wx w ON w.d = f.date_day AND w.h = f.hour_of_day
      GROUP BY 1 ORDER BY 2 DESC
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

/* ── Fleet-mix forecast ──────────────────────────────────────────────────────
 *
 * Serves gold.ml_predictive_fleet_mix, written by
 * smartflow_scripts/3_training_testing/fleet_mix/train_fleet_mix.py.
 *
 * Shares are stored as fractions summing to 1, not percentages, and are
 * returned that way — the conversion belongs at the point of display, so a
 * caller doing arithmetic never has to guess which scale it is holding.
 *
 * The response carries the model leaderboard alongside the series for the same
 * reason the CO2 panel does: a forecast shown without the evidence that it beat
 * a trivial baseline is a line on a chart, not a result. `rejected_reason`
 * travels too, so the panel can show WHY the LSTM was not used rather than
 * quietly omitting it.
 */
export async function getFleetMixForecast(days?: number) {
  if (!db) return null;

  try {
    const params: unknown[] = [];
    let where = "";
    if (days != null) {
      // Anchored to the last OBSERVED day, never to now(): the projection block
      // extends past the data, and a window measured from today would crop it.
      where = `WHERE forecast_date >= (
                 SELECT MAX(forecast_date) - ($1::int * INTERVAL '1 day')
                 FROM gold.ml_predictive_fleet_mix WHERE actual_c1 IS NOT NULL)`;
      params.push(days);
    }

    const [seriesQ, splitQ, metricsQ] = await Promise.all([
      db.query(
        `SELECT forecast_date::text AS d,
                actual_c1::float, actual_c2::float, actual_c3::float,
                pred_c1::float, pred_c2::float, pred_c3::float,
                heavy_pred::float, heavy_surge, champion_model,
                is_holdout, is_future
         FROM gold.ml_predictive_fleet_mix ${where}
         ORDER BY forecast_date ASC`, params),
      db.query(
        `SELECT COUNT(*) FILTER (WHERE NOT is_holdout AND NOT is_future)::int AS context_days,
                COUNT(*) FILTER (WHERE is_holdout)::int AS holdout_days,
                COUNT(*) FILTER (WHERE is_future)::int  AS future_days,
                COUNT(*) FILTER (WHERE heavy_surge)::int AS surge_days,
                MIN(forecast_date) FILTER (WHERE is_future)::text AS future_start,
                MAX(forecast_date) FILTER (WHERE is_future)::text AS future_end,
                MAX(updated_at)::text AS updated_at
         FROM gold.ml_predictive_fleet_mix`),
      db.query(
        `SELECT model_name, rank, accepted, mae, rmse, wmape, r2, mase, mape,
                rejected_reason, diagnosis, split_label, updated_at
         FROM gold.ml_model_metrics
         WHERE target = 'Fleet Mix'
         ORDER BY accepted DESC, rank NULLS LAST, mase ASC`),
    ]);

    const champion = seriesQ.rows.find((r) => r.champion_model)?.champion_model ?? null;

    return {
      champion,
      series: seriesQ.rows,
      split: splitQ.rows[0] ?? null,
      // `mase` here holds the skill ratio against persistence and `mae` the
      // mean per-class error in percentage points — the metrics table is shared
      // with the other targets, so the columns are reused rather than added to.
      models: metricsQ.rows,
    };
  } catch (error) {
    console.error("Database query failed for fleet-mix forecast:", error);
    return null;
  }
}

/* ── Fleet profile for the simulation sandbox ────────────────────────────────
 *
 * The sandbox modelled CO2 from constants compiled into the browser bundle —
 * 160/550/950 g/km against the 192/354/1492 in nlex_emission_factors, and a
 * fleet of 78/16/6 against an observed 78.1/13.0/8.9. So the sandbox's CO2
 * rate and the Emissions dashboard computed the same quantity from different
 * numbers, and the sandbox understated heavy-vehicle output by a third —
 * precisely the traffic its heavy-vehicle restriction strategy exists to
 * target.
 *
 * This serves both from the warehouse so there is one source for them.
 */
export async function getFleetProfile() {
  if (!db) return null;
  try {
    const [factors, mix] = await Promise.all([
      db.query(
        `SELECT vehicle_class, class_label, co2_g_per_km::float
         FROM nlex_emission_factors ORDER BY vehicle_class`,
      ),
      db.query(
        `SELECT SUM(class_1)::float AS c1, SUM(class_2)::float AS c2, SUM(class_3)::float AS c3
         FROM gold.fact_traffic_hourly`,
      ),
    ]);
    const m = mix.rows[0] ?? { c1: 0, c2: 0, c3: 0 };
    const total = (m.c1 ?? 0) + (m.c2 ?? 0) + (m.c3 ?? 0);
    return {
      factors: factors.rows,
      // Shares as fractions summing to 1, the same convention the fleet-mix
      // forecast uses, so nothing downstream has to guess the scale.
      mix: total > 0
        ? { 1: m.c1 / total, 2: m.c2 / total, 3: m.c3 / total }
        : null,
      source: "nlex_emission_factors + gold.fact_traffic_hourly",
    };
  } catch (error) {
    console.error("Database query failed for fleet profile:", error);
    return null;
  }
}
