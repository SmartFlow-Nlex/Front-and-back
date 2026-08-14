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
        // table points at Cdv/Ph Arena (the Philippine Arena's exit) and bronze
        // now carries a volume series for it, so no proxy is needed. This
        // previously fell back to Bocaue, 2.4 km away, because the public
        // matview had no CDV series.
        //
        // Source is bronze.nlex_traffic_volume rather than the nlex_traffic_volume
        // matview: the matview is stale (it still holds the pre-rebuild plaza
        // names and has no CDV at all) and it SUMs, which would double the three
        // plazas that were loaded twice. DISTINCT ON de-duplicates by
        // (plaza, date, hour, direction) at read time, so the figures are correct
        // whether or not the duplicate rows are ever cleaned up.
        //
        // Also note the volume series only contains type = 'Entries', so this
        // counts vehicles ENTERING NLEX at the plaza — largely the post-event
        // exodus onto the expressway rather than arrivals.
        //
        // Events falling on a holiday are flagged, since their deviation is
        // really a holiday effect.
        db.query(
          `WITH pv AS (
             SELECT q.toll_plaza, q.date_day AS date, SUM(q.total_volume)::bigint AS v
             FROM (
               SELECT DISTINCT ON (toll_plaza, date_day, hour_of_day, direction)
                      toll_plaza, date_day, hour_of_day, direction, total_volume
               FROM bronze.nlex_traffic_volume
               ORDER BY toll_plaza, date_day, hour_of_day, direction, id
             ) q
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
export type ForecastWindow = { months?: "3" | "12" | "all"; from?: string; to?: string };

export async function getMLPredictiveVolume(window: ForecastWindow = {}) {
  if (!db) return null;
  const cols = `forecast_date as "date", actual_volume, pred_lstm, pred_prophet, pred_xgboost, pred_holtwinters, pred_sarimax, pred_holts_linear, is_holdout, is_future`;
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
      WITH observed AS (
        SELECT toll_plaza,
               ROUND(AVG(${DAY_TOTAL}))::int AS baseline
        FROM nlex_traffic_volume
        WHERE type = 'Entries' AND vehicle_class = 'Total'
          AND date >= (SELECT MAX(date) FROM nlex_traffic_volume) - interval '90 days'
        GROUP BY 1
        HAVING ROUND(AVG(${DAY_TOTAL})) > 0
      ),
      -- Forecast exit names are free text ("Bocaue Exit"); a prefix match would
      -- also catch "Bocaue Barrier", which is a mainline barrier and not the
      -- exit the model means. Map explicitly.
      alias(forecast_name, plaza) AS (
        VALUES ('Bocaue Exit', 'Bocaue Interchange'),
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
  HoltsLinear: "pred_holts_linear",
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
    const [dayRes, actualRes, profileRes] = await Promise.all([
      // The day's totals as the models see them
      db.query(
        `SELECT forecast_date::text AS date, actual_volume, ${column} AS predicted, is_future
         FROM gold.ml_predictive_volume WHERE forecast_date = $1::date`,
        [date]
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
  rank: number | null;
  accepted: boolean;
  rmse: number | null;
  mae: number | null;
  wmape: number | null;
  r2: number | null;
  diagnosis: string | null;
  rejectedReason: string | null;
  updatedAt: string | null;
};

export async function getMLModelMetrics(): Promise<MLModelMetric[] | null> {
  if (!db) return null;
  try {
    const { rows } = await db.query(
      `SELECT model_name, rank, accepted, rmse, mae, wmape, r2,
              diagnosis, rejected_reason, updated_at
       FROM gold.ml_model_metrics
       ORDER BY rank NULLS LAST, model_name`
    );
    return rows.map((r) => ({
      model: r.model_name,
      rank: r.rank === null ? null : Number(r.rank),
      accepted: Boolean(r.accepted),
      rmse: r.rmse === null ? null : Number(r.rmse),
      mae: r.mae === null ? null : Number(r.mae),
      wmape: r.wmape === null ? null : Number(r.wmape),
      r2: r.r2 === null ? null : Number(r.r2),
      diagnosis: r.diagnosis ?? null,
      rejectedReason: r.rejected_reason ?? null,
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    }));
  } catch (error) {
    console.error("Database query failed for ML model metrics:", error);
    return null;
  }
}
