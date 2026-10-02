import { db } from "../config/db.js";
import { delayCarbon, EMISSIONS_TABLE, recordBounds } from "./emissions-source.js";

// ---------------------------------------------------------------------------
// Emissions analytics for the descriptive dashboard.
// Sources: gold.fact_emissions_hourly (hourly CO2 per exit and direction, from
// the toll counts x segment km x the DENR/DOTC per-class factors; see
// emissions-source.ts for why this and not nlex_theoretical_emissions),
// nlex_emissions (measured air quality from OpenWeatherMap, AQI 1-5) and
// nlex_emission_factors (per-class g/km factors). Dates and hours are local.
// ---------------------------------------------------------------------------

export type EmissionsAnalyticsFilters = {
  months: "3" | "12" | "all";
  from?: string;
  to?: string;
};

type EmissionsCacheEntry = { at: number; data: unknown };
const emissionsCache = new Map<string, EmissionsCacheEntry>();
const EMISSIONS_CACHE_TTL_MS = 10 * 60 * 1000;

// Measured AQI carries a real timestamptz observation time (silver derives it
// from the source's api_dt epoch), so local time is a timezone conversion.
const AQI_LOCAL = `recorded_at AT TIME ZONE 'Asia/Manila'`;

/* Per-class CO2, PM2.5 and NO2 from the record's per-class vehicle counts: count
   x segment km x the class's factor. Summed this way they add up to the
   record's own co2_tonnes exactly (checked on 2025-06-01: 318.395 t both ways). */
const FACTORS = `CROSS JOIN (SELECT
    max(co2_g_per_km) FILTER (WHERE vehicle_class = 1) AS f1,
    max(co2_g_per_km) FILTER (WHERE vehicle_class = 2) AS f2,
    max(co2_g_per_km) FILTER (WHERE vehicle_class = 3) AS f3
  FROM nlex_emission_factors) f`;

export async function getEmissionsAnalyticsFromDb(filters: EmissionsAnalyticsFilters) {
  if (!db) return null;

  const cacheKey = JSON.stringify(filters);
  const cached = emissionsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < EMISSIONS_CACHE_TTL_MS) return cached.data;

  try {
    const { minDate, maxDate } = await recordBounds();

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
              await db.query(`SELECT LEAST(($1::date + ($2 || ' months')::interval - interval '1 day')::date, $3::date)::text AS hi`, [lo, filters.months, maxDate]))
              .rows[0].hi;
    }

    const params = [lo, hi];
    const WHERE = `e.date BETWEEN $1 AND $2`;

    const [trend, heatmap, classes, kpi, aqiMonthly, aqiKpi, exits, delay] = await Promise.all([
      // Daily CO2 (tonnes) by vehicle class, and by direction: northbound, southbound, and the
      // plazas the record does not split by direction (bothdir), so the three add up to the day.
      db.query(
        `SELECT e.date::text AS d,
                ROUND((SUM(e.class_1 * e.segment_km) * MAX(f.f1) / 1e6)::numeric, 2)::float AS c1,
                ROUND((SUM(e.class_2 * e.segment_km) * MAX(f.f2) / 1e6)::numeric, 2)::float AS c2,
                ROUND((SUM(e.class_3 * e.segment_km) * MAX(f.f3) / 1e6)::numeric, 2)::float AS c3,
                ROUND(COALESCE(SUM(e.co2_tonnes) FILTER (WHERE e.direction = 'NB'), 0)::numeric, 2)::float AS nb,
                ROUND(COALESCE(SUM(e.co2_tonnes) FILTER (WHERE e.direction = 'SB'), 0)::numeric, 2)::float AS sb,
                ROUND(COALESCE(SUM(e.co2_tonnes) FILTER (WHERE e.direction IS NULL OR e.direction NOT IN ('NB', 'SB')), 0)::numeric, 2)::float AS bothdir
         FROM ${EMISSIONS_TABLE} e ${FACTORS}
         WHERE ${WHERE}
         GROUP BY 1 ORDER BY 1`,
        params
      ),
      // CO2 tonnes per hour-of-day x day-of-week (client derives weekday/weekend profile)
      db.query(
        `SELECT EXTRACT(dow FROM e.date)::int AS dow, e.hour::int AS hour,
                ROUND(SUM(e.co2_tonnes)::numeric, 2)::float AS v
         FROM ${EMISSIONS_TABLE} e WHERE ${WHERE}
         GROUP BY 1, 2 ORDER BY 1, 2`,
        params
      ),
      // Volume and emissions by vehicle class, with the per-km factors
      db.query(
        `WITH s AS (
           SELECT SUM(class_1) AS v1, SUM(class_1 * segment_km) AS k1,
                  SUM(class_2) AS v2, SUM(class_2 * segment_km) AS k2,
                  SUM(class_3) AS v3, SUM(class_3 * segment_km) AS k3
             FROM ${EMISSIONS_TABLE} e WHERE ${WHERE})
         SELECT f.vehicle_class AS class, f.class_label AS label, f.co2_g_per_km::float AS co2_g_per_km,
                ROUND(CASE f.vehicle_class WHEN 1 THEN s.v1 WHEN 2 THEN s.v2 ELSE s.v3 END)::bigint AS volume,
                ROUND((CASE f.vehicle_class WHEN 1 THEN s.k1 WHEN 2 THEN s.k2 ELSE s.k3 END * f.co2_g_per_km / 1e6)::numeric, 1)::float AS co2_t,
                ROUND((CASE f.vehicle_class WHEN 1 THEN s.k1 WHEN 2 THEN s.k2 ELSE s.k3 END * f.pm25_g_per_km / 1e3)::numeric, 1)::float AS pm25_kg,
                ROUND((CASE f.vehicle_class WHEN 1 THEN s.k1 WHEN 2 THEN s.k2 ELSE s.k3 END * f.no2_g_per_km / 1e3)::numeric, 1)::float AS no2_kg
         FROM nlex_emission_factors f CROSS JOIN s
         WHERE f.vehicle_class IN (1, 2, 3)
         ORDER BY 1`,
        params
      ),
      // KPI: current vs previous period CO2 (tonnes)
      db.query(
        `SELECT
           ROUND((SUM(co2_tonnes) FILTER (WHERE date BETWEEN $1 AND $2))::numeric, 1)::float AS cur_t,
           ROUND((SUM(co2_tonnes) FILTER (WHERE date >= $1::date - ($2::date - $1::date + 1) AND date < $1::date))::numeric, 1)::float AS prev_t
         FROM ${EMISSIONS_TABLE}
         WHERE date >= $1::date - ($2::date - $1::date + 1) AND date <= $2`,
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
      db.query(`SELECT COUNT(DISTINCT exit_canonical)::int AS n FROM ${EMISSIONS_TABLE} e WHERE ${WHERE}`, params),
      // Delay-induced carbon: the idling of the queues behind cleared accidents in the Range.
      delayCarbon(lo, hi),
    ]);

    const totalCo2T = kpi.rows[0].cur_t ?? 0;
    const data = {
      range: { from: lo, to: hi },
      meta: { minDate, maxDate, source: EMISSIONS_TABLE, exits: exits.rows[0]?.n ?? 0 },
      kpis: {
        totalCo2T,
        prevCo2T: kpi.rows[0].prev_t ?? 0,
        avgAqi: aqiKpi.rows[0].avg_aqi,
        aqiSamples: aqiKpi.rows[0].samples,
        avgPm25: aqiKpi.rows[0].avg_pm25,
        delayCarbonT: Math.round(delay.tonnes * 10) / 10,
        delayCarbonPct: totalCo2T > 0 ? Math.round((delay.tonnes / totalCo2T) * 10000) / 100 : 0,
        delayIncidents: delay.incidents,
        delayLongIncidents: delay.longIncidents,
        delayLongSharePct: Math.round(delay.longSharePct * 10) / 10,
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
// and the CO2 record in gold.fact_emissions_hourly. The flat emissions_log /
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
        SELECT hour::int AS h, SUM(co2_tonnes) AS co2_tons
        FROM ${EMISSIONS_TABLE}
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

/* Fleet-mix forecast and the observed fleet profile.
 *
 * Ported from the hans4 tree, where FleetMixForecastChart was already
 * mounted and working. The chart component came across in the earlier port
 * but these did not, so the panel called /api/emissions/fleet-mix, found no
 * such route, fell through to the authenticateToken guard below it, and
 * reported "Access token is required" — a misleading error for a missing
 * endpoint. */
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
