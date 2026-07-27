import { db } from "../config/db.js";

// Hourly columns of nlex_traffic_volume (h00..h23)
const HOUR_COLS = Array.from({ length: 24 }, (_, i) => `h${String(i).padStart(2, "0")}`);
const DAY_TOTAL = HOUR_COLS.join(" + ");
const HOUR_ARRAY = `ARRAY[${HOUR_COLS.join(", ")}]`;

export type AnalyticsRange = "3" | "12" | "all";

export type AnalyticsFilters = {
  months: AnalyticsRange;
  from?: string; // YYYY-MM-DD; with `to`, overrides months
  to?: string;
  plazas?: string[];
  direction?: "NB" | "SB";
  vehicleClass?: "Class 1" | "Class 2" | "Class 3";
  weather?: "all" | "dry" | "wet";
};

type CacheEntry = { at: number; data: unknown };
const analyticsCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function getTrafficAnalyticsFromDb(filters: AnalyticsFilters) {
  if (!db) return null;

  const cacheKey = JSON.stringify(filters);
  const cached = analyticsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  try {
    const bounds = await db.query(
      `SELECT min(date)::text AS lo, max(date)::text AS hi FROM nlex_traffic_volume`
    );
    const minDate: string = bounds.rows[0].lo;
    const maxDate: string = bounds.rows[0].hi;

    let lo: string;
    let hi: string;
    if (filters.from && filters.to) {
      // Custom range (swap if reversed, clamp to available data)
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
              await db.query(`SELECT LEAST(($1::date + ($2 || ' months')::interval)::date, $3::date)::text AS hi`, [
                lo,
                filters.months,
                maxDate,
              ])
            ).rows[0].hi;
    }

    // Hourly detail is heavy and noisy beyond ~2 weeks; only ship it for short spans
    const spanDays = Math.round((Date.parse(hi) - Date.parse(lo)) / 86_400_000);
    const includeHourly = spanDays <= 14;

    // Shared volume filter. 'Total' rows aggregate classes 1-3; a class filter
    // swaps to that class's rows. $1=lo $2=hi $3=class, optional $4/$5.
    const params: unknown[] = [lo, hi, filters.vehicleClass ?? "Total"];
    let volumeWhere = `type = 'Entries' AND vehicle_class = $3 AND date BETWEEN $1 AND $2`;
    if (filters.direction) {
      params.push(filters.direction);
      volumeWhere += ` AND direction = $${params.length}`;
    }
    if (filters.plazas && filters.plazas.length > 0) {
      params.push(filters.plazas);
      volumeWhere += ` AND toll_plaza = ANY($${params.length})`;
    }
    // Same filter without the date bounds (for full-history baselines)
    const volumeWhereNoDate = volumeWhere.replace(` AND date BETWEEN $1 AND $2`, "");

    // Optional weather filter: keep only hours classified wet/dry by expressway-avg
    // rainfall > 0.3 mm — the same rule as the incident dashboard. Volume queries
    // switch to per-hour rows joined to the weather grid. Calendar analyses
    // (events, holidays) compare whole days against baselines and stay unfiltered.
    const wet = filters.weather && filters.weather !== "all" ? filters.weather === "wet" : null;
    const wparams = wet === null ? params : [...params, wet];
    const W = params.length + 1; // $ index of the wet flag in wparams
    // Spans the previous period too so the KPI comparison stays weather-filtered
    const TWX_CTE = `
      wx AS (
        SELECT (timestamp_utc + interval '8 hours')::date AS d,
               EXTRACT(hour FROM timestamp_utc + interval '8 hours')::int AS h,
               AVG(rainfall) > 0.3 AS wet
        FROM hourly_weather
        WHERE (timestamp_utc + interval '8 hours')::date BETWEEN $1::date - ($2::date - $1::date + 1) AND $2
        GROUP BY 1, 2
      )`;
    const HV_CTE = `
      hv AS (
        SELECT t.date, t.toll_plaza, t.direction, u.hr - 1 AS hour, u.v
        FROM nlex_traffic_volume t,
             LATERAL unnest(${HOUR_ARRAY}) WITH ORDINALITY AS u(v, hr)
        WHERE ${volumeWhere}
      ),
      hvw AS (
        SELECT hv.* FROM hv JOIN wx w ON w.d = hv.date AND w.h = hv.hour WHERE w.wet = $${W}
      )`;
    const NB_SB_HOURLY = `COALESCE(SUM(v) FILTER (WHERE direction = 'NB'), 0)::bigint AS nb,
                          COALESCE(SUM(v) FILTER (WHERE direction = 'SB'), 0)::bigint AS sb`;

    const NB_SB = `COALESCE(SUM(${DAY_TOTAL}) FILTER (WHERE direction = 'NB'), 0)::bigint AS nb,
                   COALESCE(SUM(${DAY_TOTAL}) FILTER (WHERE direction = 'SB'), 0)::bigint AS sb`;

    const [daily, hourly, byPlaza, hourDow, speedByHour, eventImpact, holidayImpact, holidayYearly, kpi, plazaList] =
      await Promise.all([
        // Daily NB/SB volume
        wet === null
          ? db.query(
              `SELECT date::text AS d, ${NB_SB}
               FROM nlex_traffic_volume WHERE ${volumeWhere}
               GROUP BY 1 ORDER BY 1`,
              params
            )
          : db.query(
              `WITH ${TWX_CTE}, ${HV_CTE}
               SELECT date::text AS d, ${NB_SB_HOURLY}
               FROM hvw GROUP BY 1 ORDER BY 1`,
              wparams
            ),
        // Hourly NB/SB volume — only for short ranges (payload size)
        includeHourly
          ? wet === null
            ? db.query(
                `SELECT t.date::text AS d, u.hr - 1 AS hour,
                        COALESCE(SUM(u.v) FILTER (WHERE t.direction = 'NB'), 0)::bigint AS nb,
                        COALESCE(SUM(u.v) FILTER (WHERE t.direction = 'SB'), 0)::bigint AS sb
                 FROM nlex_traffic_volume t,
                      LATERAL unnest(${HOUR_ARRAY}) WITH ORDINALITY AS u(v, hr)
                 WHERE ${volumeWhere}
                 GROUP BY 1, 2 ORDER BY 1, 2`,
                params
              )
            : db.query(
                `WITH ${TWX_CTE}, ${HV_CTE}
                 SELECT date::text AS d, hour, ${NB_SB_HOURLY}
                 FROM hvw GROUP BY 1, 2 ORDER BY 1, 2`,
                wparams
              )
          : Promise.resolve(null),
        // Volume per plaza — full ranked list (client derives top 10 + Others)
        wet === null
          ? db.query(
              `SELECT toll_plaza AS plaza, SUM(${DAY_TOTAL})::bigint AS v
               FROM nlex_traffic_volume WHERE ${volumeWhere}
               GROUP BY 1 ORDER BY 2 DESC`,
              params
            )
          : db.query(
              `WITH ${TWX_CTE}, ${HV_CTE}
               SELECT toll_plaza AS plaza, SUM(v)::bigint AS v
               FROM hvw GROUP BY 1 ORDER BY 2 DESC`,
              wparams
            ),
        // Average volume per hour-of-day x day-of-week (0=Sun)
        wet === null
          ? db.query(
              `WITH hourly AS (
                 SELECT t.date, u.hr - 1 AS hour, SUM(u.v) AS v
                 FROM nlex_traffic_volume t,
                      LATERAL unnest(${HOUR_ARRAY}) WITH ORDINALITY AS u(v, hr)
                 WHERE ${volumeWhere}
                 GROUP BY 1, 2
               )
               SELECT EXTRACT(dow FROM date)::int AS dow, hour::int, ROUND(AVG(v))::int AS v
               FROM hourly GROUP BY 1, 2 ORDER BY 1, 2`,
              params
            )
          : db.query(
              `WITH ${TWX_CTE}, ${HV_CTE},
               hourly AS (SELECT date, hour, SUM(v) AS v FROM hvw GROUP BY 1, 2)
               SELECT EXTRACT(dow FROM date)::int AS dow, hour::int, ROUND(AVG(v))::int AS v
               FROM hourly GROUP BY 1, 2 ORDER BY 1, 2`,
              wparams
            ),
        // Congestion: avg speed & jam level per hour (Waze jams; date filter only —
        // jam records do not join to plazas/classes)
        wet === null
          ? db.query(
              `SELECT hour_of_day AS hour,
                      ROUND(AVG(avg_speed_kmh)::numeric, 1)::float AS speed,
                      ROUND(AVG(avg_jam_level)::numeric, 2)::float AS jam_level
               FROM fact_hourly_jams
               WHERE date_day BETWEEN $1 AND $2
               GROUP BY 1 ORDER BY 1`,
              [lo, hi]
            )
          : db.query(
              `WITH ${TWX_CTE}
               SELECT j.hour_of_day AS hour,
                      ROUND(AVG(j.avg_speed_kmh)::numeric, 1)::float AS speed,
                      ROUND(AVG(j.avg_jam_level)::numeric, 2)::float AS jam_level
               FROM fact_hourly_jams j JOIN wx w ON w.d = j.date_day AND w.h = j.hour_of_day
               WHERE j.date_day BETWEEN $1 AND $2 AND w.wet = $3
               GROUP BY 1 ORDER BY 1`,
              [lo, hi, wet]
            ),
        // Philippine Arena events: CDV plaza day volume vs same-weekday baseline
        db.query(
          `WITH cdv AS (
             SELECT date, SUM(${DAY_TOTAL})::bigint AS v
             FROM nlex_traffic_volume
             WHERE toll_plaza = 'CDV' AND type = 'Entries' AND vehicle_class = 'Total'
             GROUP BY 1
           ), ev AS (
             SELECT DISTINCT ON (start_date) start_date, title, attendance
             FROM philippine_arena_events
             ORDER BY start_date, attendance DESC NULLS LAST
           )
           SELECT e.title AS label, e.start_date::text AS date, e.attendance,
                  c.v::int AS day_volume,
                  ROUND((SELECT AVG(c2.v) FROM cdv c2
                         WHERE EXTRACT(dow FROM c2.date) = EXTRACT(dow FROM e.start_date)
                           AND c2.date BETWEEN e.start_date - 45 AND e.start_date + 45
                           AND c2.date NOT IN (SELECT start_date FROM philippine_arena_events)))::int AS baseline
           FROM ev e JOIN cdv c ON c.date = e.start_date
           ORDER BY e.start_date DESC LIMIT 200`
        ),
        // Holidays vs same-weekday non-holiday baseline (obeys plaza/direction/class filters)
        db.query(
          `WITH daily AS (
             SELECT date, SUM(${DAY_TOTAL})::bigint AS v
             FROM nlex_traffic_volume
             -- full history for stable baselines; $1/$2 referenced to satisfy the bind
             WHERE ${volumeWhereNoDate} AND $1::date IS NOT NULL AND $2::date IS NOT NULL
             GROUP BY 1
           ), hol AS (
             SELECT DISTINCT date_day, holiday_name, holiday_type, is_holiday FROM dim_time
           ), base AS (
             SELECT EXTRACT(dow FROM d.date) AS dow, AVG(d.v) AS bv
             FROM daily d JOIN hol h ON h.date_day = d.date
             WHERE NOT h.is_holiday GROUP BY 1
           )
           SELECT h.holiday_name AS label,
                  ROUND(AVG((d.v - b.bv) / b.bv * 100)::numeric, 1)::float AS deviation_pct,
                  ROUND(AVG(d.v))::int AS avg_volume,
                  ROUND(AVG(b.bv))::int AS avg_baseline,
                  COUNT(*)::int AS occurrences,
                  ROUND(AVG(b.bv))::bigint AS avg_baseline,
                  ROUND(AVG(d.v))::bigint AS avg_volume
           FROM daily d
           JOIN hol h ON h.date_day = d.date AND h.is_holiday AND h.holiday_type <> 'Special Working Day'
           JOIN base b ON b.dow = EXTRACT(dow FROM d.date)
           GROUP BY 1 ORDER BY 2 DESC`,
          params
        ),
        // Per-year holiday deviation (popup drill-down)
        db.query(
          `WITH daily AS (
             SELECT date, SUM(${DAY_TOTAL})::bigint AS v
             FROM nlex_traffic_volume
             WHERE ${volumeWhereNoDate} AND $1::date IS NOT NULL AND $2::date IS NOT NULL
             GROUP BY 1
           ), hol AS (
             SELECT DISTINCT date_day, holiday_name, holiday_type, is_holiday FROM dim_time
           ), base AS (
             SELECT EXTRACT(dow FROM d.date) AS dow, AVG(d.v) AS bv
             FROM daily d JOIN hol h ON h.date_day = d.date
             WHERE NOT h.is_holiday GROUP BY 1
           )
           SELECT h.holiday_name AS label,
                  EXTRACT(year FROM d.date)::int AS year,
                  ROUND(AVG((d.v - b.bv) / b.bv * 100)::numeric, 1)::float AS pct,
                  ROUND(AVG(d.v))::int AS volume
           FROM daily d
           JOIN hol h ON h.date_day = d.date AND h.is_holiday AND h.holiday_type <> 'Special Working Day'
           JOIN base b ON b.dow = EXTRACT(dow FROM d.date)
           GROUP BY 1, 2 ORDER BY 1, 2`,
          params
        ),
        // KPI: current vs previous period volume + congestion index (avg jam level)
        wet === null
          ? db.query(
              `WITH cur AS (
                 SELECT COALESCE(SUM(${DAY_TOTAL}), 0)::bigint AS total, COUNT(DISTINCT date)::int AS days
                 FROM nlex_traffic_volume WHERE ${volumeWhere}
               ), prev AS (
                 SELECT COALESCE(SUM(${DAY_TOTAL}), 0)::bigint AS total, COUNT(DISTINCT date)::int AS days
                 FROM nlex_traffic_volume
                 WHERE ${volumeWhereNoDate}
                   AND date >= $1::date - ($2::date - $1::date + 1) AND date < $1::date
               ), jam_cur AS (
                 SELECT ROUND(AVG(avg_jam_level)::numeric, 2)::float AS jam FROM fact_hourly_jams
                 WHERE date_day BETWEEN $1 AND $2
               ), jam_prev AS (
                 SELECT ROUND(AVG(avg_jam_level)::numeric, 2)::float AS jam FROM fact_hourly_jams
                 WHERE date_day >= $1::date - ($2::date - $1::date + 1) AND date_day < $1::date
               )
               SELECT cur.total AS cur_total, cur.days AS cur_days,
                      prev.total AS prev_total, prev.days AS prev_days,
                      jam_cur.jam AS cur_jam, jam_prev.jam AS prev_jam
               FROM cur, prev, jam_cur, jam_prev`,
              params
            )
          : db.query(
              `WITH ${TWX_CTE}, ${HV_CTE},
               hvprev AS (
                 SELECT t.date, u.hr - 1 AS hour, u.v
                 FROM nlex_traffic_volume t,
                      LATERAL unnest(${HOUR_ARRAY}) WITH ORDINALITY AS u(v, hr)
                 WHERE ${volumeWhereNoDate}
                   AND t.date >= $1::date - ($2::date - $1::date + 1) AND t.date < $1::date
               ),
               hvprevw AS (
                 SELECT hvprev.* FROM hvprev JOIN wx w ON w.d = hvprev.date AND w.h = hvprev.hour WHERE w.wet = $${W}
               ),
               cur AS (SELECT COALESCE(SUM(v), 0)::bigint AS total, COUNT(DISTINCT date)::int AS days FROM hvw),
               prev AS (SELECT COALESCE(SUM(v), 0)::bigint AS total, COUNT(DISTINCT date)::int AS days FROM hvprevw),
               jam_cur AS (
                 SELECT ROUND(AVG(j.avg_jam_level)::numeric, 2)::float AS jam
                 FROM fact_hourly_jams j JOIN wx w ON w.d = j.date_day AND w.h = j.hour_of_day
                 WHERE j.date_day BETWEEN $1 AND $2 AND w.wet = $${W}
               ), jam_prev AS (
                 SELECT ROUND(AVG(j.avg_jam_level)::numeric, 2)::float AS jam
                 FROM fact_hourly_jams j JOIN wx w ON w.d = j.date_day AND w.h = j.hour_of_day
                 WHERE j.date_day >= $1::date - ($2::date - $1::date + 1) AND j.date_day < $1::date AND w.wet = $${W}
               )
               SELECT cur.total AS cur_total, cur.days AS cur_days,
                      prev.total AS prev_total, prev.days AS prev_days,
                      jam_cur.jam AS cur_jam, jam_prev.jam AS prev_jam
               FROM cur, prev, jam_cur, jam_prev`,
              wparams
            ),
        // All plaza names for the filter control
        db.query(`SELECT DISTINCT toll_plaza AS plaza FROM nlex_traffic_volume ORDER BY 1`),
      ]);

    const data = {
      range: { from: lo, to: hi },
      meta: { plazas: plazaList.rows.map((r) => r.plaza), minDate, maxDate },
      kpis: {
        totalVolume: Number(kpi.rows[0].cur_total),
        prevTotalVolume: Number(kpi.rows[0].prev_total),
        days: kpi.rows[0].cur_days,
        prevDays: kpi.rows[0].prev_days,
        congestionIndex: kpi.rows[0].cur_jam,
        prevCongestionIndex: kpi.rows[0].prev_jam,
      },
      dailyTrend: daily.rows.map((r) => ({ d: r.d, nb: Number(r.nb), sb: Number(r.sb) })),
      hourlyTrend: hourly
        ? hourly.rows.map((r) => ({ d: r.d, hour: Number(r.hour), nb: Number(r.nb), sb: Number(r.sb) }))
        : null,
      byPlaza: byPlaza.rows.map((r) => ({ plaza: r.plaza, v: Number(r.v) })),
      hourDow: hourDow.rows,
      speedByHour: speedByHour.rows,
      eventImpact: eventImpact.rows.map((r) => ({
        label: r.label,
        date: r.date,
        dayVolume: r.day_volume,
        baseline: r.baseline,
        deviationPct:
          r.baseline > 0 ? Number((((r.day_volume - r.baseline) / r.baseline) * 100).toFixed(1)) : null,
      })),
      holidayImpact: holidayImpact.rows.map((r) => ({
        label: r.label,
        deviationPct: r.deviation_pct,
        occurrences: r.occurrences,
        baseline: Number(r.avg_baseline),
        volume: Number(r.avg_volume),
      })),
      holidayYearly: holidayYearly.rows.map((r) => ({
        label: r.label,
        year: r.year,
        pct: r.pct,
        volume: Number(r.volume),
      })),
    };

    analyticsCache.set(cacheKey, { at: Date.now(), data });
    return data;
  } catch (error) {
    console.error("Database query failed for traffic analytics:", error);
    return null;
  }
}

// [DEV-01] Get Volumes and ADT from Database
export async function getTrafficVolumesFromDb(direction?: string) {
  if (!db) return null;
  try {
    let query = `SELECT segment_id as "segmentId", volume_count as "volumePerMin", avg_speed_kmh as "avgSpeedKmh" FROM traffic_volumes`;
    const params: string[] = [];

    if (direction) {
      query += ` WHERE segment_id LIKE $1`;
      params.push(`${direction}%`);
    }

    const { rows } = await db.query(query, params);
    return rows;
  } catch (error) {
    console.error("Database query failed for traffic volumes:", error);
    return null;
  }
}

// [DEV-02] Get Directional Flow from Database
export async function getDirectionalFlowFromDb() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`SELECT direction, SUM(vehicle_count) as total FROM directional_flow GROUP BY direction`);
    return rows;
  } catch (error) {
    console.error("Database query failed for directional flow:", error);
    return null;
  }
}

// [DEV-03] Get Vehicle Class Distribution from Database
export async function getVehicleClassDistributionFromDb() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`SELECT class_type, SUM(count) as count FROM vehicle_classes GROUP BY class_type`);
    return rows;
  } catch (error) {
    console.error("Database query failed for vehicle classes:", error);
    return null;
  }
}

// [ML-01] Get Predictive Volume (All Models) from Database
export async function getMLPredictiveVolume() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`SELECT forecast_date as "date", actual_volume, pred_lstm, pred_prophet, pred_xgboost, pred_holtwinters, pred_sarimax, pred_holts_linear, is_holdout, is_future FROM gold.ml_predictive_volume ORDER BY forecast_date ASC`);
    return rows;
  } catch (error) {
    console.error("Failed to fetch ML volume:", error);
    return null;
  }
}

// [ML-02] Get Predictive Congestion (XGBoost) from Database
export async function getMLPredictiveCongestion() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`SELECT segment_name as "segment", hours_ahead as "hours", congestion_state as "state", probability FROM gold.ml_predictive_congestion ORDER BY segment_name ASC, hours_ahead ASC`);
    return rows;
  } catch (error) {
    console.error("Failed to fetch ML congestion:", error);
    return null;
  }
}

// [ML-03] Get Event Surge Forecast (Prophet) from Database
export async function getMLEventSurge() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`SELECT exit_name as "exit", event_name as "event", baseline_volume as "baseline", surge_volume as "surge" FROM gold.ml_event_surge_forecast`);
    return rows;
  } catch (error) {
    console.error("Failed to fetch ML event surge:", error);
    return null;
  }
}
