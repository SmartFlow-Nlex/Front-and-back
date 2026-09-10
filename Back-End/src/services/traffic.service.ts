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

    const [daily, hourly, byPlaza, hourDow, speedByHour, eventImpact, holidayImpact, holidayYearly, kpi, plazaList, plazaHour] =
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
        // Arena/venue events: event-day volume at the serving plaza vs a clean
        // same-weekday baseline drawn from the +/-45 days around it.
        //
        // Baseline hygiene — a day only counts toward the baseline if it is
        // neither another event day nor a holiday. Leaving holidays in was
        // skewing the baseline for any event near Christmas or Holy Week.
        //
        // Multi-event days are folded into ONE row rather than picked between.
        // The traffic on 20 Jan 2024 was produced by Coldplay AND SEVENTEEN AND
        // NCT 127 together; attributing it to one of them is wrong. (The old
        // DISTINCT ON also ranked by `attendance`, which is TEXT — so it sorted
        // "9,000" above "54,589" and often kept the smaller event.)
        //
        // Which plaza — measured at the venue's OWN interchange. The events
        // table points at CDV/PH Arena (the Philippine Arena's exit) and bronze
        // now carries a volume series for it, so no proxy is needed. This
        // previously fell back to Bocaue, 2.4 km away, because the public
        // matview had no CDV series.
        //
        // Reads the nlex_traffic_volume serving matview like every other
        // descriptive query. It briefly read bronze directly, while the matview
        // was stale and its source held duplicate rows; both are fixed, so the
        // layering is intact again.
        //
        // Also note the volume series only contains type = 'Entries', so this
        // counts vehicles ENTERING NLEX at the plaza — largely the post-event
        // exodus onto the expressway rather than arrivals.
        //
        // Events falling on a holiday are flagged, since their deviation is
        // really a holiday effect.
        db.query(
          `WITH pv AS (
             SELECT t.toll_plaza, t.date, SUM(${DAY_TOTAL})::bigint AS v
             FROM nlex_traffic_volume t
             WHERE t.type = 'Entries' AND t.vehicle_class = 'Total'
             GROUP BY 1, 2
           ), clean AS (
             SELECT p.* FROM pv p
             WHERE NOT EXISTS (SELECT 1 FROM philippine_arena_events x WHERE x.start_date = p.date)
               AND NOT EXISTS (SELECT 1 FROM ph_holidays h WHERE h.date_day = p.date)
           ), ev_rows AS (
             -- Case-only duplicates exist in the source ("SEVENTEEN - BE THE
             -- SUN World Tour" vs "Seventeen - Be The Sun World Tour" on
             -- 2022-12-17), so titles are de-duplicated case-insensitively and
             -- one spelling is kept as the representative.
             SELECT e.start_date, x.exit_name AS plaza,
                    MIN(x.exit_name) AS venue_exit,
                    MIN(e.title) AS title,
                    MAX(NULLIF(replace((regexp_match(e.attendance, '[0-9][0-9,]*'))[1], ',', ''), '')::bigint) AS attendance
             FROM philippine_arena_events e
             JOIN nlex_exits x ON x.exit_id = e.nlex_exit_id
             GROUP BY e.start_date, x.exit_name, lower(btrim(e.title))
           ), ev AS (
             SELECT e.start_date,
                    e.plaza,
                    MIN(e.venue_exit) AS venue_exit,
                    string_agg(e.title, ' + ' ORDER BY e.title) AS title,
                    COUNT(*)::int AS event_count,
                    -- attendance is free text ("54,589", "10,886 / 10,886",
                    -- "100,000 - 150,000 (Festival Total)"); the first number is
                    -- taken, which is the lower bound for a range.
                    MAX(e.attendance) AS attendance,
                    bool_or(EXISTS (SELECT 1 FROM ph_holidays h WHERE h.date_day = e.start_date)) AS on_holiday
             FROM ev_rows e
             GROUP BY 1, 2
           )
           SELECT e.title AS label, e.start_date::text AS date, e.plaza, e.venue_exit,
                  e.event_count, e.attendance, e.on_holiday,
                  p.v::bigint AS day_volume,
                  ROUND(b.bv)::bigint AS baseline,
                  b.bn::int AS baseline_n,
                  ROUND(((p.v - b.bv) / b.bv * 100)::numeric, 1)::float AS deviation_pct
           FROM ev e
           JOIN pv p ON p.date = e.start_date AND p.toll_plaza = e.plaza
           CROSS JOIN LATERAL (
             SELECT AVG(cb.v) AS bv, COUNT(*) AS bn
             FROM clean cb
             WHERE cb.toll_plaza = e.plaza
               AND EXTRACT(dow FROM cb.date) = EXTRACT(dow FROM e.start_date)
               AND cb.date BETWEEN e.start_date - 45 AND e.start_date + 45
           ) b
           -- Drop occurrences whose baseline rests on too few days to mean
           -- anything; the previous query allowed a sample of zero.
           WHERE b.bn >= 4 AND b.bv > 0
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
           ), clean AS (
             -- Days eligible as baseline: neither a holiday nor an event day.
             SELECT d.* FROM daily d
             WHERE NOT EXISTS (SELECT 1 FROM ph_holidays p WHERE p.date_day = d.date)
               AND NOT EXISTS (SELECT 1 FROM philippine_arena_events e WHERE e.start_date = d.date)
           ), occ AS (
             -- One row per holiday occurrence, each compared against a LOCAL
             -- baseline: same weekday, within +/-45 days of that occurrence.
             --
             -- This replaces a single baseline averaged over all history, which
             -- silently mixed the 2020-2021 pandemic period into every
             -- comparison. Under that global baseline the average holiday
             -- deviation swung from -27% (2020) to +42% (2025) — an artefact of
             -- lockdown traffic levels, not of the holidays. With a local
             -- baseline each year lands in a consistent +10% to +19% band,
             -- because a 2020 holiday is now measured against 2020 normal days.
             SELECT h.holiday_name, h.holiday_type, d.date, d.v, b.bv, b.bn
             FROM daily d
             JOIN ph_holidays h ON h.date_day = d.date
             CROSS JOIN LATERAL (
               SELECT AVG(cb.v) AS bv, COUNT(*) AS bn
               FROM clean cb
               WHERE EXTRACT(dow FROM cb.date) = EXTRACT(dow FROM d.date)
                 AND cb.date BETWEEN d.date - 45 AND d.date + 45
             ) b
             WHERE b.bn >= 4 AND b.bv > 0
           )
           SELECT holiday_name AS label,
                  MAX(holiday_type) AS holiday_type,
                  ROUND(AVG((v - bv) / bv * 100)::numeric, 1)::float AS deviation_pct,
                  COUNT(*)::int AS occurrences,
                  MIN(bn)::int AS min_baseline_n,
                  ROUND(AVG(bv))::bigint AS avg_baseline,
                  ROUND(AVG(v))::bigint AS avg_volume
           FROM occ GROUP BY 1 ORDER BY 3 DESC`,
          params
        ),
        // Per-year holiday deviation (popup drill-down)
        db.query(
          `WITH daily AS (
             SELECT date, SUM(${DAY_TOTAL})::bigint AS v
             FROM nlex_traffic_volume
             WHERE ${volumeWhereNoDate} AND $1::date IS NOT NULL AND $2::date IS NOT NULL
             GROUP BY 1
           ), clean AS (
             SELECT d.* FROM daily d
             WHERE NOT EXISTS (SELECT 1 FROM ph_holidays p WHERE p.date_day = d.date)
               AND NOT EXISTS (SELECT 1 FROM philippine_arena_events e WHERE e.start_date = d.date)
           )
           -- Same local-baseline rule as the summary above, kept identical so
           -- the drill-down always reconciles with the headline figure.
           SELECT h.holiday_name AS label,
                  EXTRACT(year FROM d.date)::int AS year,
                  ROUND(AVG((d.v - b.bv) / b.bv * 100)::numeric, 1)::float AS pct,
                  ROUND(AVG(d.v))::int AS volume
           FROM daily d
           JOIN ph_holidays h ON h.date_day = d.date
           CROSS JOIN LATERAL (
             SELECT AVG(cb.v) AS bv, COUNT(*) AS bn
             FROM clean cb
             WHERE EXTRACT(dow FROM cb.date) = EXTRACT(dow FROM d.date)
               AND cb.date BETWEEN d.date - 45 AND d.date + 45
           ) b
           WHERE b.bn >= 4 AND b.bv > 0
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
        // Average volume per plaza x hour-of-day, for the Prescriptive tab's
        // per-plaza booth plan. hourDow above is corridor-wide; a plaza's own
        // peak hour and peak share differ from the corridor's, and staffing
        // is decided per plaza.
        wet === null
          ? db.query(
              `WITH hourly AS (
                 SELECT t.date, t.toll_plaza AS plaza, u.hr - 1 AS hour, SUM(u.v) AS v
                 FROM nlex_traffic_volume t,
                      LATERAL unnest(${HOUR_ARRAY}) WITH ORDINALITY AS u(v, hr)
                 WHERE ${volumeWhere}
                 GROUP BY 1, 2, 3
               )
               SELECT plaza, hour::int, ROUND(AVG(v))::int AS v
               FROM hourly GROUP BY 1, 2 ORDER BY 1, 2`,
              params
            )
          : db.query(
              `WITH ${TWX_CTE}, ${HV_CTE},
               hourly AS (SELECT date, toll_plaza AS plaza, hour, SUM(v) AS v FROM hvw GROUP BY 1, 2, 3)
               SELECT plaza, hour::int, ROUND(AVG(v))::int AS v
               FROM hourly GROUP BY 1, 2 ORDER BY 1, 2`,
              wparams
            ),
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
      plazaHourProfile: plazaHour.rows.map((r) => ({ plaza: r.plaza, hour: Number(r.hour), v: Number(r.v) })),
      speedByHour: speedByHour.rows,
      eventImpact: eventImpact.rows.map((r) => ({
        label: r.label,
        date: r.date,
        dayVolume: Number(r.day_volume),
        baseline: Number(r.baseline),
        // Computed in SQL against the cleaned baseline rather than recomputed
        // here, so the figure and its sample size always come from the same set.
        deviationPct: r.deviation_pct,
        /** Toll plaza the volume is measured at. */
        plaza: r.plaza,
        /** The venue's own interchange, which may differ from the metering plaza. */
        venueExit: r.venue_exit,
        /** How many distinct events shared this date. */
        eventCount: r.event_count,
        /** Reported attendance, parsed from free text; null when not published. */
        attendance: r.attendance === null ? null : Number(r.attendance),
        /** True when the date is also a holiday — the deviation is then mostly a holiday effect. */
        onHoliday: r.on_holiday,
        /** Number of comparable days behind the baseline. */
        baselineDays: r.baseline_n,
      })),
      holidayImpact: holidayImpact.rows.map((r) => ({
        label: r.label,
        // "Regular" or "Special" — the two classes of Philippine non-working
        // holiday, which behave differently in the volume data.
        holidayType: r.holiday_type,
        deviationPct: r.deviation_pct,
        occurrences: r.occurrences,
        baseline: Number(r.avg_baseline),
        volume: Number(r.avg_volume),
        /** Smallest baseline sample behind any occurrence of this holiday. */
        minBaselineDays: r.min_baseline_n,
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

// The warehouse keeps toll-plaza volume in the nlex_traffic_volume matview
// (one row per date/plaza/direction/class, with hourly columns h00..h23). The
// flat traffic_volumes / directional_flow / vehicle_classes tables from the
// original schema exist but were never loaded in this database, so the three
// functions below read the matview and shape the result to the API the
// controllers already expect.

/** Most recent 365 days of data, used as the ADT averaging window. */
const ADT_SPAN = `span AS (SELECT MAX(date) AS hi, (MAX(date) - 364) AS lo FROM nlex_traffic_volume)`;

// [DEV-01] Get Volumes and ADT from Database
export async function getTrafficVolumesFromDb(direction?: string) {
  if (!db) return null;
  try {
    // Average volume per minute over the last 30 days, per plaza+direction.
    const params: string[] = [];
    let directionFilter = "";
    if (direction) {
      params.push(direction);
      directionFilter = ` AND t.direction = $${params.length}`;
    }

    const { rows } = await db.query(
      `WITH span AS (SELECT MAX(date) AS hi, (MAX(date) - 29) AS lo FROM nlex_traffic_volume)
       SELECT t.toll_plaza AS "segmentId",
              t.direction AS "direction",
              ROUND(AVG(${DAY_TOTAL}) / 1440.0)::int AS "volumePerMin"
       FROM nlex_traffic_volume t, span
       WHERE t.type = 'Entries' AND t.vehicle_class = 'Total'
         AND t.date BETWEEN span.lo AND span.hi${directionFilter}
       GROUP BY 1, 2 ORDER BY 1, 2`,
      params
    );
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
    const { rows } = await db.query(
      `WITH ${ADT_SPAN}
       SELECT direction,
              ROUND(SUM(${DAY_TOTAL})::numeric / NULLIF(COUNT(DISTINCT date), 0))::bigint AS total
       FROM nlex_traffic_volume, span
       WHERE type = 'Entries' AND vehicle_class = 'Total'
         AND date BETWEEN span.lo AND span.hi
       GROUP BY direction ORDER BY direction`
    );
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
    // class_type must come back as a number — the controller matches it with ===
    const { rows } = await db.query(
      `WITH ${ADT_SPAN}
       SELECT RIGHT(vehicle_class, 1)::int AS class_type,
              ROUND(SUM(${DAY_TOTAL})::numeric / NULLIF(COUNT(DISTINCT date), 0))::bigint AS count
       FROM nlex_traffic_volume, span
       WHERE type = 'Entries' AND vehicle_class IN ('Class 1', 'Class 2', 'Class 3')
         AND date BETWEEN span.lo AND span.hi
       GROUP BY 1 ORDER BY 1`
    );
    return rows;
  } catch (error) {
    console.error("Database query failed for vehicle classes:", error);
    return null;
  }
}

// [ML-01] Get Predictive Volume (All Models) from Database
/**
 * True size of each split, counted over the WHOLE table.
 *
 * The chart trims history to the selected range (3 mo / 12 mo), so the blue
 * "Past" band can be drawing 89 of 1,922 training days while still being
 * labelled "Past" — which makes the 80/20 split look wrong on screen when it is
 * actually correct. These counts come from the unwindowed table so the legend
 * can state what was trained on versus what is currently visible.
 *
 * Percentages are over train+holdout only. Future days are projections with no
 * actuals, so including them would understate the holdout share.
 */
export async function getSplitSummary(split: SplitLabel = DEFAULT_SPLIT) {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(DISTINCT forecast_date) FILTER (WHERE NOT is_holdout AND NOT is_future)::int AS train_days,
        COUNT(DISTINCT forecast_date) FILTER (WHERE is_holdout)::int AS holdout_days,
        COUNT(DISTINCT forecast_date) FILTER (WHERE is_future)::int AS future_days,
        MIN(forecast_date) FILTER (WHERE NOT is_holdout AND NOT is_future)::text AS train_start,
        MAX(forecast_date) FILTER (WHERE NOT is_holdout AND NOT is_future)::text AS train_end,
        MIN(forecast_date) FILTER (WHERE is_holdout)::text AS holdout_start
      FROM gold.ml_predictive_volume
      WHERE split_label = $1
    `, [split]);
    const r = rows[0];
    if (!r) return null;
    const scored = Number(r.train_days) + Number(r.holdout_days);
    const pct = (n: number) => (scored ? Number(((n / scored) * 100).toFixed(2)) : null);
    return {
      trainDays: Number(r.train_days),
      holdoutDays: Number(r.holdout_days),
      futureDays: Number(r.future_days),
      trainStart: r.train_start,
      trainEnd: r.train_end,
      holdoutStart: r.holdout_start,
      trainPct: pct(Number(r.train_days)),
      holdoutPct: pct(Number(r.holdout_days)),
    };
  } catch (error) {
    console.error("Failed to fetch split summary:", error);
    return null;
  }
}

/**
 * Chronological split arm. The manuscript (p86) commits to evaluating BOTH an
 * 80/20 and a 90/10 split and choosing empirically, so both are stored and the
 * dashboard can toggle between them. 80/20 is the default: its 294-day scored
 * window spans Mar-Dec, while 90/10's 140 days cover only Aug-Dec — one season,
 * which fails the manuscript's own "sufficiently diverse time frame" condition.
 *
 * gold.ml_predictive_volume and gold.ml_model_metrics hold BOTH arms, so every
 * query against them must filter on split_label or the two mix.
 */
export type SplitLabel = "80_20" | "90_10";
export const DEFAULT_SPLIT: SplitLabel = "80_20";

export type ForecastWindow = { months?: "3" | "12" | "all"; from?: string; to?: string; split?: SplitLabel };

export async function getMLPredictiveVolume(window: ForecastWindow = {}) {
  const split: SplitLabel = window.split ?? DEFAULT_SPLIT;
  if (!db) return null;
  // weather_* drive the rainfall bars; the _nw columns are the weather-free twins
  // the Weather toggle switches to. Without them the toggle changes nothing.
  const cols = `forecast_date as "date", actual_volume, pred_lstm, pred_prophet, pred_xgboost, pred_holtwinters, pred_sarimax, pred_holts_linear, is_holdout, is_future, weather_rainfall, weather_temp, pred_prophet_nw, pred_sarimax_nw, pred_lstm_nw`;
  try {
    // An explicit from/to wins; otherwise months trims back from the newest
    // forecast date the table holds.
    if (window.from && window.to) {
      const { rows } = await db.query(
        `SELECT ${cols} FROM gold.ml_predictive_volume
         WHERE split_label = $3 AND forecast_date BETWEEN $1::date AND $2::date
         ORDER BY forecast_date ASC`,
        [window.from, window.to, split]
      );
      return rows;
    }

    if (window.months && window.months !== "all") {
      // The range control trims HISTORY ONLY. The scored window is fixed by the
      // evaluation run, so clipping it would put a partial validation period on
      // screen beneath a metrics table computed over all of it.
      //
      // Anchoring on MAX(forecast_date) truncates badly here: that row sits in the
      // projected FUTURE, and the 80/20 split makes the holdout ~16 months long, so
      // every preset shorter than that ate the entire history — "12 mo" returned
      // 0 past rows. Anchoring on the holdout START keeps it whole.
      const { rows } = await db.query(
        `SELECT ${cols} FROM gold.ml_predictive_volume
         WHERE split_label = $2
           AND (is_holdout OR is_future
                OR forecast_date >= (
                     SELECT MIN(forecast_date) FROM gold.ml_predictive_volume
                     WHERE is_holdout AND split_label = $2
                   ) - ($1::int * interval '1 month'))
         ORDER BY forecast_date ASC`,
        [Number(window.months), split]
      );
      return rows;
    }

    const { rows } = await db.query(
      `SELECT ${cols} FROM gold.ml_predictive_volume WHERE split_label = $1 ORDER BY forecast_date ASC`, [split]);
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
    // km_post joins in so the map can order segments south to north. The
    // frontend used to carry a hardcoded table of 10 exits, which left the other
    // 10 showing "km —" and, worse, unordered — congestion propagates between
    // NEIGHBOURS, so a wrong row order hides the only pattern worth seeing.
    // `estimated` marks positions calibrated from coordinates rather than taken
    // from the NLEX reference, so the UI can be honest about which is which.
    const { rows } = await db.query(`
      SELECT c.segment_name AS "segment", c.hours_ahead AS "hours",
             c.congestion_state AS "state", c.probability,
             -- The clock time each horizon refers to. "+1h" alone is a label
             -- with no referent; the reader cannot tell what it counts from.
             --
             -- Returned as TEXT, not a timestamp: base_ts is a naive column
             -- holding Manila wall-clock, and the driver was casting it to a
             -- Date, which serialised 09:00 as "01:00Z". Any client that then
             -- formatted it in a non-Manila zone would show the wrong hour.
             to_char(c.base_ts, 'YYYY-MM-DD HH24:MI') AS "baseTs",
             k.km_post::float AS "km", COALESCE(k.estimated, false) AS "kmEstimated"
      FROM gold.ml_predictive_congestion c
      LEFT JOIN gold.exit_km_post k ON k.exit_name = c.segment_name
      ORDER BY k.km_post NULLS LAST, c.segment_name ASC, c.hours_ahead ASC`);
    return rows;
  } catch (error) {
    console.error("Failed to fetch ML congestion:", error);
    return null;
  }
}

/**
 * Accepted congestion model and its measured accuracy.
 *
 * The panel hardcoded "XGBoost" while the accepted model was GRU, so the label
 * and the data described different models. Reading it from the metrics table
 * means a future retrain cannot leave the caption stale again.
 */
export async function getCongestionModel() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT model_name, r2::float AS accuracy, accepted, rejected_reason, updated_at
      FROM gold.ml_model_metrics
      WHERE target = 'Congestion' AND rank IS NOT NULL
      ORDER BY accepted DESC, r2 DESC NULLS LAST
      LIMIT 1`);
    if (!rows[0]) return null;
    const base = await db.query(`
      SELECT model_name, r2::float AS accuracy FROM gold.ml_model_metrics
      WHERE target = 'Congestion' AND rank IS NULL
      ORDER BY r2 DESC NULLS LAST LIMIT 1`);
    return {
      model: rows[0].model_name,
      accuracy: rows[0].accuracy,
      accepted: Boolean(rows[0].accepted),
      rejectedReason: rows[0].rejected_reason ?? null,
      baseline: base.rows[0] ? { model: base.rows[0].model_name, accuracy: base.rows[0].accuracy } : null,
      updatedAt: rows[0].updated_at,
    };
  } catch (error) {
    console.error("Failed to fetch congestion model:", error);
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
export async function getMLEventSurge(eventDate?: string) {
  if (!db) return null;
  try {
    // With a target date this becomes a FORECAST: the measured uplift is applied
    // to the baseline for that specific weekday and month. Without one it stays
    // a description of what past events did — which is all it could ever be,
    // since nothing in the warehouse knows when the next event is.
    if (eventDate) {
      const { rows } = await db.query(`
        WITH target AS (
          SELECT $1::date AS d,
                 EXTRACT(DOW FROM $1::date)::int AS dow,
                 EXTRACT(MONTH FROM $1::date)::int AS mon
        ),
        -- Same construction as the training baseline: median for that weekday
        -- and month, excluding known event days so they cannot inflate it.
        norm AS (
          SELECT t.exit_canonical AS plaza,
                 PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t.v)::int AS baseline
          FROM (SELECT date, exit_canonical, SUM(total) AS v
                FROM gold.fact_traffic_hourly GROUP BY 1, 2) t, target g
          WHERE EXTRACT(DOW FROM t.date) = g.dow
            AND EXTRACT(MONTH FROM t.date) = g.mon
          GROUP BY 1
        )
        SELECT n.plaza AS "exit", f.event_name AS "event", n.baseline,
               CASE WHEN f.uplift IS NOT NULL
                    THEN ROUND(n.baseline * f.uplift)::int ELSE NULL END AS "surge",
               ROUND(f.uplift, 4) AS "uplift",
               ROUND(f.uplift_lo, 4) AS "upliftLo", ROUND(f.uplift_hi, 4) AS "upliftHi",
               f.n_events AS "nEvents", f.material, f.method,
               f.anchor_exit AS "anchorExit",
               f.first_event::text AS "firstEvent", f.last_event::text AS "lastEvent",
               (SELECT d::text FROM target) AS "targetDate",
               f.baseline_volume AS "modelBaseline", f.surge_volume AS "modelSurge"
        FROM norm n
        LEFT JOIN gold.ml_event_surge_forecast f ON f.exit_name = n.plaza
        ORDER BY n.baseline DESC`, [eventDate]);
      return rows;
    }

    // gold.ml_event_surge_forecast now holds MEASURED event-day uplift per exit
    // (build_event_surge.py), keyed by canonical exit name. It previously held
    // three hand-typed rows under free-text names like "Bocaue Exit", which is
    // why this query used to carry an alias table to map them onto real plazas.
    // Both the aliases and the invented ratios are gone.
    const { rows } = await db.query(`
      WITH observed AS (
        SELECT exit_canonical AS plaza, ROUND(AVG(v))::int AS baseline
        FROM (SELECT date, exit_canonical, SUM(total) AS v
              FROM gold.fact_traffic_hourly
              WHERE date >= (SELECT MAX(date) FROM gold.fact_traffic_hourly) - interval '90 days'
              GROUP BY 1, 2) t
        GROUP BY 1
        HAVING ROUND(AVG(v)) > 0
      )
      SELECT o.plaza AS "exit",
             f.event_name AS "event",
             o.baseline AS "baseline",
             CASE WHEN f.uplift IS NOT NULL
                  THEN ROUND(o.baseline * f.uplift)::int ELSE NULL END AS "surge",
             ROUND(f.uplift, 4) AS "uplift",
             ROUND(f.uplift_lo, 4) AS "upliftLo",
             ROUND(f.uplift_hi, 4) AS "upliftHi",
             f.n_events AS "nEvents",
             f.material AS "material",
             f.method AS "method",
             f.anchor_exit AS "anchorExit",
             f.first_event::text AS "firstEvent",
             f.last_event::text AS "lastEvent",
             f.baseline_volume AS "modelBaseline",
             f.surge_volume AS "modelSurge"
      FROM observed o
      LEFT JOIN gold.ml_event_surge_forecast f ON f.exit_name = o.plaza
      ORDER BY o.baseline DESC
    `);
    return rows;
  } catch (error) {
    console.error("Failed to fetch ML event surge:", error);
    return null;
  }
}

// [ML-03b] Dated surge forecast for the NEXT Arena events.
//
// getMLEventSurge(eventDate) above already turns the measured uplift into a
// forecast for one named date. Its comment says nothing in the warehouse knows
// when the next event is; public.philippine_arena_events now does -- the
// schedule runs into 2027 -- so this enumerates the upcoming event days and
// runs that same construction for each in one query.
//
// Baseline is built exactly as the single-date path builds it: the median of
// each exit's daily total on the same weekday in the same month, so a Saturday
// concert in November is measured against November Saturdays. The two paths
// must agree or the Prescriptive tab would forecast a different surge from the
// Predictive tab for the same date.
//
// One row per event DAY. The source repeats multi-day runs as both a range row
// ("November 7–8, 2026") and single-day rows, so days are collapsed on
// start_date; the shortest title is kept. is_derived marks recurring events the
// ETL inferred (New Year Countdown) rather than announced dates.
export type UpcomingEventExit = {
  exit: string; baseline: number; surge: number; surgeLo: number; surgeHi: number;
  uplift: number; nEvents: number;
};
export type UpcomingEvent = {
  date: string; title: string; isDerived: boolean; capacity: number | null;
  exits: UpcomingEventExit[];
};

export async function getUpcomingEventSurge(limit = 6): Promise<UpcomingEvent[] | null> {
  if (!db) return null;
  try {
    const { rows } = await db.query(
      `WITH up AS (
         SELECT start_date AS d,
                (array_agg(title ORDER BY length(title), title))[1] AS title,
                bool_and(is_derived) AS is_derived,
                MAX(NULLIF(replace((regexp_match(capacity, '[0-9][0-9,]*'))[1], ',', ''), '')::int) AS capacity
         FROM philippine_arena_events
         WHERE start_date >= CURRENT_DATE
         GROUP BY start_date
         ORDER BY start_date
         LIMIT $1
       ),
       daily AS (
         SELECT date, exit_canonical AS plaza, SUM(total) AS v
         FROM gold.fact_traffic_hourly GROUP BY 1, 2
       ),
       norm AS (
         SELECT u.d, t.plaza, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t.v)::int AS baseline
         FROM up u
         JOIN daily t ON EXTRACT(DOW FROM t.date) = EXTRACT(DOW FROM u.d)
                     AND EXTRACT(MONTH FROM t.date) = EXTRACT(MONTH FROM u.d)
         GROUP BY 1, 2
       )
       SELECT u.d::text AS date, u.title, u.is_derived AS "isDerived", u.capacity,
              n.plaza AS exit, n.baseline,
              ROUND(n.baseline * f.uplift)::int    AS surge,
              ROUND(n.baseline * f.uplift_lo)::int AS "surgeLo",
              ROUND(n.baseline * f.uplift_hi)::int AS "surgeHi",
              ROUND(f.uplift, 4)::float AS uplift, f.n_events AS "nEvents"
       FROM up u
       JOIN norm n ON n.d = u.d
       JOIN gold.ml_event_surge_forecast f ON f.exit_name = n.plaza AND f.material
       ORDER BY u.d, (n.baseline * (f.uplift - 1)) DESC`,
      [limit],
    );

    const byDate = new Map<string, UpcomingEvent>();
    for (const r of rows) {
      const ev: UpcomingEvent = byDate.get(r.date) ?? {
        date: r.date, title: r.title, isDerived: !!r.isDerived,
        capacity: r.capacity == null ? null : Number(r.capacity), exits: [],
      };
      ev.exits.push({
        exit: r.exit, baseline: Number(r.baseline), surge: Number(r.surge),
        surgeLo: Number(r.surgeLo), surgeHi: Number(r.surgeHi),
        uplift: Number(r.uplift), nEvents: Number(r.nEvents),
      });
      byDate.set(r.date, ev);
    }
    return [...byDate.values()];
  } catch (error) {
    console.error("Failed to fetch upcoming event surge:", error);
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
  HoltsLinear: "pred_holts_linear",
};

export async function getMLPredictiveVolumeHourly(
  date: string,
  model = "LSTM",
  weather: "all" | "dry" | "wet" = "all",
  split: SplitLabel = DEFAULT_SPLIT
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
    const [dayRes, actualRes, profileRes] = await Promise.all([
      // The day's totals as the models see them
      db.query(
        `SELECT forecast_date::text AS date, actual_volume, ${column} AS predicted, is_future
         FROM gold.ml_predictive_volume WHERE forecast_date = $1::date AND split_label = $2`,
        [date, split]
      ),
      // Observed hourly totals, if this date has been recorded
      wetFilter === null
        ? db.query(
            `SELECT u.hr - 1 AS hour, COALESCE(SUM(u.v), 0)::bigint AS v
             FROM nlex_traffic_volume t,
                  LATERAL unnest(${HOUR_ARRAY}) WITH ORDINALITY AS u(v, hr)
             WHERE t.date = $1::date
             GROUP BY 1 ORDER BY 1`,
            [date]
          )
        : db.query(
            // The comma-join to LATERAL has to be isolated in its own CTE —
            // a JOIN in the same FROM cannot reference `t` across it.
            `WITH ${WX_CTE},
             hv AS (
               SELECT t.date AS d, u.hr - 1 AS hour, u.v AS v
               FROM nlex_traffic_volume t,
                    LATERAL unnest(${HOUR_ARRAY}) WITH ORDINALITY AS u(v, hr)
               WHERE t.date = $1::date
             )
             SELECT hv.hour, COALESCE(SUM(hv.v), 0)::bigint AS v
             FROM hv JOIN wx w ON w.d = hv.d AND w.h = hv.hour
             WHERE w.wet = $2
             GROUP BY 1 ORDER BY 1`,
            [date, wetFilter]
          ),
      // Typical share of the day carried by each hour, same weekday, recent history
      db.query(
        `WITH hv AS (
           SELECT t.date, u.hr - 1 AS hour, u.v
           FROM nlex_traffic_volume t,
                LATERAL unnest(${HOUR_ARRAY}) WITH ORDINALITY AS u(v, hr)
           WHERE EXTRACT(dow FROM t.date) = EXTRACT(dow FROM $1::date)
             AND t.date < $1::date
             AND t.date >= $1::date - interval '90 days'
         )
         SELECT hour, AVG(v)::float AS v FROM hv GROUP BY 1 ORDER BY 1`,
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
    const profile = profileRes.rows.map((r: { hour: number; v: number }) => Number(r.v));
    const profileTotal = profile.reduce((s, v) => s + v, 0);

    const dayPredicted = day.predicted != null ? Number(day.predicted) : null;
    const hasActualHours = actualByHour.size > 0;
    const canShapePrediction = dayPredicted != null && profileTotal > 0 && profile.length === 24;

    const hours: HourlyForecastPoint[] = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      // With a weather filter on, hours that don't match are absent rather
      // than zero — a zero bar would read as "no traffic".
      actual: !hasActualHours ? null : wetFilter === null ? actualByHour.get(h) ?? 0 : actualByHour.get(h) ?? null,
      predicted: canShapePrediction ? Math.round((profile[h] / profileTotal) * dayPredicted) : null,
    }));

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

/**
 * Model evaluation metrics for the predictive volume dashboard.
 *
 * These come from gold.ml_model_metrics, written by the training pipeline, so
 * the table always reflects the most recent run. The dashboard previously
 * carried these figures as hardcoded strings, which had drifted badly out of
 * step with the pipeline: it presented LSTM as the rank-1 accepted model with
 * R2 0.9911 while the table records LSTM as rank 4, REJECTED, with R2 -0.0611,
 * and the actual rank-1 model as Holt-Winters. Serving them from the database
 * keeps the reported champion honest after every retrain.
 */
export type MLModelMetric = {
  model: string;
  model_name: string;
  rank: number | null;
  accepted: boolean;
  rmse: number | null;
  mae: number | null;
  mse: number | null;
  wmape: number | null;
  r2: number | null;
  mase: number | null;
  mape: number | null;
  smape: number | null;
  rmsse: number | null;
  adjusted_r2: number | null;
  train_r2: number | null;
  val_r2: number | null;
  gap: number | null;
  uses_weather: boolean | null;
  aic: number | null;
  bic: number | null;
  diagnosis: string | null;
  rejectedReason: string | null;
  rejected_reason: string | null;
  updatedAt: string | null;
};

export async function getMLModelMetrics(split: SplitLabel = DEFAULT_SPLIT): Promise<MLModelMetric[] | null> {
  if (!db) return null;
  try {
    const { rows } = await db.query(
      // MASE is the acceptance criterion (< 1.0 beats the seasonal-naive
      // benchmark), so dropping it left the dashboard unable to show WHY a model
      // was rejected. AIC/BIC and the weather flag drive the comparison panels.
      `SELECT model_name, rank, accepted, rmse, mae, mse, wmape, r2, mase,
              mape, smape, rmsse, adjusted_r2, train_r2, val_r2, gap,
              uses_weather, aic, bic, diagnosis, rejected_reason, updated_at
       FROM gold.ml_model_metrics
       -- Scoped to the volume target. gold.ml_model_metrics is shared: the
       -- congestion classifier writes target='Congestion' rows whose r2 column
       -- holds an ACCURACY, not an R-squared. Unfiltered, those leaked into the
       -- volume panel and an accepted congestion model outranked the volume
       -- champion.
       WHERE target = 'Total Traffic' AND split_label = $1
       ORDER BY rank NULLS LAST, model_name`, [split]
    );
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return rows.map((r) => ({
      model: r.model_name,
      // Both spellings are emitted: the chart and narrative key off model_name,
      // while newer pages read `model`. Cheap insurance against another rename.
      model_name: r.model_name,
      rank: num(r.rank),
      accepted: Boolean(r.accepted),
      rmse: num(r.rmse),
      mae: num(r.mae),
      mse: num(r.mse),
      wmape: num(r.wmape),
      r2: num(r.r2),
      mase: num(r.mase),
      mape: num(r.mape),
      smape: num(r.smape),
      rmsse: num(r.rmsse),
      adjusted_r2: num(r.adjusted_r2),
      train_r2: num(r.train_r2),
      val_r2: num(r.val_r2),
      gap: num(r.gap),
      uses_weather: r.uses_weather === null ? null : Boolean(r.uses_weather),
      aic: num(r.aic),
      bic: num(r.bic),
      diagnosis: r.diagnosis ?? null,
      rejectedReason: r.rejected_reason ?? null,
      rejected_reason: r.rejected_reason ?? null,
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    }));
  } catch (error) {
    console.error("Database query failed for ML model metrics:", error);
    return null;
  }
}


export type WeatherCorrelation = {
  variable: string;
  label: string;
  pearson: number | null;
  spearman: number | null;
  days: number;
};

export type WeatherEvidence = {
  correlations: WeatherCorrelation[];
  // The controlled experiment: same model, same protocol, weather in vs out.
  modelComparison: { model: string; withWeather: number | null; withoutWeather: number | null; deltaPts: number | null }[];
};

/**
 * Evidence for whether weather predicts traffic on this corridor.
 *
 * Correlations are computed live rather than stored, so they always describe the
 * data currently in the warehouse. Weather is aggregated the corrected way —
 * averaged across the 20 stations per hour, THEN summed/averaged over the day.
 * Summing across stations (the original bug) inflated rainfall ~20x.
 */
export async function getWeatherEvidenceFromDb(): Promise<WeatherEvidence | null> {
  if (!db) return null;
  try {
    const CTE = `
      WITH hourly AS (
        SELECT (timestamp_utc + interval '8 hours')::date AS ds, timestamp_utc AS hr,
               AVG(temperature) t, AVG(rainfall) r, AVG(wind_speed) w, AVG(humidity) h
        FROM public.hourly_weather GROUP BY 1, 2
      ), wx AS (
        SELECT ds, AVG(t) avg_temp, SUM(r) total_rain, AVG(w) avg_wind, AVG(h) avg_humidity
        FROM hourly GROUP BY ds
      ), joined AS (
        SELECT v.total_volume::float y, wx.*
        FROM gold.daily_traffic_volume_corrected v JOIN wx ON wx.ds = v.date
        WHERE v.total_volume > 0
      ), ranked AS (
        SELECT RANK() OVER (ORDER BY y) ry,
               RANK() OVER (ORDER BY total_rain)   r_rain,
               RANK() OVER (ORDER BY avg_wind)     r_wind,
               RANK() OVER (ORDER BY avg_temp)     r_temp,
               RANK() OVER (ORDER BY avg_humidity) r_hum
        FROM joined
      )`;
    const { rows } = await db.query(`${CTE}
      SELECT (SELECT COUNT(*) FROM joined)::int AS days,
             (SELECT CORR(y, total_rain)   FROM joined) AS p_rain,
             (SELECT CORR(y, avg_wind)     FROM joined) AS p_wind,
             (SELECT CORR(y, avg_temp)     FROM joined) AS p_temp,
             (SELECT CORR(y, avg_humidity) FROM joined) AS p_hum,
             (SELECT CORR(ry, r_rain) FROM ranked) AS s_rain,
             (SELECT CORR(ry, r_wind) FROM ranked) AS s_wind,
             (SELECT CORR(ry, r_temp) FROM ranked) AS s_temp,
             (SELECT CORR(ry, r_hum)  FROM ranked) AS s_hum`);
    const r = rows[0];
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const correlations: WeatherCorrelation[] = [
      { variable: "avg_humidity", label: "Humidity",    pearson: num(r.p_hum),  spearman: num(r.s_hum),  days: r.days },
      { variable: "total_rain",   label: "Rainfall",    pearson: num(r.p_rain), spearman: num(r.s_rain), days: r.days },
      { variable: "avg_wind",     label: "Wind speed",  pearson: num(r.p_wind), spearman: num(r.s_wind), days: r.days },
      { variable: "avg_temp",     label: "Temperature", pearson: num(r.p_temp), spearman: num(r.s_temp), days: r.days },
    ].sort((a, b) => Math.abs(b.pearson ?? 0) - Math.abs(a.pearson ?? 0));

    // Pair each weather model with its weather-free twin from the same run.
    const m = await db.query(
      `SELECT model_name, wmape FROM gold.ml_model_metrics WHERE target = 'Total Traffic' AND split_label = $1`, [DEFAULT_SPLIT]
    );
    const byName = new Map(m.rows.map((x) => [x.model_name, x.wmape === null ? null : Number(x.wmape)]));
    const modelComparison = ["Prophet", "SARIMAX", "LSTM"].map((name) => {
      const withW = byName.get(name) ?? null;
      const without = byName.get(`${name}_nw`) ?? null;
      return {
        model: name,
        withWeather: withW,
        withoutWeather: without,
        // positive => the weather version is better
        deltaPts: withW != null && without != null ? Number((without - withW).toFixed(3)) : null,
      };
    });
    return { correlations, modelComparison };
  } catch (error) {
    console.error("Database query failed for weather evidence:", error);
    return null;
  }
}


// ─── Corridor CO2 forecast ───────────────────────────────────────────────────

export type EmissionForecastPoint = {
  date: string;
  actual: number | null;
  predicted: number | null;      // the champion's forecast
  gbr: number | null;
  polynomial: number | null;
  lstm: number | null;
  zone: "past" | "present" | "future";
};

export type EmissionForecast = {
  championModel: string | null;
  series: EmissionForecastPoint[];
  split: {
    trainDays: number; holdoutDays: number; futureDays: number;
    trainStart: string | null; trainEnd: string | null;
    holdoutStart: string | null; holdoutEnd: string | null;
    futureStart: string | null; futureEnd: string | null;
    trainPct: number | null;
    holdoutPct: number | null;
  };
  metrics: MLModelMetric[];
};

/**
 * The served CO2 forecast, in the same past/present/future shape the volume
 * panel uses so the two read alike.
 *
 * The actuals are NOT a separate series: they roll up from
 * gold.fact_emissions_hourly, which is derived from the same traffic table the
 * volume forecast is trained on. The two panels therefore cannot disagree
 * (verified to 0.0005 t/day).
 *
 * Horizon is 7 days here versus 14 for volume, per the modelling diagram, so
 * the two sets of error metrics are NOT directly comparable.
 */
export async function getEmissionForecast(months?: number): Promise<EmissionForecast | null> {
  if (!db) return null;
  try {
    // The champion is stamped on every row by the trainer, so the API never has
    // to re-derive "which model is being served" from the metrics ordering.
    const params: unknown[] = [];
    let where = "";
    if (months && months > 0) {
      // Windowing counts back from the last ACTUAL day, not from today, so the
      // future block is never cropped out by a short window.
      where = `WHERE forecast_date >= (
                 SELECT MAX(forecast_date) - ($1::int * INTERVAL '1 month')
                 FROM gold.ml_predictive_emissions WHERE actual_co2 IS NOT NULL)`;
      params.push(months);
    }
    const [seriesQ, splitQ, metricsQ] = await Promise.all([
      db.query(
        `SELECT forecast_date::text AS d, actual_co2, pred_gbr, pred_polynomial,
                pred_lstm, champion_model, is_holdout, is_future
         FROM gold.ml_predictive_emissions ${where} ORDER BY forecast_date ASC`, params),
      db.query(
        `SELECT COUNT(*) FILTER (WHERE NOT is_holdout AND NOT is_future)::int AS train_days,
                COUNT(*) FILTER (WHERE is_holdout)::int AS holdout_days,
                COUNT(*) FILTER (WHERE is_future)::int  AS future_days,
                MIN(forecast_date) FILTER (WHERE NOT is_holdout AND NOT is_future)::text AS train_start,
                MAX(forecast_date) FILTER (WHERE NOT is_holdout AND NOT is_future)::text AS train_end,
                MIN(forecast_date) FILTER (WHERE is_holdout)::text AS holdout_start,
                MAX(forecast_date) FILTER (WHERE is_holdout)::text  AS holdout_end,
                MIN(forecast_date) FILTER (WHERE is_future)::text   AS future_start,
                MAX(forecast_date) FILTER (WHERE is_future)::text   AS future_end
         FROM gold.ml_predictive_emissions`),
      db.query(
        // diagnosis carries the tie note: GBR is not bit-reproducible across
        // processes, so two models inside that jitter are co-champions and the
        // panel must not present one as the winner.
        `SELECT model_name, rank, accepted, rmse, mae, wmape, r2, mase, mape,
                rejected_reason, uses_weather, diagnosis, updated_at
         FROM gold.ml_model_metrics
         WHERE target = 'Corridor CO2'
         ORDER BY rank NULLS LAST, model_name`),
    ]);

    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const champion: string | null = seriesQ.rows.find((r) => r.champion_model)?.champion_model ?? null;
    const colOf: Record<string, "pred_gbr" | "pred_polynomial" | "pred_lstm"> = {
      GBR: "pred_gbr", Polynomial: "pred_polynomial", LSTM: "pred_lstm",
    };
    const champCol = champion ? colOf[champion] : undefined;

    const series: EmissionForecastPoint[] = seriesQ.rows.map((r) => ({
      date: r.d,
      actual: num(r.actual_co2),
      predicted: champCol ? num(r[champCol]) : null,
      gbr: num(r.pred_gbr),
      polynomial: num(r.pred_polynomial),
      lstm: num(r.pred_lstm),
      zone: r.is_future ? "future" : r.is_holdout ? "present" : "past",
    }));

    const s = splitQ.rows[0];
    // Percentage is over train+holdout: future days have no actual to score
    // against, so counting them would understate the holdout share.
    const scored = Number(s.train_days) + Number(s.holdout_days);
    return {
      championModel: champion,
      series,
      split: {
        trainDays: Number(s.train_days), holdoutDays: Number(s.holdout_days),
        futureDays: Number(s.future_days),
        trainStart: s.train_start, trainEnd: s.train_end,
        holdoutStart: s.holdout_start, holdoutEnd: s.holdout_end,
        futureStart: s.future_start, futureEnd: s.future_end,
        // Both halves, so the panel can state the split the way the volume
        // panel does rather than showing only one side of it.
        trainPct: scored ? Number(((Number(s.train_days) / scored) * 100).toFixed(2)) : null,
        holdoutPct: scored ? Number(((Number(s.holdout_days) / scored) * 100).toFixed(2)) : null,
      },
      metrics: metricsQ.rows.map((r) => ({
        model: r.model_name, model_name: r.model_name,
        rank: num(r.rank), accepted: Boolean(r.accepted),
        rmse: num(r.rmse), mae: num(r.mae), wmape: num(r.wmape), r2: num(r.r2),
        mase: num(r.mase), mape: num(r.mape),
        rejectedReason: r.rejected_reason ?? null,
        rejected_reason: r.rejected_reason ?? null,
        uses_weather: r.uses_weather === null ? null : Boolean(r.uses_weather),
        diagnosis: r.diagnosis ?? null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      })) as MLModelMetric[],
    };
  } catch (error) {
    // Reporting every failure as "database not reachable" is what made this panel
    // claim the database was down when it was up. The pool comment in config/db.ts
    // records the same false alarm: on this shared RDS instance a handshake can
    // exceed the timeout while the pipelines run, and a query error looks nothing
    // like an outage. Classify, so the message the user reads is true.
    const e = error as { code?: string; message?: string };
    const CONNECTIVITY = new Set([
      "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET", "EPIPE",
      "57P01", // admin_shutdown
      "57P03", // cannot_connect_now
      "08000", "08001", "08003", "08004", "08006", // connection exceptions
    ]);
    // Classifying on `code` ALONE was wrong, and it is the common case that it
    // misses: node-postgres reports a connect timeout as
    //   message "Connection terminated due to connection timeout", code undefined
    // (verified against a live pool). With no code, a plain connectivity blip
    // was labelled a query error -> HTTP 500 -> retryable:false -> the panel
    // gave up after one attempt and showed a permanent failure for something
    // that clears on its own. Match the message too.
    const CONNECTIVITY_MSG =
      /(connection terminated|connection timeout|timeout exceeded when trying to connect|not queryable|server closed the connection|connection refused|socket hang up|read econnreset)/i;
    const transient =
      (e.code != null && CONNECTIVITY.has(e.code)) ||
      CONNECTIVITY_MSG.test(e.message ?? "");
    console.error(
      `Emission forecast query failed (${transient ? "connectivity" : "query"}; code=${e.code ?? "none"}):`,
      e.message ?? error
    );
    throw Object.assign(new Error(e.message ?? "Emission forecast query failed"), {
      kind: transient ? "connectivity" : "query",
      code: e.code,
    });
  }
}


// ─── Forecast accuracy as a function of horizon ──────────────────────────────

export type HorizonAccuracy = {
  model: string;
  hLo: number;
  hHi: number;
  n: number;
  wmape: number | null;
  mape: number | null;
  mase: number | null;
  mae: number | null;
  baselineWmape: number | null;
  usable: boolean;
  note: string | null;
};

/**
 * How error grows with how far ahead a day was.
 *
 * The volume panel projects 90 days but its headline metrics were measured at
 * h=14. Quoting one WMAPE across the whole projection would claim the day-90
 * forecast is as good as the day-1 forecast. These buckets come from a separate
 * rolling-origin run at h=90 (horizon_study.py), so the chart can label each
 * stretch with the accuracy that actually applies to it.
 *
 * Measured for the ACCEPTED model only. The rejected models are still drawn if
 * the reader toggles them, but nothing here vouches for them at long range —
 * SARIMAX in particular collapses to implausible values past a few weeks.
 */
export async function getHorizonAccuracy(target = "Total Traffic"): Promise<HorizonAccuracy[] | null> {
  if (!db) return null;
  try {
    const { rows } = await db.query(
      `SELECT model_name, h_lo, h_hi, n, wmape, mape, mase, mae,
              baseline_wmape, usable, note
       FROM gold.ml_horizon_accuracy
       WHERE target = $1
       ORDER BY h_lo`, [target]);
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return rows.map((r) => ({
      model: r.model_name,
      hLo: Number(r.h_lo),
      hHi: Number(r.h_hi),
      n: Number(r.n),
      wmape: num(r.wmape),
      mape: num(r.mape),
      mase: num(r.mase),
      mae: num(r.mae),
      baselineWmape: num(r.baseline_wmape),
      usable: Boolean(r.usable),
      note: r.note ?? null,
    }));
  } catch (error) {
    console.error("Database query failed for horizon accuracy:", error);
    return null;
  }
}


// ─── Congestion accuracy per forecast horizon ───────────────────────────────

export type CongestionHorizonAccuracy = {
  model: string;
  horizon: number;
  accuracy: number | null;
  n: number;
  persistenceAccuracy: number | null;
};

/**
 * Accuracy at +1h … +12h for the served congestion model.
 *
 * The previous training run could not produce this: it never shifted the target
 * by the horizon, so all twelve horizons were the same prediction and a
 * per-horizon breakdown would have been twelve identical numbers. With the
 * target fixed the decay is real, and a single averaged accuracy hides it —
 * which is the one thing a reader needs when deciding how far ahead to trust
 * the map.
 *
 * `persistenceAccuracy` is the "nothing changes" benchmark at the same horizon.
 * It is the honest bar: a forecaster that cannot beat it adds nothing.
 */
export async function getCongestionHorizonAccuracy(): Promise<CongestionHorizonAccuracy[] | null> {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT h.model_name, h.horizon, h.accuracy, h.n, h.persistence_accuracy
      FROM gold.ml_congestion_horizon_accuracy h
      -- Only the model actually being served; the others are on the leaderboard
      -- but their curves would imply the map can switch between them.
      WHERE h.model_name = (
        SELECT model_name FROM gold.ml_model_metrics
        WHERE target = 'Congestion' AND accepted IS TRUE
        ORDER BY rank NULLS LAST LIMIT 1)
      ORDER BY h.horizon`);
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return rows.map((r) => ({
      model: r.model_name,
      horizon: Number(r.horizon),
      accuracy: num(r.accuracy),
      n: Number(r.n),
      persistenceAccuracy: num(r.persistence_accuracy),
    }));
  } catch (error) {
    console.error("Database query failed for congestion horizon accuracy:", error);
    return null;
  }
}


/**
 * Out-of-sample result for the event-surge uplift (eval_event_surge.py).
 *
 * The panel is built from OBSERVED history, which is a descriptive statistic —
 * so on its own it could not claim to be tested. This is the separate check
 * that answers the operational question: using uplift learned from earlier
 * events, how well does it predict LATER events it never saw?
 */
export async function getEventSurgeMetrics() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT model_name AS "model", wmape, mape, mae, r2, accepted, diagnosis
      FROM gold.ml_model_metrics WHERE target = 'Event Surge'
      ORDER BY rank NULLS LAST, wmape`);
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return rows.map((r) => ({
      model: r.model, wmape: num(r.wmape), mape: num(r.mape), mae: num(r.mae),
      r2: num(r.r2), accepted: Boolean(r.accepted), diagnosis: r.diagnosis ?? null,
    }));
  } catch (error) {
    console.error("Database query failed for event surge metrics:", error);
    return null;
  }
}
