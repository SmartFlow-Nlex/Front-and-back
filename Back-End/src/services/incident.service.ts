import { db } from "../config/db.js";

// ---------------------------------------------------------------------------
// Incident analytics for the descriptive dashboard.
// Sources: nlex_road_crashes, nlex_motorcycle_crashes, nlex_stalled_vehicles
// (operations logs with Km-post locations), plus hourly_weather for exposure.
// ---------------------------------------------------------------------------

export type IncidentSource = "all" | "road" | "moto" | "stalled";

export type IncidentWeather = "all" | "dry" | "wet";

export type IncidentAnalyticsFilters = {
  months: "3" | "12" | "all";
  from?: string;
  to?: string;
  source?: IncidentSource;
  weather?: IncidentWeather;
};

type CacheEntry = { at: number; data: unknown };
const incidentCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000;

// Unified incident log. Dates are stored as text in two formats.
// Response minutes are computed mod 24h to survive midnight wrap, capped at 120.
const INCIDENTS_CTE = `
  incidents AS (
    SELECT CASE WHEN date LIKE '%/%' THEN to_date(date, 'MM/DD/YYYY') ELSE date::date END AS d, reported_time AS rt, response_time AS resp,
           location, cause_of_accident AS cause, type_of_accident AS itype,
           weather_condition,
           COALESCE(injuries_male, 0) + COALESCE(injuries_female, 0) AS inj,
           COALESCE(fatalities_male, 0) + COALESCE(fatalities_female, 0) AS fat,
           'road' AS src
    FROM nlex_road_crashes WHERE date IS NOT NULL
    UNION ALL
    SELECT CASE WHEN date LIKE '%/%' THEN to_date(date, 'MM/DD/YYYY') ELSE date::date END, reported_time, response_time,
           location, cause_of_accident, type_of_accident, weather_condition,
           COALESCE(injuries_male, 0) + COALESCE(injuries_female, 0),
           COALESCE(fatalities_male, 0) + COALESCE(fatalities_female, 0),
           'moto'
    FROM nlex_motorcycle_crashes WHERE date IS NOT NULL
    UNION ALL
    SELECT CASE WHEN date LIKE '%/%' THEN to_date(date, 'MM/DD/YYYY') ELSE date::date END, reported_time, responded_time,
           location, vehicle_cause, 'Stalled vehicle', NULL, 0, 0, 'stalled'
    FROM nlex_stalled_vehicles WHERE date IS NOT NULL
  )`;

const RESPONSE_MIN = `
  CASE WHEN rt IS NOT NULL AND resp IS NOT NULL THEN
    MOD((EXTRACT(EPOCH FROM (resp::time - rt::time)) / 60)::int + 1440, 1440)
  END`;

const HOUR_OF = `EXTRACT(hour FROM rt::time)::int`;
const KM_OF = `(regexp_match(location, 'Km\\s*(\\d+)'))[1]::int`;

export async function getIncidentAnalyticsFromDb(filters: IncidentAnalyticsFilters) {
  if (!db) return null;

  const cacheKey = JSON.stringify(filters);
  const cached = incidentCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  try {
    const bounds = await db.query(
      `SELECT min(CASE WHEN date LIKE '%/%' THEN to_date(date, 'MM/DD/YYYY') ELSE date::date END)::text AS lo, max(CASE WHEN date LIKE '%/%' THEN to_date(date, 'MM/DD/YYYY') ELSE date::date END)::text AS hi FROM nlex_road_crashes`
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

    const src = filters.source && filters.source !== "all" ? filters.source : null;
    const wx = filters.weather && filters.weather !== "all" ? filters.weather : null;
    // $1=lo $2=hi $3=src (nullable) $4=weather (nullable: 'wet'|'dry')
    const params = [lo, hi, src, wx];

    // Hour-level wet/dry classification (expressway-avg rainfall > 0.3 mm), spanning
    // the previous period too so the KPI comparison stays weather-filtered.
    const WXALL_CTE = `
      wxall AS (
        SELECT (timestamp_utc + interval '8 hours')::date AS d,
               EXTRACT(hour FROM timestamp_utc + interval '8 hours')::int AS h,
               AVG(rainfall) > 0.3 AS wet
        FROM hourly_weather
        WHERE (timestamp_utc + interval '8 hours')::date BETWEEN $1::date - ($2::date - $1::date + 1) AND $2
        GROUP BY 1, 2
      )`;
    const WEATHER_OK = `($4::text IS NULL OR (rt IS NOT NULL AND EXISTS (
      SELECT 1 FROM wxall w WHERE w.d = incidents.d AND w.h = ${HOUR_OF} AND w.wet = ($4 = 'wet'))))`;
    const WHERE = `d BETWEEN $1 AND $2 AND ($3::text IS NULL OR src = $3) AND ${WEATHER_OK}`;

    // Local time = UTC+8 for weather join
    const WX_CTE = `
      wx AS (
        SELECT (timestamp_utc + interval '8 hours')::date AS d,
               EXTRACT(hour FROM timestamp_utc + interval '8 hours')::int AS h,
               AVG(rainfall) AS rain
        FROM hourly_weather
        WHERE (timestamp_utc + interval '8 hours')::date BETWEEN $1 AND $2
        GROUP BY 1, 2
      )`;

    const [trend, hotspot, heatmap, causes, types, weatherExposure, weatherIncidents, jamSpeedWx, kpi] =
      await Promise.all([
        // Daily counts by source (client rolls up to weekly/monthly)
        db.query(
          `WITH ${INCIDENTS_CTE}, ${WXALL_CTE}
           SELECT d::text, COUNT(*) FILTER (WHERE src = 'road')::int AS road,
                  COUNT(*) FILTER (WHERE src = 'moto')::int AS moto,
                  COUNT(*) FILTER (WHERE src = 'stalled')::int AS stalled
           FROM incidents WHERE ${WHERE} GROUP BY 1 ORDER BY 1`,
          params
        ),
        // Hotspots: 5-km bins from the Km-post in the location field
        db.query(
          `WITH ${INCIDENTS_CTE}, ${WXALL_CTE}
           SELECT (FLOOR(${KM_OF} / 5) * 5)::int AS km_bin, COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE src = 'road')::int AS road,
                  COUNT(*) FILTER (WHERE src = 'moto')::int AS moto,
                  COUNT(*) FILTER (WHERE src = 'stalled')::int AS stalled,
                  SUM(inj)::int AS injuries, SUM(fat)::int AS fatalities
           FROM incidents
           WHERE ${WHERE} AND location ~ 'Km\\s*\\d+'
           GROUP BY 1 ORDER BY 2 DESC`,
          params
        ),
        // Hour x day-of-week frequency
        db.query(
          `WITH ${INCIDENTS_CTE}, ${WXALL_CTE}
           SELECT EXTRACT(dow FROM d)::int AS dow, ${HOUR_OF} AS hour, COUNT(*)::int AS v
           FROM incidents WHERE ${WHERE} AND rt IS NOT NULL
           GROUP BY 1, 2 ORDER BY 1, 2`,
          params
        ),
        // Top causes with severity
        db.query(
          `WITH ${INCIDENTS_CTE}, ${WXALL_CTE}
           SELECT cause AS label, COUNT(*)::int AS total, SUM(inj)::int AS injuries, SUM(fat)::int AS fatalities
           FROM incidents WHERE ${WHERE} AND cause IS NOT NULL
           GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
          params
        ),
        // Top accident types with severity (crashes only — stalled vehicles have no type)
        db.query(
          `WITH ${INCIDENTS_CTE}, ${WXALL_CTE}
           SELECT itype AS label, COUNT(*)::int AS total, SUM(inj)::int AS injuries, SUM(fat)::int AS fatalities
           FROM incidents WHERE ${WHERE} AND itype IS NOT NULL AND src <> 'stalled'
           GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
          params
        ),
        // Weather exposure: wet vs dry hours in range (expressway-wide avg rainfall)
        db.query(
          `WITH ${WX_CTE}
           SELECT COUNT(*) FILTER (WHERE rain > 0.3)::int AS wet_hours,
                  COUNT(*) FILTER (WHERE rain <= 0.3)::int AS dry_hours
           FROM wx`,
          [lo, hi]
        ),
        // Incidents on wet vs dry hours, by source
        db.query(
          `WITH ${INCIDENTS_CTE}, ${WX_CTE}
           SELECT (w.rain > 0.3) AS wet, i.src, COUNT(*)::int AS n
           FROM incidents i JOIN wx w ON w.d = i.d AND w.h = EXTRACT(hour FROM i.rt::time)::int
           WHERE i.d BETWEEN $1 AND $2 AND ($3::text IS NULL OR i.src = $3) AND i.rt IS NOT NULL
             AND ($4::text IS NULL OR (w.rain > 0.3) = ($4 = 'wet'))
           GROUP BY 1, 2`,
          params
        ),
        // Traffic impact: avg jam speed on wet vs dry hours
        db.query(
          `WITH ${WX_CTE}
           SELECT (w.rain > 0.3) AS wet,
                  ROUND(AVG(j.avg_speed_kmh)::numeric, 1)::float AS speed,
                  ROUND(AVG(j.avg_jam_level)::numeric, 2)::float AS jam_level
           FROM fact_hourly_jams j JOIN wx w ON w.d = j.date_day AND w.h = j.hour_of_day
           WHERE j.date_day BETWEEN $1 AND $2
           GROUP BY 1`,
          [lo, hi]
        ),
        // KPI: current vs previous period + severity + response time + rain share
        db.query(
          `WITH ${INCIDENTS_CTE}, ${WXALL_CTE}
           SELECT
             COUNT(*) FILTER (WHERE ${WHERE})::int AS cur_total,
             COUNT(*) FILTER (WHERE d >= $1::date - ($2::date - $1::date + 1) AND d < $1::date AND ($3::text IS NULL OR src = $3) AND ${WEATHER_OK})::int AS prev_total,
             SUM(inj) FILTER (WHERE ${WHERE})::int AS injuries,
             SUM(fat) FILTER (WHERE ${WHERE})::int AS fatalities,
             ROUND(AVG(${RESPONSE_MIN}) FILTER (WHERE ${WHERE} AND ${RESPONSE_MIN} BETWEEN 0 AND 120)::numeric, 1)::float AS avg_response_min,
             COUNT(*) FILTER (WHERE ${WHERE} AND weather_condition = 'Rainy')::int AS rainy_crashes,
             COUNT(*) FILTER (WHERE ${WHERE} AND weather_condition IS NOT NULL)::int AS weather_known
           FROM incidents`,
          params
        ),
      ]);

    const wxInc = { wet: { road: 0, moto: 0, stalled: 0 }, dry: { road: 0, moto: 0, stalled: 0 } };
    for (const r of weatherIncidents.rows) {
      const bucket = r.wet ? wxInc.wet : wxInc.dry;
      bucket[r.src as "road" | "moto" | "stalled"] = r.n;
    }
    const jamWx = { wet: null as { speed: number; jam_level: number } | null, dry: null as { speed: number; jam_level: number } | null };
    for (const r of jamSpeedWx.rows) {
      jamWx[r.wet ? "wet" : "dry"] = { speed: r.speed, jam_level: r.jam_level };
    }

    const data = {
      range: { from: lo, to: hi },
      meta: { minDate, maxDate },
      kpis: {
        totalIncidents: kpi.rows[0].cur_total,
        prevTotalIncidents: kpi.rows[0].prev_total,
        injuries: kpi.rows[0].injuries ?? 0,
        fatalities: kpi.rows[0].fatalities ?? 0,
        avgResponseMin: kpi.rows[0].avg_response_min,
        rainyCrashes: kpi.rows[0].rainy_crashes,
        weatherKnown: kpi.rows[0].weather_known,
      },
      dailyTrend: trend.rows,
      hotspots: hotspot.rows,
      heatmap: heatmap.rows,
      causes: causes.rows,
      types: types.rows,
      weather: {
        wetHours: weatherExposure.rows[0].wet_hours,
        dryHours: weatherExposure.rows[0].dry_hours,
        incidents: wxInc,
        jam: jamWx,
      },
    };

    incidentCache.set(cacheKey, { at: Date.now(), data });
    return data;
  } catch (error) {
    console.error("Database query failed for incident analytics:", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hourly drill-down for one day — the chart you land on after clicking a point
// on the predictive forecast.
//
// Every hour is classified wet/dry from real recorded rainfall (hourly_weather,
// expressway-average > 0.3 mm — the same threshold the descriptive tab and the
// predictive weather split already use). Nothing here is modelled or synthesised:
// if an hour has no weather reading, it reports null and is excluded from both
// the Dry and the Wet slice rather than being assumed dry.
//
// The subtlety this endpoint exists to get right is the difference between
// "zero incidents happened in this hour" and "the incident log doesn't reach
// this day yet". The three source tables end on different dates (road/moto stop
// earlier than stalled), and the forecast horizon runs past all of them — so a
// day inside the horizon would otherwise render 24 confident zero bars that are
// really absence of data. sourceCoverage reports each table's last logged day so
// the caller can label an uncovered source instead of drawing a zero for it.
// ---------------------------------------------------------------------------

export type IncidentHourlyPoint = {
  hour: number;
  /** Expressway-average rainfall for the hour, or null when unrecorded. */
  rainfallMm: number | null;
  /** Expressway-average temperature (°C) for the hour, or null when unrecorded. */
  temperatureC: number | null;
  /** null (not false) when rainfallMm is null — unknown weather, not dry weather. */
  isWet: boolean | null;
  road: number;
  moto: number;
  stalled: number;
  total: number;
};

// The incident model set, which is NOT the traffic one — there is no Prophet,
// Holt-Winters or Holts Linear column on ml_predictive_incidents. These seven
// keys match ModelKey in PredictiveIncidentChart and MODEL_NAMES in
// train_incident_models.py, so the drill-down offers exactly the models the
// daily incident chart does, named the same way.
const INCIDENT_MODEL_COLUMN = {
  XGBoost: "pred_xgboost",
  RandomForest: "pred_randomforest",
  Poisson_GLM: "pred_poisson_glm",
  NegBinomial_GLM: "pred_negbinomial_glm",
  SARIMAX: "pred_sarimax",
  LSTM: "pred_lstm",
  GRU: "pred_gru",
} as const;

export type IncidentModelKey = keyof typeof INCIDENT_MODEL_COLUMN;

export async function getIncidentHourlyFromDb(date: string) {
  if (!db) return null;

  const cacheKey = `hourly:${date}`;
  const cached = incidentCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  try {
    const DATE_OF = (col = "date") =>
      `CASE WHEN ${col} LIKE '%/%' THEN to_date(${col}, 'MM/DD/YYYY') ELSE ${col}::date END`;

    const modelCols = Object.values(INCIDENT_MODEL_COLUMN)
      .map((col) => `${col}::float AS ${col}`)
      .join(",\n                ");

    const [hourly, coverage, dayRes, profileRes] = await Promise.all([
      // generate_series(0,23) is the spine so every hour of the day appears even
      // when it had no incidents and no weather station reported — a gap in the
      // x-axis would misread as "no such hour" rather than "nothing happened".
      db.query(
        `WITH ${INCIDENTS_CTE},
              wx AS (
                SELECT EXTRACT(hour FROM timestamp_utc + interval '8 hours')::int AS h,
                       AVG(rainfall) AS rain,
                       AVG(temperature) AS temp
                FROM hourly_weather
                WHERE (timestamp_utc + interval '8 hours')::date = $1::date
                GROUP BY 1
              ),
              hrs AS (SELECT generate_series(0, 23) AS h)
         SELECT hrs.h                                             AS hour,
                ROUND(wx.rain::numeric, 3)::float                 AS rainfall_mm,
                ROUND(wx.temp::numeric, 1)::float                 AS temperature_c,
                (wx.rain > 0.3)                                   AS is_wet,
                COUNT(i.d) FILTER (WHERE i.src = 'road')::int     AS road,
                COUNT(i.d) FILTER (WHERE i.src = 'moto')::int     AS moto,
                COUNT(i.d) FILTER (WHERE i.src = 'stalled')::int  AS stalled,
                COUNT(i.d)::int                                   AS total
         FROM hrs
         LEFT JOIN wx ON wx.h = hrs.h
         LEFT JOIN incidents i
                ON i.d = $1::date
               AND i.rt IS NOT NULL
               AND EXTRACT(hour FROM i.rt::time)::int = hrs.h
         GROUP BY 1, 2, 3, 4
         ORDER BY 1`,
        [date]
      ),
      // Last logged day per source table, so the caller can tell an honest zero
      // from an out-of-range day.
      db.query(
        `SELECT 'road' AS src, max(${DATE_OF()})::text AS last_logged FROM nlex_road_crashes WHERE date IS NOT NULL
         UNION ALL
         SELECT 'moto', max(${DATE_OF()})::text FROM nlex_motorcycle_crashes WHERE date IS NOT NULL
         UNION ALL
         SELECT 'stalled', max(${DATE_OF()})::text FROM nlex_stalled_vehicles WHERE date IS NOT NULL`
      ),
      // Every model's predicted DAILY total for this date. Absent for days
      // outside the walk-forward window (ml_predictive_incidents holds only
      // validation + future rows), which is why the caller must tolerate an
      // empty result rather than assume a row exists.
      db.query(
        `SELECT prediction_type,
                champion_model,
                predicted_incident_count::float AS champion_prediction,
                ${modelCols}
         FROM ml_predictive_incidents
         WHERE forecast_date = $1::date`,
        [date]
      ),
      // Typical share of the day carried by each hour, same weekday, 90 days of
      // history before this date. Only the relative shape matters — it is
      // normalised to a fraction before being applied — so raw counts are
      // enough and no per-day averaging is needed.
      db.query(
        `WITH ${INCIDENTS_CTE}
         SELECT EXTRACT(hour FROM rt::time)::int AS hour, COUNT(*)::float AS v
         FROM incidents
         WHERE rt IS NOT NULL
           AND EXTRACT(dow FROM d) = EXTRACT(dow FROM $1::date)
           AND d < $1::date
           AND d >= $1::date - interval '90 days'
         GROUP BY 1
         ORDER BY 1`,
        [date]
      ),
    ]);

    // Mapped, not cast: the driver hands back the SQL column names
    // (rainfall_mm, is_wet) and this endpoint's contract is camelCase, matching
    // /predictive. A bare `as IncidentHourlyPoint[]` type-checks but silently
    // leaves every camelCase read undefined.
    type HourRow = {
      hour: number;
      rainfall_mm: number | null;
      temperature_c: number | null;
      is_wet: boolean | null;
      road: number;
      moto: number;
      stalled: number;
      total: number;
    };
    const hours: IncidentHourlyPoint[] = (hourly.rows as HourRow[]).map((r) => ({
      hour: r.hour,
      rainfallMm: r.rainfall_mm,
      temperatureC: r.temperature_c,
      isWet: r.is_wet,
      road: r.road,
      moto: r.moto,
      stalled: r.stalled,
      total: r.total,
    }));

    const sourceCoverage = Object.fromEntries(
      coverage.rows.map((r: { src: string; last_logged: string | null }) => [
        r.src,
        { lastLogged: r.last_logged, covered: r.last_logged != null && date <= r.last_logged },
      ])
    ) as Record<"road" | "moto" | "stalled", { lastLogged: string | null; covered: boolean }>;

    // An hour counts toward a weather slice only when its weather is known.
    const known = hours.filter((h) => h.isWet !== null);
    const wetHours = known.filter((h) => h.isWet === true);
    const dryHours = known.filter((h) => h.isWet === false);
    const sum = (rows: IncidentHourlyPoint[]) => rows.reduce((s, h) => s + h.total, 0);

    // ---- Model predictions, distributed across the day -------------------
    // The pipeline predicts a DAILY incident count; it has no hourly output.
    // To draw a model against the hourly bars, that daily total is spread over
    // the typical shape of this weekday (90 days of history) — the same
    // mechanism the traffic drill-down uses. This is a derived curve, not a
    // model output, which is why profileSource is reported alongside it and
    // the UI labels it rather than presenting it as an hourly forecast.
    const profile = Array<number>(24).fill(0);
    for (const r of profileRes.rows as { hour: number; v: number }[]) {
      if (r.hour >= 0 && r.hour < 24) profile[r.hour] = Number(r.v) || 0;
    }
    const profileTotal = profile.reduce((s, v) => s + v, 0);
    const canShape = profileTotal > 0;

    const dayRow = dayRes.rows[0] as
      | ({ prediction_type: string; champion_model: string | null; champion_prediction: number | null } & Record<
          string,
          number | null | string
        >)
      | undefined;

    const models = (Object.keys(INCIDENT_MODEL_COLUMN) as IncidentModelKey[]).map((key) => {
      const raw = dayRow?.[INCIDENT_MODEL_COLUMN[key]];
      const dayPredicted = typeof raw === "number" ? raw : null;
      return {
        key,
        dayPredicted,
        isChampion: dayRow?.champion_model === key,
        // Rounded per hour so the bars and the curve are both whole incidents.
        // The rounded hours therefore need not sum exactly to dayPredicted —
        // the tile reports the model's own daily figure, not the sum of these.
        hours:
          dayPredicted != null && canShape
            ? profile.map((v) => Math.round((v / profileTotal) * dayPredicted))
            : Array<number | null>(24).fill(null),
      };
    });

    const dayActual = hours.reduce((s, h) => s + h.total, 0);

    const data = {
      date,
      weekday: new Date(`${date}T00:00:00`).toLocaleDateString("en-US", { weekday: "long" }),
      // Null when this date falls outside the walk-forward window entirely —
      // observed history before validation starts has actuals but no model row.
      predictionType: (dayRow?.prediction_type as "train" | "validation" | "future" | undefined) ?? null,
      isFuture: dayRow?.prediction_type === "future",
      championModel: dayRow?.champion_model ?? null,
      // "observed" — this day has its own logged hours, so the bars are real.
      // "weekday-profile" — no hours logged; only the derived curve is drawn.
      // null — neither, so no model curve can be shaped at all.
      profileSource: !canShape ? null : dayActual > 0 ? "observed" : "weekday-profile",
      dayActual,
      models,
      hours,
      sourceCoverage,
      // True only when at least one source table still covers this date. False
      // means every bar would be a zero-by-absence, which the UI labels rather
      // than plots.
      hasIncidentLog: Object.values(sourceCoverage).some((c) => c.covered),
      weather: {
        hoursRecorded: known.length,
        wetHours: wetHours.length,
        dryHours: dryHours.length,
        // Day total in mm: hourly expressway-averages summed across the day,
        // matching how the predictive endpoint derives its daily rainfall.
        totalRainfallMm: Number(known.reduce((s, h) => s + (h.rainfallMm ?? 0), 0).toFixed(2)),
        threshold: 0.3,
      },
      totals: {
        all: sum(hours),
        wet: sum(wetHours),
        dry: sum(dryHours),
        // Incidents in hours with no weather reading — reachable from neither
        // the Dry nor the Wet chip, so the UI can account for the difference
        // instead of leaving it silently missing.
        unknownWeather: sum(hours.filter((h) => h.isWet === null)),
      },
    };

    incidentCache.set(cacheKey, { at: Date.now(), data });
    return data;
  } catch (error) {
    console.error("Database query failed for incident hourly breakdown:", error);
    return null;
  }
}

// The operational incident feed lives in fact_incident_log (Waze Partner Hub,
// joined to dim_incident_type for the category/severity label). The flat
// incidents_table from the original schema exists but was never loaded, so the
// three endpoints below read the fact table and keep the original result keys.
//
// Note the scope difference: fact_incident_log holds the recent live feed,
// whereas the /analytics endpoint reports multi-year history from the
// nlex_road_crashes / nlex_motorcycle_crashes / nlex_stalled_vehicles tables.

/** Classifies each incident hour as wet/dry using expressway-average rainfall. */
const WX_CTE = `
  wx AS (
    SELECT (timestamp_utc + interval '8 hours')::date AS d,
           EXTRACT(hour FROM timestamp_utc + interval '8 hours')::int AS h,
           AVG(rainfall) > 0.3 AS wet
    FROM hourly_weather
    GROUP BY 1, 2
  )`;

// [DEV-01] Get Incident List
export async function getIncidentListFromDb(status: string) {
  if (!db) return null;
  try {
    let query = `
      SELECT f.incident_log_id AS incident_id,
             f.alert_type      AS type,
             COALESCE(NULLIF(d.severity_level, ''), f.subtype, f.alert_type) AS severity,
             f.street, f.city,
             f.report_description,
             f.reliability, f.confidence,
             f.is_active,
             f.mttc_minutes    AS clearance_time_mins,
             f.first_seen_at   AS reported_at,
             f.cleared_at,
             ST_X(f.geom::geometry) AS longitude,
             ST_Y(f.geom::geometry) AS latitude
      FROM fact_incident_log f
      LEFT JOIN dim_incident_type d ON d.incident_type_id = f.incident_type_id`;

    if (status === "active") query += ` WHERE f.cleared_at IS NULL`;
    if (status === "resolved") query += ` WHERE f.cleared_at IS NOT NULL`;
    query += ` ORDER BY f.first_seen_at DESC NULLS LAST LIMIT 500`;

    const { rows } = await db.query(query);
    return rows;
  } catch (error) {
    console.error("Database query failed for incidents:", error);
    return null;
  }
}

// [DEV-02] Get Incident Metrics (Rate, Severity, Clearance Time)
export async function getIncidentMetricsFromDb() {
  if (!db) return null;
  try {
    // total_incidents is the corpus-wide count so each row still carries the
    // overall total alongside its own severity bucket. It has to be
    // SUM(COUNT(*)) OVER () — a bare COUNT(*) OVER () evaluates after GROUP BY
    // and would count the severity buckets instead of the incidents.
    const { rows } = await db.query(`
      SELECT SUM(COUNT(*)) OVER ()::int                         AS total_incidents,
             ROUND(AVG(f.mttc_minutes)::numeric, 1)::float      AS avg_clearance_time,
             COALESCE(NULLIF(d.severity_level, ''), f.alert_type) AS severity,
             COUNT(*)::int                                      AS severity_count
      FROM fact_incident_log f
      LEFT JOIN dim_incident_type d ON d.incident_type_id = f.incident_type_id
      GROUP BY 3
      ORDER BY 4 DESC
    `);
    return rows;
  } catch (error) {
    console.error("Database query failed for incident metrics:", error);
    return null;
  }
}

// [DEV-03] Get Weather Correlation
export async function getWeatherCorrelationFromDb() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      WITH ${WX_CTE}
      SELECT CASE WHEN w.wet THEN 'Rainy' ELSE 'Clear' END AS weather_condition,
             COUNT(*)::int AS incident_count
      FROM fact_incident_log f
      JOIN wx w ON w.d = f.date_day AND w.h = f.hour_of_day
      GROUP BY 1 ORDER BY 2 DESC
    `);
    return rows;
  } catch (error) {
    console.error("Database query failed for weather correlation:", error);
    return null;
  }
}

// [ML-01] Get Predictive Incident Forecast from Database
//
// Three tables, written together by the incident forecasting pipeline
// (Back-End/incident_model_scripts/train_incident_models.py --write-db; the
// older run_predictive_pipeline.py is the single-model fallback), unqualified —
// they live in the default/public schema, not gold like the traffic ML tables:
//   ml_daily_actuals(d date, total float)                     — observed daily incident counts
//   ml_predictive_incidents(forecast_date date, prediction_type
//     'train'|'validation'|'future', predicted_incident_count float, champion_model text)
//   ml_training_metadata(metadata_json jsonb, created_at timestamptz) — most recent row wins
//
// An empty ml_training_metadata means the pipeline has never run, which we
// treat the same as "database not reachable" (null → 503 upstream).
//
// prediction_type semantics:
//   'validation' — walk-forward, out-of-sample. The ONLY rows accuracy metrics
//                  are computed from, and the only ones (with 'future') the
//                  daily forecast chart draws a model line across.
//   'future'     — beyond the last observed day. Selected by prediction_type
//                  alone so a Range-bounded WHERE can never trim the horizon.
//   'train'      — in-sample fitted values over the training period. Optional,
//                  and absent today. They exist so the hourly drill-down can
//                  still show model curves on a past day; they must never reach
//                  the scoring path, because a fitted value on a day the model
//                  trained on would flatter every metric. The validation-only
//                  filter that guards this is in buildIncidentModelMetrics.
//
// The window-resolution logic keys off 'validation' and 'future' explicitly
// rather than off "the earliest/latest row", so adding 'train' rows cannot move
// the Past/Present/Future band boundaries.
type DailyActualRow = { date: string; total: string | number };
// The seven candidates, in the order the dashboard lists them. Keys match
// MODEL_NAMES in incident_model_scripts/train_incident_models.py; columns match
// PRED_COLUMN there.
export const INCIDENT_MODELS = [
  { key: "XGBoost", column: "pred_xgboost" },
  { key: "RandomForest", column: "pred_randomforest" },
  { key: "LSTM", column: "pred_lstm" },
  { key: "GRU", column: "pred_gru" },
  { key: "Poisson_GLM", column: "pred_poisson_glm" },
  { key: "NegBinomial_GLM", column: "pred_negbinomial_glm" },
  { key: "SARIMAX", column: "pred_sarimax" },
] as const;

type PredictiveIncidentRow = {
  date: string;
  prediction_type: "train" | "validation" | "future";
  predicted_incident_count: string | number;
  champion_model: string | null;
  // Observed count on the same weekday one year earlier — the year-over-year
  // term the model leans on most. Kept for reference; not plotted.
  same_day_last_year: string | number | null;
  // Rain (mm) behind this date's forecast — hourly_weather actuals, or an
  // Open-Meteo forecast for future dates beyond its coverage. See
  // fetch_future_rain in train_incident_models.py.
  rainfall_mm: string | number | null;
} & Partial<Record<(typeof INCIDENT_MODELS)[number]["column"], string | number | null>>;

export type IncidentPredictiveFilters = {
  // Absent = keep the chart's original fixed context width (PAST_CONTEXT_DAYS).
  months?: "3" | "12" | "all";
  from?: string;
  to?: string;
  weather: IncidentWeather;
};

// The response shape is now the source of truth in incident.validator.ts
// (IncidentPredictiveResponseSchema) and this type is inferred from it, so the
// Zod schema and the TS type can't drift the way a hand-maintained duplicate
// eventually does.
import type { IncidentPredictiveResult } from "../validators/incident.validator.js";

// A day is wet when the expressway-wide average rainfall across its hours clears
// 0.3 mm — the same threshold getIncidentAnalyticsFromDb applies per hour, just
// aggregated to a day so it can align with the daily forecast series. is_wet is
// computed exactly as before: one AVG(rainfall) over every (station, hour) row
// for the date, unbucketed.
//
// rainfall_mm is a SEPARATE aggregation, added so the rainfall bars can cover
// history outside ml_predictive_incidents (whose rainfall_mm column only
// exists where a prediction row does — see rainfallMm below). Station rows
// are first averaged per hour (canceling the "~20 stations inflate a plain
// SUM" problem the is_wet comment above originally called out), then those 24
// hourly averages are summed to a daily total, which is the "how many mm fell
// today" figure a rainfall axis actually means — an AVG across the whole day
// would report a rate, not a depth.
//
// Bounded by date rather than scanning the whole table — the lower bound is
// widened to cover whichever is earlier, the resolved Range or the full
// validation window, since this lookup backs both the chart's daily rows and
// the Range-independent holdout join used by weatherMetrics.
const DAILY_WET_SQL = `
  WITH hourly AS (
    SELECT (timestamp_utc + interval '8 hours')::date AS d,
           EXTRACT(hour FROM timestamp_utc + interval '8 hours')::int AS h,
           AVG(rainfall) AS avg_rain
    FROM hourly_weather
    WHERE (timestamp_utc + interval '8 hours')::date >= $1::date
      AND (timestamp_utc + interval '8 hours')::date <= $2::date
    GROUP BY 1, 2
  )
  SELECT d::text AS date,
         (AVG(avg_rain) > 0.3) AS is_wet,
         SUM(avg_rain) AS rainfall_mm
  FROM hourly
  GROUP BY d
`;

const MONTHS_TO_CONTEXT_DAYS: Record<"3" | "12", number> = { "3": 90, "12": 365 };

// Fallback context width when no Range is supplied, matched to the traffic
// walk-forward chart (Past 40 / Present 10 / Future 15) so the two forecasts read
// as one family. Shipping all ~6.5 years of actuals made the response ~170 KB and
// squeezed 2,400 points into one line, which hid the validation and forecast
// windows entirely — which is why "All" is still capped below.
const PAST_CONTEXT_DAYS = 40;

// Ceiling on the "All" range. 2,400 daily points in one line is unreadable and
// pushes the payload past ~170 KB; three years keeps every annual cycle the
// model's yoy features lean on while staying legible.
const MAX_CONTEXT_DAYS = 1095;

const DEFAULT_PREDICTIVE_FILTERS: IncidentPredictiveFilters = { weather: "all" };

// Minimum scored rows for R² to be reported. Below this a single unusual day
// swings R² wildly — on a narrow custom range, or the ~23-day wet-weather
// slice the original comment on weatherMetrics called out, it reads as more
// precise than it actually is.
const MIN_R2_SAMPLE_SIZE = 30;

export type IncidentPredictiveAnchors = {
  // Earliest date the pipeline holds a validation-type prediction for.
  validationStart: string | null;
  // First date of the forecast horizon (prediction_type = 'future').
  futureStart: string | null;
  // Earliest observed date across all of ml_daily_actuals.
  minActualDate: string;
  // Latest date anywhere in ml_predictive_incidents — this includes the
  // forecast horizon, not just observed history, so dataBounds.maxDate lets
  // the custom-range picker reach into the Future band rather than stopping
  // at "today".
  maxForecastDate: string;
  // Seasonal-naive (m=7) MAE over the FULL ml_daily_actuals series, computed
  // once per request. MASE divides every window's MAE by this fixed number —
  // if the denominator shrank along with the window, "MASE improved" would
  // partly be an artifact of a smaller window rather than a better model.
  seasonalNaiveMae: number | null;
};

/**
 * Full-series aggregates needed before any window can be resolved: the
 * validation/future split dates, the earliest and latest data points, and the
 * fixed MASE denominator. Fetched once and handed to both the request-scoped
 * Zod schema (to refine from/to against real bounds) and
 * getIncidentPredictiveFromDb (to resolve the historical window) — never
 * queried twice for the same request.
 */
export async function getIncidentPredictiveAnchors(): Promise<IncidentPredictiveAnchors | null> {
  if (!db) return null;
  try {
    const { rows } = await db.query<{
      validation_start: string | null;
      future_start: string | null;
      max_forecast_date: string | null;
      min_actual_date: string | null;
      seasonal_naive_mae: string | number | null;
    }>(`
      WITH pred_anchors AS (
        SELECT
          MIN(forecast_date) FILTER (WHERE prediction_type = 'validation')::text AS validation_start,
          MIN(forecast_date) FILTER (WHERE prediction_type = 'future')::text AS future_start,
          MAX(forecast_date)::text AS max_forecast_date
        FROM ml_predictive_incidents
      ),
      actual_bounds AS (
        SELECT MIN(d)::text AS min_actual_date FROM ml_daily_actuals
      ),
      seasonal AS (
        SELECT AVG(ABS(total - lag_total)) AS seasonal_naive_mae
        FROM (
          SELECT total, LAG(total, 7) OVER (ORDER BY d) AS lag_total FROM ml_daily_actuals
        ) t
        WHERE lag_total IS NOT NULL
      )
      SELECT pred_anchors.validation_start, pred_anchors.future_start, pred_anchors.max_forecast_date,
             actual_bounds.min_actual_date, seasonal.seasonal_naive_mae
      FROM pred_anchors, actual_bounds, seasonal
    `);
    const r = rows[0];
    if (!r || !r.min_actual_date || !r.max_forecast_date) return null;
    return {
      validationStart: r.validation_start,
      futureStart: r.future_start,
      minActualDate: r.min_actual_date,
      maxForecastDate: r.max_forecast_date,
      seasonalNaiveMae: r.seasonal_naive_mae != null ? Number(r.seasonal_naive_mae) : null,
    };
  } catch (error) {
    console.error("Failed to fetch ML incident forecast anchors:", error);
    return null;
  }
}

// Range → concrete SQL bounds for the historical/validation portion of the
// series. The only place months/from/to get turned into dates — the query
// layer below is its one caller, so there is a single spot this can drift.
// Future rows never pass through here: the query selects them by
// prediction_type alone, so a narrow Range can shrink the Past but cannot
// structurally touch the Future band.
//
// Anchored at maxForecastDate (the far edge of the series, which already
// includes the forecast horizon) — the exact same reference point Traffic's
// own window resolution uses (`forecast_date >= MAX(forecast_date) - N
// months` in getMLPredictiveVolume). "N months" is N months of TOTAL axis
// width ending at that far edge, not N months of pure history with the
// horizon added on top. Anchoring at validationStart instead (this
// function's previous behavior) silently added the ~90-day holdout window on
// top of every Range, which is what made "3 mo" render as ~6 months of axis
// and "12 mo" as ~15.
export function resolveIncidentHistoricalWindow(
  filters: Pick<IncidentPredictiveFilters, "months" | "from" | "to">,
  anchors: Pick<IncidentPredictiveAnchors, "maxForecastDate">
): { historicalStart: string; historicalEnd: string | null } {
  const contextDays =
    filters.months === undefined
      ? PAST_CONTEXT_DAYS
      : filters.months === "all"
        ? MAX_CONTEXT_DAYS
        : MONTHS_TO_CONTEXT_DAYS[filters.months] ?? PAST_CONTEXT_DAYS;

  const historicalStart = filters.from ?? subtractDays(anchors.maxForecastDate, contextDays);
  // null = no upper trim. Future rows are fetched unconditionally regardless
  // of this value, so the old "only honour `to` if it falls past the forecast
  // bands" special case no longer needs encoding here — it's structurally
  // impossible for `to` to hide the Future band now.
  const historicalEnd = filters.to ?? null;
  return { historicalStart, historicalEnd };
}

function subtractDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

type AlignedValidationRow = {
  date: string;
  actual: number;
  isWet: boolean | null;
  models: Record<string, number | null>;
};

type ComputedModelMetrics = {
  mae: number | null;
  rmse: number | null;
  wmape: number | null;
  mase: number | null;
  r2: number | null;
  n: number;
};

/**
 * Single source of truth for every LIVE accuracy number this endpoint
 * reports (as opposed to the pipeline's own offline numbers carried in
 * ml_training_metadata). Both the main comparison table and the wet/dry-only
 * panel call this — one over the Range+Weather-scoped rows, the other over
 * the Range-independent full holdout — so the arithmetic can't drift between
 * the two call sites the way two independently-maintained blocks eventually do.
 */
function computeModelMetricsForModel(
  rows: AlignedValidationRow[],
  modelKey: string,
  seasonalNaiveMae: number | null
): ComputedModelMetrics {
  const pairs = rows
    .map((r) => ({ actual: r.actual, predicted: r.models[modelKey] }))
    .filter((p): p is { actual: number; predicted: number } => p.predicted != null);

  const n = pairs.length;
  if (n === 0) return { mae: null, rmse: null, wmape: null, mase: null, r2: null, n: 0 };

  const absErr = pairs.reduce((s, p) => s + Math.abs(p.actual - p.predicted), 0);
  const sqErr = pairs.reduce((s, p) => s + (p.actual - p.predicted) ** 2, 0);
  const sumActual = pairs.reduce((s, p) => s + p.actual, 0);
  const mean = sumActual / n;
  const ssTot = pairs.reduce((s, p) => s + (p.actual - mean) ** 2, 0);
  const mae = absErr / n;

  return {
    mae,
    rmse: Math.sqrt(sqErr / n),
    wmape: sumActual > 0 ? (absErr / sumActual) * 100 : null,
    mase: seasonalNaiveMae != null && seasonalNaiveMae > 0 ? mae / seasonalNaiveMae : null,
    // Guarded rather than left to swing on a handful of days — see
    // MIN_R2_SAMPLE_SIZE.
    r2: n < MIN_R2_SAMPLE_SIZE ? null : ssTot > 0 ? 1 - sqErr / ssTot : null,
    n,
  };
}

// Joins one predictions result set onto its actuals/wet lookups and keeps
// only validation-type rows with a known ground truth — there's nothing to
// score a future row or an unobserved day against.
function toAlignedValidationRows(
  rows: PredictiveIncidentRow[],
  actualByDate: Map<string, number>,
  wetByDate: Map<string, boolean>,
  availableModels: readonly (typeof INCIDENT_MODELS)[number][]
): AlignedValidationRow[] {
  return rows
    .filter((p) => p.prediction_type === "validation" && actualByDate.has(p.date))
    .map((p) => ({
      date: p.date,
      actual: actualByDate.get(p.date)!,
      isWet: wetByDate.get(p.date) ?? null,
      models: Object.fromEntries(
        availableModels.map((m) => [m.key, p[m.column] != null ? Number(p[m.column]) : null])
      ),
    }));
}

export function buildIncidentPredictiveResponse(
  actuals: DailyActualRow[],
  predictions: PredictiveIncidentRow[],
  metadata: Record<string, unknown>,
  trainedAt: string | Date | null,
  filters: IncidentPredictiveFilters,
  wetByDate: Map<string, boolean>,
  // Daily rainfall (mm) derived from hourly_weather, covering the full
  // resolved window — falls back for dates outside ml_predictive_incidents'
  // own rainfall_mm coverage. See the doc comment on DAILY_WET_SQL.
  rainByDate: Map<string, number>,
  anchors: IncidentPredictiveAnchors,
  // The resolved Past-band start (echoed back as windowBounds.windowStart)
  // so the chart can position its markAreas from the same value the query
  // was actually bounded by, rather than re-deriving it from row indices.
  historicalStart: string,
  // Range-independent: every stored validation row / its matching actuals,
  // regardless of the resolved historical window. `predictions` above is
  // Range-bounded (per resolveIncidentHistoricalWindow) so it can't be reused
  // here without narrowing weatherMetrics' sample along with the chart — see
  // the doc comment on weatherMetrics below for why that would be wrong.
  holdoutActuals: DailyActualRow[],
  holdoutPredictions: PredictiveIncidentRow[]
): IncidentPredictiveResult {
  const actualByDate = new Map(actuals.map((r) => [r.date, Number(r.total)]));
  const predByDate = new Map(predictions.map((r) => [r.date, r]));
  const allDates = Array.from(new Set([...actualByDate.keys(), ...predByDate.keys()])).sort();

  // Only offer models the pipeline actually stored predictions for — checked
  // against both row sets so a model with predictions only outside the
  // Range-bounded window (e.g. an older holdout run) doesn't silently drop
  // out of the chip toolbar just because the current Range excludes them.
  const availableModels = INCIDENT_MODELS.filter(
    (m) => predictions.some((p) => p[m.column] != null) || holdoutPredictions.some((p) => p[m.column] != null)
  );

  const fullDaily = allDates.map((date) => {
    const pred = predByDate.get(date);
    const models: Record<string, number | null> = {};
    for (const m of availableModels) {
      const v = pred?.[m.column];
      models[m.key] = v != null ? Number(v) : null;
    }
    return {
      date,
      actual: actualByDate.has(date) ? actualByDate.get(date)! : null,
      predicted: pred ? Number(pred.predicted_incident_count) : null,
      predictionType: pred?.prediction_type ?? null,
      sameDayLastYear:
        pred?.same_day_last_year != null ? Number(pred.same_day_last_year) : null,
      // The hourly_weather-derived figure (DAILY_WET_SQL) is authoritative here,
      // NOT ml_predictive_incidents.rainfall_mm.
      //
      // That column is inflated by exactly the station count: the pipeline sums
      // every (station, hour) row for the day instead of averaging the ~20
      // stations per hour first, so it reports a 41 mm day as 816 mm. Measured
      // across the walk-forward window the ratio is 20.0 for future rows and
      // 19.74 for validation rows — i.e. the station count, not a unit change.
      //
      // Preferring it produced a rainfall series on two incompatible scales in
      // one chart: Past days (which only ever had the hourly_weather value) drew
      // in real mm, while Present/Future drew 20x larger. The axis then scaled
      // to the inflated maximum and every ordinary day flattened to a sliver.
      //
      // Falling back to the raw column would reintroduce that 20x error, so a
      // day with no hourly_weather coverage reports null and simply draws no
      // bar. hourly_weather currently runs to 2026-08-12, past the end of the
      // forecast horizon, so nothing is lost today.
      rainfallMm: rainByDate.get(date) ?? null,
      isWet: wetByDate.has(date) ? wetByDate.get(date)! : null,
      models,
    };
  });

  // `actuals` and `predictions` are already Range-bounded by the caller's SQL
  // (resolveIncidentHistoricalWindow + a parameterized WHERE clause) — Future
  // rows arrive unconditionally in the same query, selected by prediction_type
  // rather than date. Present is the full validation window here, matching
  // Traffic's own walk-forward chart (no equivalent of a "last 10 days only"
  // truncation exists there) — a prior version of this function nulled out
  // predictions on all but the most recent slice of validation rows, which
  // silently shrank the Present band and was the source of a visual mismatch
  // against Traffic. There is nothing left to slice by index here.
  const daily = fullDaily;

  const futurePreds = predictions.filter((p) => p.prediction_type === "future");
  const totalPredictedNext7Days = futurePreds.reduce((sum, p) => sum + Number(p.predicted_incident_count), 0);
  const peak = futurePreds.reduce<PredictiveIncidentRow | null>(
    (best, p) => (!best || Number(p.predicted_incident_count) > Number(best.predicted_incident_count) ? p : best),
    null
  );
  const championModel = predictions.find((p) => p.champion_model)?.champion_model ?? (metadata.champion_model as string | undefined) ?? null;

  // The pipeline's own comparison table — now used only as a fallback for a
  // model whose Range+Weather slice has zero scored rows (e.g. a 3-month
  // window with weather=wet and no wet days in it). `selectedBy` still governs
  // the fallback path's own internal ranking-by-criterion; the row order below
  // is decided after both live and fallback rows are in one array.
  const selectedBy = (metadata.evaluation as { selected_by?: string } | undefined)?.selected_by;
  const rawComparison = (metadata.model_comparison as Record<string, unknown>[] | undefined) ?? [];
  const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  // Live rows: computed here, over the SAME rows the chart just drew (Range
  // via the caller's SQL, Weather via this filter) — so composing the two
  // filters and re-reading the metrics table shows the number that matches
  // what's on screen, not a number from a different slice of history.
  const rangeAligned = toAlignedValidationRows(predictions, actualByDate, wetByDate, availableModels);
  const weatherFilteredRangeAligned =
    filters.weather === "all" ? rangeAligned : rangeAligned.filter((r) => r.isWet === (filters.weather === "wet"));

  // Describes the row set every "window"-sourced model was actually scored
  // against, for the metrics card's caption — not a per-model n (which can
  // differ slightly between models with different null patterns), but the
  // scoring opportunity common to all of them. toAlignedValidationRows
  // preserves `predictions`' ORDER BY forecast_date ASC, so first/last here
  // are genuinely the earliest/latest scored dates, not an arbitrary pick.
  // Null exactly when every model in modelMetrics will show source:"holdout"
  // — there's nothing here to have scored them against.
  const scoringWindow =
    weatherFilteredRangeAligned.length > 0
      ? {
          start: weatherFilteredRangeAligned[0].date,
          end: weatherFilteredRangeAligned[weatherFilteredRangeAligned.length - 1].date,
          n: weatherFilteredRangeAligned.length,
        }
      : null;

  const modelMetrics = availableModels
    .map((m) => {
      const computed = computeModelMetricsForModel(weatherFilteredRangeAligned, m.key, anchors.seasonalNaiveMae);
      const isChampion = m.key === championModel;

      if (computed.n > 0) {
        return {
          model: m.key as string,
          MAE: computed.mae,
          RMSE: computed.rmse,
          WMAPE: computed.wmape,
          MASE: computed.mase,
          R2: computed.r2,
          // These three are training-time diagnostics (train/test gap etc.)
          // with no live-recompute equivalent over an arbitrary window — left
          // null on a live row rather than fabricated.
          Adjusted_R2: null,
          Train_R2: null,
          Gap: null,
          Diagnosis: null,
          isChampion,
          source: "window" as const,
          n: computed.n,
        };
      }

      // No scored rows survive this Range/Weather slice — fall back to the
      // pipeline's full-holdout numbers instead of showing an empty row.
      const fallback = rawComparison.find((r) => String(r.model) === m.key);
      return {
        model: m.key as string,
        MAE: numOrNull(fallback?.MAE),
        RMSE: numOrNull(fallback?.RMSE),
        WMAPE: numOrNull(fallback?.WMAPE),
        MASE: numOrNull(fallback?.MASE),
        R2: numOrNull(fallback?.R2),
        Adjusted_R2: numOrNull(fallback?.Adjusted_R2),
        Train_R2: numOrNull(fallback?.Train_R2),
        Gap: numOrNull(fallback?.Gap),
        Diagnosis: typeof fallback?.Diagnosis === "string" ? fallback.Diagnosis : null,
        isChampion,
        source: "holdout" as const,
        n: 0,
      };
    })
    .sort((a, b) =>
      selectedBy === "mae" ? (a.MAE ?? Infinity) - (b.MAE ?? Infinity) : (b.R2 ?? -Infinity) - (a.R2 ?? -Infinity)
    );

  // Weather split, scored over the FULL validation window regardless of Range
  // — unchanged behavior from before this endpoint became Range-aware. The
  // answer to "does the forecast hold up in the rain?" needs every scored day
  // it can get (there are only ~23 wet ones per the original measurement), so
  // this deliberately does NOT reuse the Range-bounded `predictions` above;
  // holdoutPredictions/holdoutActuals carry the full holdout independent of
  // whatever the user picked in the Range control.
  const holdoutActualByDate = new Map(holdoutActuals.map((r) => [r.date, Number(r.total)]));
  const holdoutAligned = toAlignedValidationRows(holdoutPredictions, holdoutActualByDate, wetByDate, availableModels);

  const weatherMetrics =
    filters.weather === "all"
      ? null
      : (() => {
          const wantWet = filters.weather === "wet";
          const rows = holdoutAligned.filter((r) => r.isWet === wantWet);
          if (rows.length === 0) return { weather: filters.weather, days: 0, models: [] };

          const models = availableModels
            .map((m) => {
              const computed = computeModelMetricsForModel(rows, m.key, null);
              if (computed.n === 0) return null;
              return {
                model: m.key as string,
                MAE: computed.mae as number,
                RMSE: computed.rmse as number,
                R2: computed.r2,
                isChampion: m.key === championModel,
              };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null)
            .sort((a, b) => a.MAE - b.MAE);
          return { weather: filters.weather, days: rows.length, models };
        })();

  return {
    summary: {
      totalPredictedNext7Days: Math.round(totalPredictedNext7Days),
      peakRiskDate: peak?.date ?? null,
      championModel,
    },
    daily,
    modelMetrics,
    featureImportance: (metadata.feature_importance as { feature: string; importance: number }[] | undefined) ?? [],
    modelInfo: {
      championModel,
      forecastHorizon: futurePreds.length,
      trainedAt: trainedAt ? new Date(trainedAt).toISOString() : null,
      metrics: (metadata.metrics as Record<string, unknown> | undefined) ?? null,
      scoredDays:
        (metadata.evaluation as { holdout_days?: number } | undefined)?.holdout_days ?? null,
    },
    weatherMetrics,
    scoringWindow,
    // Whether the Weather control means anything for the current Range: with
    // zero scored rows (scoringWindow === null) every model has already
    // fallen back to its full-holdout numbers, and those numbers don't carry
    // a weather dimension — clicking Dry/Wet would refetch and get back the
    // exact same holdout row every time. Lets the UI disable the chips
    // instead of letting them look live while doing nothing.
    weatherApplicable: scoringWindow !== null,
    dataBounds: {
      minDate: anchors.minActualDate,
      maxDate: anchors.maxForecastDate,
    },
    // The resolved band boundaries, so the chart positions markAreas from
    // these values directly instead of re-deriving them by scanning `daily`
    // for a predictionType change — the boundaries below are dates (always
    // unique), while the chart's x-axis display labels drop the year, which
    // makes them ambiguous as markArea coordinates once a window spans more
    // than 12 months.
    //   Past    = windowStart     -> validationStart
    //   Present = validationStart -> futureStart
    //   Future  = futureStart     -> windowEnd
    windowBounds: {
      windowStart: historicalStart,
      validationStart: anchors.validationStart,
      futureStart: anchors.futureStart,
      windowEnd: anchors.maxForecastDate,
    },
    appliedFilters: {
      months: filters.months ?? null,
      weather: filters.weather,
      contextFrom: daily[0]?.date ?? null,
      contextTo: daily[daily.length - 1]?.date ?? null,
    },
  };
}

const INCIDENT_MODEL_COLUMNS_SQL = INCIDENT_MODELS.map((m) => m.column).join(", ");

export async function getIncidentPredictiveFromDb(
  filters: IncidentPredictiveFilters = DEFAULT_PREDICTIVE_FILTERS,
  anchors: IncidentPredictiveAnchors
): Promise<IncidentPredictiveResult | null> {
  if (!db) return null;
  try {
    const metaRes = await db.query(
      `SELECT metadata_json, created_at FROM ml_training_metadata ORDER BY created_at DESC LIMIT 1`
    );
    if (metaRes.rows.length === 0) return null;

    const { historicalStart, historicalEnd } = resolveIncidentHistoricalWindow(filters, anchors);

    // A months preset ("3"/"12"/"all") scopes how much HISTORY is drawn — the
    // Range control is answering "how far back", not "should the forecast
    // still be there", so the Future band is preserved unconditionally. An
    // explicit custom from/to is a different question: the user drew a
    // literal window, and Traffic's own custom-range query
    // (getMLPredictiveVolume, `WHERE forecast_date BETWEEN $1 AND $2`) honors
    // it literally, including for the forecast rows. Matching that: a custom
    // range that ends before the forecast horizon begins simply won't have a
    // Future band, the same way it wouldn't on Traffic.
    //
    // Mirrors Traffic's own condition for switching into custom-range mode
    // (`if (window.from && window.to)`) rather than months-being-absent —
    // this component's frontend always sends months alongside from/to
    // (months="all"), so "did the caller ask for a custom range" has to be
    // read off from/to's presence, not months'.
    const isCustomRange = Boolean(filters.from && filters.to);

    // wetRes's lower bound is widened to also cover the full validation window
    // (not just the resolved Range) — it feeds both fullDaily (Range-scoped)
    // and the holdout join used by weatherMetrics (Range-independent), and a
    // lookup Map costs nothing extra to have a few weeks' worth of unused keys.
    const wetLowerBound =
      anchors.validationStart && anchors.validationStart < historicalStart
        ? anchors.validationStart
        : historicalStart;

    const [actualsRes, predsRes, wetRes, holdoutActualsRes, holdoutPredsRes] = await Promise.all([
      // Range-bounded: this is what the chart draws. Pushed into SQL rather
      // than fetched whole and sliced in JS, so a narrow Range is a smaller
      // result set, not just a smaller rendered array.
      db.query<DailyActualRow>(
        `SELECT d::text AS date, total FROM ml_daily_actuals
         WHERE d >= $1::date AND ($2::date IS NULL OR d <= $2::date)
         ORDER BY d ASC`,
        [historicalStart, historicalEnd]
      ),
      // isCustomRange: literal BETWEEN, forecast rows included, matching
      // Traffic exactly — a custom range that ends before the forecast
      // horizon starts legitimately has no Future band.
      // preset: same Range bound as actuals, OR'd with an unconditional
      // prediction_type = 'future' — this is the only branch where "never
      // trim the Future band" is enforced.
      isCustomRange
        ? db.query<PredictiveIncidentRow>(
            `SELECT forecast_date::text AS date, prediction_type, predicted_incident_count, champion_model,
                    same_day_last_year, rainfall_mm, ${INCIDENT_MODEL_COLUMNS_SQL}
             FROM ml_predictive_incidents
             WHERE forecast_date BETWEEN $1::date AND $2::date
             ORDER BY forecast_date ASC`,
            [historicalStart, historicalEnd]
          )
        : db.query<PredictiveIncidentRow>(
            `SELECT forecast_date::text AS date, prediction_type, predicted_incident_count, champion_model,
                    same_day_last_year, rainfall_mm, ${INCIDENT_MODEL_COLUMNS_SQL}
             FROM ml_predictive_incidents
             WHERE prediction_type = 'future'
                OR (forecast_date >= $1::date AND ($2::date IS NULL OR forecast_date <= $2::date))
             ORDER BY forecast_date ASC`,
            [historicalStart, historicalEnd]
          ),
      db.query<{ date: string; is_wet: boolean; rainfall_mm: string | number | null }>(DAILY_WET_SQL, [
        wetLowerBound,
        anchors.maxForecastDate,
      ]),
      // Full holdout, independent of Range — see the doc comment on
      // weatherMetrics in buildIncidentPredictiveResponse for why.
      anchors.validationStart
        ? db.query<DailyActualRow>(
            `SELECT d::text AS date, total FROM ml_daily_actuals
             WHERE d >= $1::date AND d < $2::date
             ORDER BY d ASC`,
            [anchors.validationStart, anchors.futureStart ?? anchors.maxForecastDate]
          )
        : Promise.resolve({ rows: [] as DailyActualRow[] }),
      db.query<PredictiveIncidentRow>(
        `SELECT forecast_date::text AS date, prediction_type, predicted_incident_count, champion_model,
                same_day_last_year, rainfall_mm, ${INCIDENT_MODEL_COLUMNS_SQL}
         FROM ml_predictive_incidents
         WHERE prediction_type = 'validation'
         ORDER BY forecast_date ASC`
      ),
    ]);

    const wetByDate = new Map(wetRes.rows.map((r) => [r.date, r.is_wet]));
    const rainByDate = new Map(
      wetRes.rows
        .filter((r) => r.rainfall_mm != null)
        .map((r) => [r.date, Number(r.rainfall_mm)])
    );
    return buildIncidentPredictiveResponse(
      actualsRes.rows,
      predsRes.rows,
      metaRes.rows[0].metadata_json ?? {},
      metaRes.rows[0].created_at,
      filters,
      wetByDate,
      rainByDate,
      anchors,
      historicalStart,
      holdoutActualsRes.rows,
      holdoutPredsRes.rows
    );
  } catch (error) {
    console.error("Failed to fetch ML incident forecast:", error);
    return null;
  }
}
