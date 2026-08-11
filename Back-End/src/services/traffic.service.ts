import { db } from "../config/db.js";

export type AnalyticsRange = "3" | "12" | "all";

export type AnalyticsFilters = {
  months: AnalyticsRange;
  from?: string; // YYYY-MM-DD; with `to`, overrides months
  to?: string;
  plazas?: string[];
  direction?: "NB" | "SB";
  vehicleClass?: "Class 1" | "Class 2" | "Class 3";
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
      `SELECT min(date_day)::text AS lo, max(date_day)::text AS hi FROM bronze.nlex_traffic_volume`
    );
    const minDate: string = bounds.rows[0].lo;
    const maxDate: string = bounds.rows[0].hi;

    if (!minDate || !maxDate) return null;

    let lo: string;
    let hi: string;
    if (filters.from && filters.to) {
      // Custom range (swap if reversed, clamp to available data)
      const [f, t] = filters.from <= filters.to ? [filters.from, filters.to] : [filters.to, filters.from];
      lo = f < minDate ? minDate : f;
      hi = t > maxDate ? maxDate : t;
    } else {
      hi = maxDate;
      lo =
        filters.months === "all"
          ? minDate
          : (
              await db.query(`SELECT ($1::date - ($2 || ' months')::interval)::date::text AS lo`, [
                hi,
                filters.months,
              ])
            ).rows[0].lo;
    }

    // Hourly detail is heavy and noisy beyond ~2 weeks; only ship it for short spans
    const spanDays = Math.round((Date.parse(hi) - Date.parse(lo)) / 86_400_000);
    const includeHourly = spanDays <= 14;

    let volumeCol = "total_volume";
    if (filters.vehicleClass === "Class 1") volumeCol = "volume_class1";
    else if (filters.vehicleClass === "Class 2") volumeCol = "volume_class2";
    else if (filters.vehicleClass === "Class 3") volumeCol = "volume_class3";

    const params: unknown[] = [lo, hi];
    let volumeWhere = `date_day BETWEEN $1 AND $2`;
    if (filters.direction) {
      params.push(filters.direction);
      volumeWhere += ` AND direction = $${params.length}`;
    }
    if (filters.plazas && filters.plazas.length > 0) {
      params.push(filters.plazas);
      volumeWhere += ` AND toll_plaza = ANY($${params.length})`;
    }
    const volumeWhereNoDate = volumeWhere.replace(` AND date_day BETWEEN $1 AND $2`, '');

    const [daily, hourly, byPlaza, hourDow, speedByHour, eventImpact, holidayImpact, holidayYearly, kpi, plazaList] =
      await Promise.all([
        // Daily NB/SB volume
        db.query(
          `SELECT date_day::text AS d,
                  COALESCE(SUM(${volumeCol}) FILTER (WHERE direction = 'NB'), 0)::bigint AS nb,
                  COALESCE(SUM(${volumeCol}) FILTER (WHERE direction = 'SB'), 0)::bigint AS sb
           FROM bronze.nlex_traffic_volume WHERE ${volumeWhere}
           GROUP BY 1 ORDER BY 1`,
          params
        ),
        // Hourly NB/SB volume — only for short ranges (payload size)
        includeHourly
          ? db.query(
              `SELECT date_day::text AS d, hour_of_day AS hour,
                      COALESCE(SUM(${volumeCol}) FILTER (WHERE direction = 'NB'), 0)::bigint AS nb,
                      COALESCE(SUM(${volumeCol}) FILTER (WHERE direction = 'SB'), 0)::bigint AS sb
               FROM bronze.nlex_traffic_volume
               WHERE ${volumeWhere}
               GROUP BY 1, 2 ORDER BY 1, 2`,
              params
            )
          : Promise.resolve(null),
        // Volume per plaza — full ranked list
        db.query(
          `SELECT toll_plaza AS plaza, SUM(${volumeCol})::bigint AS v
           FROM bronze.nlex_traffic_volume WHERE ${volumeWhere}
           GROUP BY 1 ORDER BY 2 DESC`,
          params
        ),
        // Average volume per hour-of-day x day-of-week (0=Sun)
        db.query(
          `SELECT EXTRACT(dow FROM date_day)::int AS dow, hour_of_day AS hour, ROUND(AVG(${volumeCol}))::int AS v
           FROM bronze.nlex_traffic_volume
           WHERE ${volumeWhere}
           GROUP BY 1, 2 ORDER BY 1, 2`,
          params
        ),
        // Congestion: avg speed & jam level per hour
        db.query(
          `SELECT hour_of_day AS hour,
                  ROUND(AVG(avg_speed_kmh)::numeric, 1)::float AS speed,
                  ROUND(AVG(avg_jam_level)::numeric, 2)::float AS jam_level
           FROM bronze.nlex_traffic_volume
           WHERE ${volumeWhere}
           GROUP BY 1 ORDER BY 1`,
          params
        ),
        // Philippine Arena events: volume vs same-weekday baseline
        db.query(
          `WITH ev AS (
             SELECT DISTINCT ON (start_date) start_date, title, attendance
             FROM public.philippine_arena_events
             ORDER BY start_date, attendance DESC NULLS LAST
           ), daily_vol AS (
             SELECT date_day, SUM(${volumeCol})::bigint AS v
             FROM bronze.nlex_traffic_volume
             GROUP BY 1
           )
           SELECT e.title AS label, e.start_date::text AS date, e.attendance,
                  c.v::int AS day_volume,
                  ROUND((SELECT AVG(c2.v) FROM daily_vol c2
                         WHERE EXTRACT(dow FROM c2.date_day) = EXTRACT(dow FROM e.start_date)
                           AND c2.date_day BETWEEN e.start_date - 45 AND e.start_date + 45
                           AND c2.date_day NOT IN (SELECT start_date FROM public.philippine_arena_events)))::int AS baseline
           FROM ev e JOIN daily_vol c ON c.date_day = e.start_date
           ORDER BY e.start_date DESC LIMIT 200`
        ),
        // Holidays vs same-weekday non-holiday baseline
        db.query(
          `WITH daily AS (
             SELECT date_day, SUM(${volumeCol})::bigint AS v, bool_or(is_holiday) as is_hol
             FROM bronze.nlex_traffic_volume
             WHERE ${volumeWhereNoDate} AND $1::date IS NOT NULL AND $2::date IS NOT NULL
             GROUP BY 1
           ), base AS (
             SELECT EXTRACT(dow FROM date_day) AS dow, AVG(v) AS bv
             FROM daily
             WHERE NOT is_hol GROUP BY 1
           )
           SELECT 'Holidays' AS label,
                  ROUND(((AVG(d.v) - AVG(b.bv)) / NULLIF(AVG(b.bv), 0) * 100)::numeric, 1)::float AS deviation_pct,
                  ROUND(AVG(d.v))::int AS avg_volume,
                  ROUND(AVG(b.bv))::int AS avg_baseline,
                  COUNT(*)::int AS occurrences,
                  ROUND(AVG(b.bv))::bigint AS avg_baseline_big,
                  ROUND(AVG(d.v))::bigint AS avg_volume_big
           FROM daily d
           JOIN base b ON b.dow = EXTRACT(dow FROM d.date_day)
           WHERE d.is_hol
           GROUP BY 1 ORDER BY 2 DESC`,
          params
        ),
        // Per-year holiday deviation (popup drill-down)
        db.query(
          `WITH daily AS (
             SELECT date_day, SUM(${volumeCol})::bigint AS v, bool_or(is_holiday) as is_hol
             FROM bronze.nlex_traffic_volume
             WHERE ${volumeWhereNoDate} AND $1::date IS NOT NULL AND $2::date IS NOT NULL
             GROUP BY 1
           ), base AS (
             SELECT EXTRACT(dow FROM date_day) AS dow, AVG(v) AS bv
             FROM daily
             WHERE NOT is_hol GROUP BY 1
           )
           SELECT 'Holidays' AS label,
                  EXTRACT(year FROM d.date_day)::int AS year,
                  ROUND(AVG((d.v - b.bv) / NULLIF(b.bv, 0) * 100)::numeric, 1)::float AS pct,
                  ROUND(AVG(d.v))::int AS volume
           FROM daily d
           JOIN base b ON b.dow = EXTRACT(dow FROM d.date_day)
           WHERE d.is_hol
           GROUP BY 1, 2 ORDER BY 1, 2`,
          params
        ),
        // KPI: current vs previous period volume + congestion index
        db.query(
          `WITH cur AS (
             SELECT COALESCE(SUM(${volumeCol}), 0)::bigint AS total, COUNT(DISTINCT date_day)::int AS days
             FROM bronze.nlex_traffic_volume WHERE ${volumeWhere}
           ), prev AS (
             SELECT COALESCE(SUM(${volumeCol}), 0)::bigint AS total, COUNT(DISTINCT date_day)::int AS days
             FROM bronze.nlex_traffic_volume
             WHERE ${volumeWhereNoDate}
               AND date_day >= $1::date - ($2::date - $1::date + 1) AND date_day < $1::date
           ), jam_cur AS (
             SELECT ROUND(AVG(avg_jam_level)::numeric, 2)::float AS jam FROM bronze.nlex_traffic_volume
             WHERE date_day BETWEEN $1 AND $2
           ), jam_prev AS (
             SELECT ROUND(AVG(avg_jam_level)::numeric, 2)::float AS jam FROM bronze.nlex_traffic_volume
             WHERE date_day >= $1::date - ($2::date - $1::date + 1) AND date_day < $1::date
           )
           SELECT cur.total AS cur_total, cur.days AS cur_days,
                  prev.total AS prev_total, prev.days AS prev_days,
                  jam_cur.jam AS cur_jam, jam_prev.jam AS prev_jam
           FROM cur, prev, jam_cur, jam_prev`,
          params
        ),
        // All plaza names for the filter control
        db.query(`SELECT DISTINCT toll_plaza AS plaza FROM bronze.nlex_traffic_volume ORDER BY 1`),
      ]);

    const data = {
      range: { from: lo, to: hi },
      meta: { plazas: plazaList.rows.map((r: any) => r.plaza), minDate, maxDate },
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
      byPlaza: byPlaza.rows.map((r: any) => ({ plaza: r.plaza, v: Number(r.v) })),
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
  // Table does not exist in new schema, returning null gracefully
  return null;
}

// [DEV-02] Get Directional Flow from Database
export async function getDirectionalFlowFromDb() {
  // Table does not exist in new schema, returning null gracefully
  return null;
}

// [DEV-03] Get Vehicle Class Distribution from Database
export async function getVehicleClassDistributionFromDb() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT 'Class 1' as class_type, SUM(volume_class1)::bigint as count FROM bronze.nlex_traffic_volume
      UNION ALL
      SELECT 'Class 2' as class_type, SUM(volume_class2)::bigint as count FROM bronze.nlex_traffic_volume
      UNION ALL
      SELECT 'Class 3' as class_type, SUM(volume_class3)::bigint as count FROM bronze.nlex_traffic_volume
    `);
    return rows;
  } catch (error) {
    console.error("Database query failed for vehicle classes:", error);
    return null;
  }
}


// [ML-METRICS] Fetch model evaluation metrics from gold.ml_model_metrics
export async function getMLModelMetrics(target?: string) {
  if (!db) return null;
  try {
    const query = target
      ? `SELECT model_name, target, rmse, mae, wmape, r2, mase, mape, smape, rmsse, me, mpe, adjusted_r2, theils_u, mse, train_r2, val_r2, gap, diagnosis, rank, accepted, rejected_reason, updated_at
         FROM gold.ml_model_metrics WHERE target = $1 ORDER BY rank ASC`
      : `SELECT model_name, target, rmse, mae, wmape, r2, mase, mape, smape, rmsse, me, mpe, adjusted_r2, theils_u, mse, train_r2, val_r2, gap, diagnosis, rank, accepted, rejected_reason, updated_at
         FROM gold.ml_model_metrics ORDER BY target, rank ASC`;
    const { rows } = target ? await db.query(query, [target]) : await db.query(query);
    return rows;
  } catch (error) {
    console.error("Failed to fetch ML model metrics:", error);
    return null;
  }
}
type ForecastWindow = {
  months?: "3" | "12" | "all" | string;
  from?: string;
  to?: string;
  weather?: "all" | "dry" | "wet" | string;
};

export async function getMLPredictiveVolume(window: ForecastWindow = {}) {
  if (!db) return null;
  const cols = `forecast_date as "date", actual_volume, pred_lstm, pred_prophet, pred_xgboost, pred_holtwinters, pred_sarimax, pred_holts_linear, is_holdout, is_future, weather_rainfall, weather_temp`;
  try {
    // An explicit from/to wins; otherwise months trims back from the newest
    // forecast date the table holds.
    if (window.from && window.to) {
      const { rows } = await db.query(
        `SELECT ${cols} FROM gold.ml_predictive_volume
         WHERE forecast_date BETWEEN $1::date AND $2::date
         ORDER BY forecast_date ASC`,
        [window.from, window.to]
      );
      return rows;
    }

    if (window.months && window.months !== "all") {
      const { rows } = await db.query(
        `SELECT ${cols} FROM gold.ml_predictive_volume
         WHERE forecast_date >= (SELECT MAX(forecast_date) FROM gold.ml_predictive_volume) - ($1::int * interval '1 month')
         ORDER BY forecast_date ASC`,
        [Number(window.months)]
      );
      return rows;
    }

    const { rows } = await db.query(`SELECT ${cols} FROM gold.ml_predictive_volume ORDER BY forecast_date ASC`);
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
//
// The forecast table only carries the handful of exits the model flagged. The
// corridor has many more, and "which exits are NOT affected" is just as
// operationally useful, so every plaza with real traffic is returned and the
// forecast is left-joined onto it.
//
// Baselines come from observed volume for every exit — the forecast table's own
// baseline_volume does not reconcile with the warehouse (see README note), so
// the model's *uplift ratio* is applied to the observed baseline instead. That
// keeps one honest scale across the whole chart.
export async function getMLEventSurge() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      WITH daily_vols AS (
        SELECT toll_plaza, date_day, SUM(total_volume) as day_total
        FROM bronze.nlex_traffic_volume
        WHERE date_day >= (SELECT MAX(date_day) FROM bronze.nlex_traffic_volume WHERE total_volume > 0) - interval '90 days'
        GROUP BY toll_plaza, date_day
      ),
      observed AS (
        SELECT toll_plaza,
               ROUND(AVG(day_total))::int AS baseline
        FROM daily_vols
        GROUP BY 1
        HAVING ROUND(AVG(day_total)) > 0
      ),
      -- Forecast exit names are free text ("Bocaue Exit"); a prefix match would
      -- also catch "Bocaue Barrier", which is a mainline barrier and not the
      -- exit the model means. Map explicitly.
      alias(forecast_name, plaza) AS (
        VALUES ('Bocaue Exit', 'Bocaue'),
               ('Marilao Exit', 'Marilao'),
               ('Balagtas Exit', 'Balagtas')
      ),
      fc AS (
        SELECT COALESCE(a.plaza, TRIM(REPLACE(f.exit_name, 'Exit', ''))) AS plaza,
               f.event_name,
               f.baseline_volume,
               f.surge_volume,
               CASE WHEN f.baseline_volume > 0
                    THEN f.surge_volume::numeric / f.baseline_volume
                    ELSE NULL END AS uplift
        FROM gold.ml_event_surge_forecast f
        LEFT JOIN alias a ON a.forecast_name = f.exit_name
      )
      SELECT o.toll_plaza AS "exit",
             fc.event_name AS "event",
             o.baseline AS "baseline",
             CASE WHEN fc.uplift IS NOT NULL
                  THEN ROUND(o.baseline * fc.uplift)::int
                  ELSE NULL END AS "surge",
             ROUND(fc.uplift::numeric, 4) AS "uplift",
             fc.baseline_volume AS "modelBaseline",
             fc.surge_volume AS "modelSurge"
      FROM observed o
      LEFT JOIN fc ON fc.plaza = o.toll_plaza
      ORDER BY o.baseline DESC
    `);
    return rows;
  } catch (error) {
    console.error("Failed to fetch ML event surge:", error);
    return null;
  }
}

// [ML-04] Hourly breakdown for one forecast day — powers the click-to-drill-down
// on the predictive volume chart.
//
// Actuals come straight from nlex_traffic_volume when that date has been
// observed. Future days have no hourly ground truth and the models only predict
// a daily total, so the predicted curve is that total redistributed over the
// station's typical shape for the same weekday (last 90 days of history).
export type HourlyForecastPoint = { hour: number; actual: number | null; predicted: number | null };
export type HourlyForecastResult = {
  date: string;
  weekday: string;
  isFuture: boolean;
  dayActual: number | null;
  dayPredicted: number | null;
  profileSource: "observed" | "weekday-profile" | null;
  weather: "all" | "dry" | "wet";
  observedHours: number;
  hours: HourlyForecastPoint[];
};

const MODEL_COLUMN: Record<string, string> = {
  LSTM: "pred_lstm",
  Prophet: "pred_prophet",
  XGBoost: "pred_xgboost",
  HoltWinters: "pred_holtwinters",
  SARIMAX: "pred_sarimax",
  HoltsLinear: "pred_holts_linear"
};

export type HourlyForecastPoint = { hour: number; actual: number | null; predicted: number | null; rainfall?: number | null; temperature?: number | null };
export type HourlyForecastResult = {
  date: string;
  weekday: string;
  isFuture: boolean;
  dayActual: number | null;
  dayPredicted: number | null;
  profileSource: "observed" | "weekday-profile" | null;
  weather: "all" | "dry" | "wet";
  observedHours: number;
  hours: HourlyForecastPoint[];
};

export async function getMLPredictiveVolumeHourly(
  date: string,
  model = "LSTM",
  weather: "all" | "dry" | "wet" = "all"
): Promise<HourlyForecastResult | null> {
  if (!db) return null;
  const column = MODEL_COLUMN[model] ?? MODEL_COLUMN.LSTM;

  // Weather narrows the observed hours to those recorded as wet (or dry). The
  // ML models carry no weather dimension, so it never touches the day totals.
  const wetFilter = weather === "all" ? null : weather === "wet";
  const WX_CTE = `wx AS (
    SELECT (timestamp_utc + interval '8 hours')::date AS d,
           EXTRACT(hour FROM timestamp_utc + interval '8 hours')::int AS h,
           AVG(rainfall) > 0.3 AS wet
    FROM hourly_weather
    WHERE (timestamp_utc + interval '8 hours')::date = $1::date
    GROUP BY 1, 2
  )`;

  try {
    const [dayRes, actualRes, profileRes, weatherRes] = await Promise.all([
      // The day's totals as the models see them
      db.query(
        `SELECT forecast_date::text AS date, actual_volume, ${column} AS predicted, is_future
         FROM gold.ml_predictive_volume WHERE forecast_date = $1::date`,
        [date]
      ),
      // Observed hourly totals, if this date has been recorded
      wetFilter === null
        ? db.query(
            `SELECT hour_of_day AS hour, COALESCE(SUM(total_volume), 0)::bigint AS v
             FROM bronze.nlex_traffic_volume
             WHERE date_day = $1::date
             GROUP BY 1 ORDER BY 1`,
            [date]
          )
        : db.query(
            `WITH ${WX_CTE}
             SELECT t.hour_of_day AS hour, COALESCE(SUM(t.total_volume), 0)::bigint AS v
             FROM bronze.nlex_traffic_volume t
             JOIN wx w ON w.d = t.date_day AND w.h = t.hour_of_day
             WHERE t.date_day = $1::date AND w.wet = $2
             GROUP BY 1 ORDER BY 1`,
            [date, wetFilter]
          ),
      // Typical share of the day carried by each hour, same weekday, recent history
      db.query(
        `SELECT hour_of_day AS hour, AVG(total_volume)::float AS v 
         FROM bronze.nlex_traffic_volume
         WHERE EXTRACT(dow FROM date_day) = EXTRACT(dow FROM $1::date)
           AND date_day < $1::date
           AND date_day >= $1::date - interval '90 days'
         GROUP BY 1 ORDER BY 1`,
        [date]
      ),
      // Hourly weather metrics (rainfall and temp) for this date
      db.query(
        `SELECT EXTRACT(hour FROM timestamp_utc + interval '8 hours')::int AS hour,
                AVG(rainfall)::float AS rainfall,
                AVG(temperature)::float AS temperature
         FROM hourly_weather
         WHERE (timestamp_utc + interval '8 hours')::date = $1::date
         GROUP BY 1 ORDER BY 1`,
        [date]
      ),
    ]);

    const day = dayRes.rows[0] as
      | { date: string; actual_volume: number | null; predicted: number | null; is_future: boolean }
      | undefined;
    if (!day) return null;

    const actualByHour = new Map<number, number>(
      actualRes.rows.map((r: { hour: number; v: string }) => [Number(r.hour), Number(r.v)])
    );
    const weatherByHour = new Map<number, { rainfall: number; temperature: number }>(
      weatherRes.rows.map((r: { hour: number; rainfall: number; temperature: number }) => [
        Number(r.hour),
        { rainfall: Number(r.rainfall || 0), temperature: Number(r.temperature || 0) }
      ])
    );
    const profile = profileRes.rows.map((r: { hour: number; v: number }) => Number(r.v));
    const profileTotal = profile.reduce((s, v) => s + v, 0);

    const dayPredicted = day.predicted != null ? Number(day.predicted) : null;
    const hasActualHours = actualByHour.size > 0;
    const canShapePrediction = dayPredicted != null && profileTotal > 0 && profile.length === 24;

    const hours: HourlyForecastPoint[] = Array.from({ length: 24 }, (_, h) => {
      const wx = weatherByHour.get(h);
      return {
        hour: h,
        actual: !hasActualHours ? null : wetFilter === null ? actualByHour.get(h) ?? 0 : actualByHour.get(h) ?? null,
        predicted: canShapePrediction ? Math.round((profile[h] / profileTotal) * dayPredicted) : null,
        rainfall: wx ? wx.rainfall : null,
        temperature: wx ? wx.temperature : null,
      };
    });

    return {
      date: day.date,
      weekday: new Date(`${day.date}T00:00:00`).toLocaleDateString("en-US", { weekday: "long" }),
      isFuture: Boolean(day.is_future),
      dayActual: day.actual_volume != null ? Number(day.actual_volume) : null,
      dayPredicted,
      profileSource: hasActualHours ? "observed" : canShapePrediction ? "weekday-profile" : null,
      weather,
      observedHours: actualByHour.size,
      hours,
    };
  } catch (error) {
    console.error("Failed to fetch hourly ML volume:", error);
    return null;
  }
}
