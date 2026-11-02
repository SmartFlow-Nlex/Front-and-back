import { db } from "../config/db.js";
import { exitKmValuesSql, kmKeySql } from "../lib/km-post.js";
import { getMLPredictiveCongestion } from "./traffic.service.js";

/* ══════════════════════════════════════════════════════════════════════════════
   PRESCRIPTIVE TRAFFIC: staffing priority and congestion response

   Redesigned 2 Nov 2026 so that every recommendation rests on measured data,
   with no operator-set constants ("I really dont want any assumptions across
   the prescriptive analytics"). The previous version planned booths from an
   OpenStreetMap booth count and a 350 vehicles-a-booth-hour slider, and ranked
   congestion with hand-set fuzzy memberships; none of those were measured.
   The pre-redesign files are in SmartFlow_backups/prescriptive_before_redesign_2026-11-02.

   STAFFING PRIORITY BY FORECAST DEMAND

     forecast(plaza, hour, day) = corridorForecast(day)
                                x plazaShare(plaza) x hourShare(plaza, hour, weekday|weekend)

     corridorForecast   gold.ml_predictive_volume, the champion's future rows
     shares             gold.fact_traffic_hourly, the latest 12 months on record

   Each plaza-hour is compared with that plaza's OWN usual level for the same
   hour and day type over the same 12 months: the median day (usual) and the
   90th-percentile day (usual peak, exceeded on 1 comparable day in 10). The
   recommendation is relative, so it needs no booth count or throughput: a
   plaza-hour forecast above its usual peak needs more than the plaza usually
   staffs at that hour.

   How sure is measured, not assumed. The whole chain above (champion forecast
   x shares) is replayed on the champion's held-out days, and the ratio
   actual / predicted is collected per plaza, plaza-hours of 200 vehicles or
   more. Its quantiles give
     - an 80% band:  forecast x [q10, q90]
     - the chance the actual exceeds the usual peak: 1 - F(usualPeak / forecast)
   On 2 Nov 2026 that chain's held-out WMAPE was about 17% per plaza-hour,
   against 6.49% for the corridor-day forecast alone: splitting the corridor
   into plaza-hours is most of the error, so the corridor figure would have
   overstated the certainty about 2.6 times.

     above   chance >= 90%: even the band's low end exceeds the usual peak
     likely  chance >= 50%
     normal  otherwise

   CONGESTION RESPONSE

   The congestion forecast's chance of High (p_high, hours 1-12) is compared
   with one cut-off. The cut-off is not chosen by hand: every archived forecast
   (gold.ml_congestion_forecast_log) is joined to what the road then did
   (gold.v_congestion_forecast_score, Waze jam speed per exit-hour), the cut-off
   that maximises F1 is picked on all but the last 7 days, and its precision and
   recall are reported on those last 7 days, which it never saw. A segment at or
   above it within 12 hours is Act; the rest Monitor. No separate Prepare tier:
   no higher cut-off in the archive buys a precision worth a second action (it
   tops out near 40% while recall falls below 10%). With too few scored
   forecasts the panel says so and labels nothing.
══════════════════════════════════════════════════════════════════════════════ */

/** How many future days the week-ahead view covers. */
const WEEK_DAYS = 7;
/** The usual level is measured over this many days back from the last day on record. */
const WINDOW_DAYS = 365;
/** Usual peak: the day-of-type percentile exceeded on 1 comparable day in 10. */
const USUAL_PEAK_PCT = 0.9;
/** The backtest measures error only on plaza-hours this busy; below it no chance is claimed. */
const MIN_CELL = 200;
/** Chance at or above which the band's low end exceeds the usual peak. */
const CERTAIN = 0.9;
const LIKELY = 0.5;
/** Quantile levels kept from the backtest: 0.01 .. 0.99. */
const LEVELS = Array.from({ length: 99 }, (_, i) => (i + 1) / 100);

const MODEL_COLUMN: Record<string, string> = {
  Prophet: "pred_prophet",
  Prophet_nw: "pred_prophet_nw",
  LSTM: "pred_lstm",
  LSTM_nw: "pred_lstm_nw",
  XGBoost: "pred_xgboost",
  HoltWinters: "pred_holtwinters",
  SARIMAX: "pred_sarimax",
  SARIMAX_nw: "pred_sarimax_nw",
  Holts_Linear: "pred_holts_linear",
  HoltsLinear: "pred_holts_linear",
};

export type StaffingLevel = "above" | "likely" | "normal";

export type StaffingHour = {
  hour: number;
  /** Vehicles forecast at this plaza in this hour. */
  forecast: number;
  /** 80% band from the measured held-out error; null where none is measured. */
  low: number | null;
  high: number | null;
  /** The plaza's median for this hour and day type over the latest 12 months. */
  usual: number | null;
  /** ...and its 90th percentile: exceeded on 1 comparable day in 10. */
  usualPeak: number | null;
  /** forecast / usual. 1 = a usual day. */
  load: number | null;
  /** Measured chance the actual exceeds the usual peak; null below MIN_CELL or with no band. */
  chance: number | null;
  level: StaffingLevel;
};

export type StaffingPlazaDay = {
  plaza: string;
  sharePct: number;
  /** The hour with the most vehicles forecast. */
  peakHour: number;
  /** The hour most likely to exceed its usual peak (then the highest load). */
  top: StaffingHour | null;
  aboveHours: number;
  likelyHours: number;
  /** All 24 hours on the first day only; empty on the others. */
  hours: StaffingHour[];
};

export type StaffingDay = {
  date: string;
  dayType: "weekday" | "weekend";
  corridorForecast: number;
  aboveCells: number;
  likelyCells: number;
  plazas: StaffingPlazaDay[];
};

/** One plaza-hour of the week forecast above its usual peak, most certain first. */
export type StaffingPriority = StaffingHour & { date: string; dayType: "weekday" | "weekend"; plaza: string };

export type CongestionAdvice = {
  segment: string;
  km: number | null;
  /** The highest chance of High in hours 1-12 (the forecast's p_high). */
  probability: number;
  /** The hour of that highest chance. */
  hoursAhead: number;
  /** The first hour at or above the calibrated cut-off; null when none is. */
  firstAct: number | null;
  label: "Act" | "Monitor";
  action: string;
  /** Of archived forecasts at or above this probability, the share that High followed, and how many there were. */
  hitRate: number | null;
  hitN: number;
};

export type CongestionCalibration = {
  ok: boolean;
  /** Why no cut-off is given, when ok is false. */
  reason: string | null;
  /** The p_high cut-off, picked by F1 on the fit period. */
  threshold: number | null;
  /** Measured on the last 7 days, which the cut-off never saw. */
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** Share of held-out forecast-hours that were High at all: what precision compares with. */
  baseRate: number | null;
  fitF1: number | null;
  scored: number;
  scoredHigh: number;
  runs: number;
  fitFrom: string | null;
  fitTo: string | null;
  testFrom: string | null;
  testTo: string | null;
  testRows: number;
};

export type TrafficPrescriptive = {
  champion: { model: string | null; wmapePct: number | null; accepted: boolean };
  basis: {
    /** The 12 months the shares and usual levels are measured over. */
    usualFrom: string | null;
    usualTo: string | null;
    usualWeekdays: number;
    usualWeekends: number;
    usualPeakPercentile: number;
    plazasProfiled: number;
    forecastFrom: string | null;
    forecastTo: string | null;
    /** The held-out replay the band and chances come from; null when it could not be measured. */
    band: { from: string; to: string; days: number; cells: number; wmapePct: number } | null;
    minCellVehicles: number;
  };
  /** Hour by hour for the first forecast day. */
  shiftPlan: StaffingDay | null;
  week: StaffingDay[];
  /** The week's plaza-hours most likely to exceed their usual peak (above or likely), most certain first. */
  priorities: StaffingPriority[];
  /** Plazas with traffic but no measured error band (too few held-out plaza-hours). */
  plazasWithoutBand: string[];
  congestion: CongestionAdvice[];
  congestionCalibration: CongestionCalibration | null;
  /** Segments on the exit list with no congestion forecast at all. They are
   *  named, not dropped: an empty row and a quiet road look the same. */
  congestionMissing: string[];
  /** True when the congestion forecast could not be READ (connection or query failure), as opposed
   *  to read and empty. The panel retries on either, but only this one is an error worth saying. */
  congestionUnavailable: boolean;
  /** The Manila wall-clock hour the congestion forecast counts from ("YYYY-MM-DD HH:MM"), so
   *  "+2h" can be said as a clock time. Null when there are no rows. */
  congestionBaseTs: string | null;
  /** Each segment's chance of High congestion for hours 1-12, for the advisory's timelines. */
  congestionTimeline: { segment: string; hours: { h: number; pHigh: number }[] }[];
};

/* ── the measured decision rules ─────────────────────────────────────────── */

/** The value at quantile `level` of an ascending quantile list at LEVELS. */
function quantileAt(q: number[], level: number): number {
  const i = Math.round(level * 100) - 1;
  return q[Math.max(0, Math.min(q.length - 1, i))];
}

/** P(ratio > x) from ascending quantiles at levels 0.01..0.99, linear between them;
 *  clamped to 1%..99%, the resolution the quantiles carry. */
function exceedChance(q: number[], x: number): number {
  const n = q.length;
  if (!(n > 0) || !Number.isFinite(x)) return 0;
  if (x <= q[0]) return 1 - 1 / (n + 1);
  if (x >= q[n - 1]) return 1 / (n + 1);
  let i = 0;
  while (i < n - 2 && q[i + 1] <= x) i++;
  const span = q[i + 1] - q[i];
  const f = (i + 1 + (span > 0 ? (x - q[i]) / span : 1)) / (n + 1);
  return 1 - f;
}

/** One plaza-hour against its usual level. `q` is the plaza's held-out ratio quantiles. */
function staffingCell(
  hour: number,
  forecast: number,
  usual: { median: number; peak: number } | null,
  q: number[] | null,
): StaffingHour {
  const band = q != null && q.length > 0 && forecast >= MIN_CELL ? q : null;
  const chance = band && usual && usual.peak > 0 ? exceedChance(band, usual.peak / forecast) : null;
  return {
    hour,
    forecast: Math.round(forecast),
    low: band ? Math.round(forecast * quantileAt(band, 0.1)) : null,
    high: band ? Math.round(forecast * quantileAt(band, 0.9)) : null,
    usual: usual ? Math.round(usual.median) : null,
    usualPeak: usual ? Math.round(usual.peak) : null,
    load: usual && usual.median > 0 ? Math.round((forecast / usual.median) * 1000) / 1000 : null,
    chance: chance == null ? null : Math.round(chance * 1000) / 1000,
    level: chance == null ? "normal" : chance >= CERTAIN ? "above" : chance >= LIKELY ? "likely" : "normal",
  };
}

/** One histogram bin of archived forecasts: p_high in [b/100, (b+1)/100), outcome High or not. */
type CalBin = { test: boolean; b: number; pos: boolean; n: number };
type CurvePoint = { t: number; tp: number; fp: number; fn: number; n: number };

/** Confusion counts at every cut-off 0.01..0.95 for the bins given ("p_high >= t" means bin >= t). */
function sweep(bins: CalBin[]): CurvePoint[] {
  const out: CurvePoint[] = [];
  const n = bins.reduce((s, x) => s + x.n, 0);
  const pos = bins.reduce((s, x) => s + (x.pos ? x.n : 0), 0);
  for (let t = 1; t <= 95; t++) {
    let tp = 0;
    let fp = 0;
    for (const x of bins) if (x.b >= t) x.pos ? (tp += x.n) : (fp += x.n);
    out.push({ t: t / 100, tp, fp, fn: pos - tp, n });
  }
  return out;
}

const f1Of = (c: CurvePoint) => (2 * c.tp + c.fp + c.fn > 0 ? (2 * c.tp) / (2 * c.tp + c.fp + c.fn) : 0);

/** The cut-off with the highest F1 on the fit bins; ties go to the higher (more precise) cut-off. */
function pickThreshold(fit: CurvePoint[]): CurvePoint | null {
  let best: CurvePoint | null = null;
  for (const c of fit) if (c.tp > 0 && (!best || f1Of(c) >= f1Of(best))) best = c;
  return best;
}

/** Fewer than this many High outcomes to fit on, or to test on, and no cut-off is claimed. */
const MIN_FIT_HIGH = 100;
const MIN_TEST_HIGH = 30;
/** A probability's hit rate is quoted only when at least this many archived forecasts reached it. */
const MIN_HIT_N = 50;

const ACTION: Record<CongestionAdvice["label"], string> = {
  // No VMS: the system cannot drive message signs and the manuscript does not propose them (2 Nov 2026).
  Act: "Deploy counter-flow, publish a Mobile App advisory and alert the TCC before the first High hour.",
  Monitor: "No action; re-check next cycle.",
};

/* ── what the plan is computed from ──────────────────────────────────────── */

type CongestionRow = { segment: string; km?: number | null; hours: number; state: string; probability: number | string; pHigh?: number | string | null; baseTs?: string | null };

type Usual = { median: number; peak: number };
type PlazaProfile = {
  plaza: string;
  /** Volume by [weekday, weekend][hour], summed over the window: the shares. */
  v: [number[], number[]];
  usual: [(Usual | null)[], (Usual | null)[]];
};

type Inputs = {
  champion: { model_name: string; wmape: string | null; accepted: boolean };
  future: { date: string; dow: number; v: number }[];
  plazas: PlazaProfile[];
  /** Corridor volume by day type [weekday, weekend], summed over the window. */
  corridor: [number, number];
  usualFrom: string | null;
  usualTo: string | null;
  usualDays: [number, number];
  /** Held-out ratio quantiles per plaza. */
  band: Map<string, number[]>;
  bandBasis: TrafficPrescriptive["basis"]["band"];
  /** The exit list, for naming segments the congestion forecast lacks. */
  segments: string[];
};

/* Read once per split and kept: the inputs change when the warehouse is reloaded or the models retrain,
   not between requests. One read at a time per split, so panels asking together share it. */
const INPUT_TTL_MS = 10 * 60 * 1000;
/* No champion row (a retrain mid-write) is kept only briefly, so the next request asks again. */
const INCOMPLETE_INPUT_TTL_MS = 20 * 1000;
const inputCache = new Map<string, { at: number; data: Inputs | null }>();
const inputReads = new Map<string, Promise<Inputs | null>>();

function loadInputs(split: string): Promise<Inputs | null> {
  const hit = inputCache.get(split);
  if (hit && Date.now() - hit.at < (hit.data ? INPUT_TTL_MS : INCOMPLETE_INPUT_TTL_MS)) return Promise.resolve(hit.data);
  let read = inputReads.get(split);
  if (!read) {
    read = readInputs(split)
      .then((data) => {
        inputCache.set(split, { at: Date.now(), data });
        return data;
      })
      .finally(() => inputReads.delete(split));
    inputReads.set(split, read);
  }
  return read;
}

/* The congestion forecast, read and kept apart from the staffing inputs (TR-12, 19 Oct 2026).
 *
 * getMLPredictiveCongestion answers a failure with null rather than throwing. Right after a backend start
 * that read can wait out the connect timeout; cached with the staffing inputs, the panel stayed empty until
 * a restart. Kept separately, a failed or empty read is never cached: the next request reads again. A good
 * read is kept for five minutes -- the table is rewritten hourly, so this is about bursts, not freshness. */
const CONGESTION_TTL_MS = 5 * 60 * 1000;
let congestionCache: { at: number; rows: CongestionRow[] } | null = null;
let congestionRead: Promise<CongestionRow[] | null> | null = null;

function loadCongestion(): Promise<CongestionRow[] | null> {
  if (congestionCache && Date.now() - congestionCache.at < CONGESTION_TTL_MS) return Promise.resolve(congestionCache.rows);
  congestionRead ??= (getMLPredictiveCongestion() as Promise<CongestionRow[] | null>)
    .then((rows) => {
      if (rows && rows.length > 0) congestionCache = { at: Date.now(), rows };
      return rows;
    })
    .finally(() => { congestionRead = null; });
  return congestionRead;
}

/* The congestion cut-off's evidence: archived forecasts against what followed, as a histogram of p_high
   (hundredths) x outcome x fit/test. About 20 s on 63,000 scored forecast-hours (the score view derives
   the outcome from Waze jams), so it is kept for six hours -- the archive grows by one run an hour, which
   moves a cut-off picked on tens of thousands of rows very little. A failed read is not kept. */
const CALIBRATION_TTL_MS = 6 * 60 * 60 * 1000;
type CalibrationEvidence = { bins: CalBin[]; fitFrom: string | null; fitTo: string | null; testFrom: string | null; testTo: string | null; runs: number };
let calibrationCache: { at: number; data: CalibrationEvidence } | null = null;
let calibrationRead: Promise<CalibrationEvidence | null> | null = null;

function loadCalibration(): Promise<CalibrationEvidence | null> {
  if (calibrationCache && Date.now() - calibrationCache.at < CALIBRATION_TTL_MS) return Promise.resolve(calibrationCache.data);
  calibrationRead ??= readCalibration()
    .then((data) => {
      if (data) calibrationCache = { at: Date.now(), data };
      return data;
    })
    .catch((e) => {
      console.warn("[traffic-prescriptive] congestion calibration unavailable:", e?.message ?? e);
      return null;
    })
    .finally(() => { calibrationRead = null; });
  return calibrationRead;
}

async function readCalibration(): Promise<CalibrationEvidence | null> {
  if (!db) return null;
  const { rows } = await db.query<{ test: boolean; b: number; pos: boolean; n: number; t_from: string; t_to: string; runs: number }>(
    `WITH j AS (
       SELECT LEAST(99, FLOOR(l.p_high * 100))::int AS b, (s.actual_state = 'High') AS pos, s.target_ts, l.base_ts
         FROM gold.ml_congestion_forecast_log l
         JOIN gold.v_congestion_forecast_score s
           ON s.base_ts = l.base_ts AND s.segment_name = l.segment_name AND s.hours_ahead = l.hours_ahead
        WHERE l.hours_ahead BETWEEN 1 AND 12 AND s.actual_state IS NOT NULL AND l.p_high IS NOT NULL
     ), cut AS (SELECT MAX(target_ts) - interval '7 days' AS at FROM j),
     k AS (SELECT j.*, (j.target_ts > cut.at) AS test FROM j, cut)
     SELECT k.test, k.b, k.pos, COUNT(*)::int AS n,
            MIN(MIN(k.target_ts)) OVER (PARTITION BY k.test)::text AS t_from,
            MAX(MAX(k.target_ts)) OVER (PARTITION BY k.test)::text AS t_to,
            (SELECT COUNT(DISTINCT base_ts) FROM j)::int AS runs
       FROM k GROUP BY k.test, k.b, k.pos`,
  );
  if (rows.length === 0) return { bins: [], fitFrom: null, fitTo: null, testFrom: null, testTo: null, runs: 0 };
  const fit = rows.find((r) => !r.test);
  const test = rows.find((r) => r.test);
  return {
    bins: rows.map((r) => ({ test: r.test, b: Number(r.b), pos: r.pos, n: Number(r.n) })),
    fitFrom: fit?.t_from ?? null,
    fitTo: fit?.t_to ?? null,
    testFrom: test?.t_from ?? null,
    testTo: test?.t_to ?? null,
    runs: Number(rows[0].runs),
  };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function calibrate(ev: CalibrationEvidence | null): { cal: CongestionCalibration; all: CurvePoint[] } {
  const empty: CongestionCalibration = {
    ok: false, reason: null, threshold: null, precision: null, recall: null, f1: null, baseRate: null, fitF1: null,
    scored: 0, scoredHigh: 0, runs: 0, fitFrom: null, fitTo: null, testFrom: null, testTo: null, testRows: 0,
  };
  if (!ev) return { cal: { ...empty, reason: "The forecast archive could not be read." }, all: [] };
  const fitBins = ev.bins.filter((x) => !x.test);
  const testBins = ev.bins.filter((x) => x.test);
  const highOf = (bs: CalBin[]) => bs.reduce((s, x) => s + (x.pos ? x.n : 0), 0);
  const all = sweep(ev.bins);
  const base: CongestionCalibration = {
    ...empty,
    scored: ev.bins.reduce((s, x) => s + x.n, 0),
    scoredHigh: highOf(ev.bins),
    runs: ev.runs,
    fitFrom: ev.fitFrom, fitTo: ev.fitTo, testFrom: ev.testFrom, testTo: ev.testTo,
    testRows: testBins.reduce((s, x) => s + x.n, 0),
  };
  if (highOf(fitBins) < MIN_FIT_HIGH || highOf(testBins) < MIN_TEST_HIGH) {
    return {
      cal: {
        ...base,
        reason: `Too few scored forecasts to set an Act line: ${highOf(fitBins)} High hours to fit on and ${highOf(testBins)} to test on ` +
          `(needs ${MIN_FIT_HIGH} and ${MIN_TEST_HIGH}).`,
      },
      all,
    };
  }
  const best = pickThreshold(sweep(fitBins));
  if (!best) return { cal: { ...base, reason: "No cut-off in the archive ever caught a High hour." }, all };
  const held = sweep(testBins).find((c) => c.t === best.t)!;
  return {
    cal: {
      ...base,
      ok: true,
      threshold: best.t,
      precision: held.tp + held.fp > 0 ? r3(held.tp / (held.tp + held.fp)) : null,
      recall: held.tp + held.fn > 0 ? r3(held.tp / (held.tp + held.fn)) : null,
      f1: r3(f1Of(held)),
      baseRate: held.n > 0 ? r3((held.tp + held.fn) / held.n) : null,
      fitF1: r3(f1Of(best)),
    },
    all,
  };
}

/* The usual level: per plaza, hour and day type, its daily totals over the window. Also the shares. */
const windowSql = `win AS (SELECT MAX(date) - ${WINDOW_DAYS - 1} AS lo, MAX(date) AS hi FROM gold.fact_traffic_hourly WHERE total IS NOT NULL),
  cell AS (
    SELECT f.exit_canonical AS plaza, f.date, f.hour::int AS hour,
           (EXTRACT(dow FROM f.date)::int IN (0, 6)) AS weekend, SUM(f.total)::float8 AS v
      FROM gold.fact_traffic_hourly f, win
     WHERE f.total IS NOT NULL AND f.date BETWEEN win.lo AND win.hi
     GROUP BY 1, 2, 3, 4)`;

async function readInputs(split: string): Promise<Inputs | null> {
  /* The champion: the best accepted volume model. When none is accepted the plan falls back to the seasonal
     naive (below) rather than refusing to plan; the flag travels with the answer. */
  const champQ = await db!.query<{ model_name: string; wmape: string | null; accepted: boolean }>(
    `SELECT model_name, wmape, accepted FROM gold.ml_model_metrics
      WHERE target = 'Total Traffic' AND split_label = $1
      ORDER BY accepted DESC, rank ASC NULLS LAST LIMIT 1`,
    [split],
  );
  let champion = champQ.rows[0];
  if (!champion) return null;
  /* No model passed the acceptance test: plan with the benchmark they failed to beat, the same weekday of the last
     recorded week (fix list A5, 2 Nov 2026). Its error band is replayed the same way, from last week's actuals. */
  const naive = !champion.accepted;
  const col = naive ? undefined : MODEL_COLUMN[champion.model_name];
  if (!naive && !col) return null;
  if (naive) champion = { model_name: "Seasonal naive (last week repeated)", wmape: null, accepted: false };

  const predSql = naive
    ? `SELECT p.forecast_date AS d, w.actual_volume::float8 AS f
         FROM gold.ml_predictive_volume p
         JOIN gold.ml_predictive_volume w ON w.split_label = p.split_label AND w.forecast_date = p.forecast_date - 7
        WHERE p.split_label = $1 AND NOT p.is_future AND p.actual_volume IS NOT NULL AND w.actual_volume IS NOT NULL`
    : `SELECT p.forecast_date AS d, p.${col}::float8 AS f
         FROM gold.ml_predictive_volume p
        WHERE p.split_label = $1 AND p.is_holdout AND NOT p.is_future AND p.${col} IS NOT NULL AND p.actual_volume IS NOT NULL`;

  const [futureQ, usualQ, bandQ, segmentQ] = await Promise.all([
    naive
      ? db!.query<{ d: string; v: string | null; dow: number }>(
          `WITH last_week AS (
             SELECT forecast_date AS d, actual_volume AS v FROM gold.ml_predictive_volume
              WHERE split_label = $1 AND actual_volume IS NOT NULL ORDER BY forecast_date DESC LIMIT 7
           ), ahead AS (
             SELECT forecast_date AS d FROM gold.ml_predictive_volume
              WHERE split_label = $1 AND is_future ORDER BY forecast_date ASC LIMIT $2
           )
           SELECT a.d::text AS d, w.v::text AS v, EXTRACT(dow FROM a.d)::int AS dow
             FROM ahead a JOIN last_week w ON EXTRACT(dow FROM w.d) = EXTRACT(dow FROM a.d)
            ORDER BY a.d`,
          [split, WEEK_DAYS],
        )
      : db!.query<{ d: string; v: string | null; dow: number }>(
          `SELECT forecast_date::text AS d, ${col}::text AS v, EXTRACT(dow FROM forecast_date)::int AS dow
             FROM gold.ml_predictive_volume
            WHERE split_label = $1 AND is_future AND ${col} IS NOT NULL
            ORDER BY forecast_date ASC LIMIT $2`,
          [split, WEEK_DAYS],
        ),
    db!.query<{ plaza: string; weekend: boolean; hour: number; v: number; days: number; usual: number; peak: number; lo: string; hi: string }>(
      `WITH ${windowSql}
       SELECT plaza, weekend, hour, SUM(v) AS v, COUNT(*)::int AS days,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY v) AS usual,
              percentile_cont(${USUAL_PEAK_PCT}) WITHIN GROUP (ORDER BY v) AS peak,
              (SELECT lo::text FROM win) AS lo, (SELECT hi::text FROM win) AS hi
         FROM cell GROUP BY 1, 2, 3`,
    ),
    /* The held-out replay: the champion's own held-out days, apportioned exactly as the plan apportions the
       future, against what each plaza-hour then carried. */
    db!.query<{ plaza: string; n: number; days: number; lo: string; hi: string; abs_err: number; vol: number; q: number[] }>(
      `WITH ${windowSql},
       shr AS (SELECT plaza, weekend, hour, SUM(v) / SUM(SUM(v)) OVER (PARTITION BY weekend) AS s FROM cell GROUP BY 1, 2, 3),
       pred AS (${predSql}),
       j AS (
         SELECT c.plaza, c.date, c.v, pred.f * shr.s AS yhat
           FROM cell c JOIN pred ON pred.d = c.date
           JOIN shr ON shr.plaza = c.plaza AND shr.weekend = c.weekend AND shr.hour = c.hour)
       SELECT plaza, COUNT(*)::int AS n, COUNT(DISTINCT date)::int AS days, MIN(date)::text AS lo, MAX(date)::text AS hi,
              SUM(ABS(v - yhat)) AS abs_err, SUM(v) AS vol,
              percentile_cont(ARRAY[${LEVELS.join(",")}]::float8[]) WITHIN GROUP (ORDER BY v / yhat) AS q
         FROM j WHERE yhat >= $2 GROUP BY plaza`,
      [split, MIN_CELL],
    ).catch((e) => {
      console.warn("[traffic-prescriptive] error band unavailable:", e?.message ?? e);
      return { rows: [] as { plaza: string; n: number; days: number; lo: string; hi: string; abs_err: number; vol: number; q: number[] }[] };
    }),
    // Corridor order from the official exit list (lib/km-post.ts), not gold.exit_km_post's hand-entered posts.
    db!.query<{ name: string }>(
      `SELECT x.exit_name AS name FROM nlex_exits x
         JOIN ${exitKmValuesSql()} ON exit_km.key = ${kmKeySql("x.exit_name")}
        ORDER BY exit_km.measured`,
    )
      .catch(() => ({ rows: [] as { name: string }[] })),
  ]);

  const corridor: [number, number] = [0, 0];
  const usualDays: [number, number] = [0, 0];
  const byPlaza = new Map<string, PlazaProfile>();
  for (const r of usualQ.rows) {
    const v = Number(r.v);
    const h = Number(r.hour);
    if (!(v > 0) || !(h >= 0 && h < 24)) continue;
    const wk = r.weekend ? 1 : 0;
    corridor[wk] += v;
    usualDays[wk] = Math.max(usualDays[wk], Number(r.days));
    let p = byPlaza.get(r.plaza);
    if (!p) {
      p = {
        plaza: r.plaza,
        v: [new Array(24).fill(0), new Array(24).fill(0)],
        usual: [new Array(24).fill(null), new Array(24).fill(null)],
      };
      byPlaza.set(r.plaza, p);
    }
    p.v[wk][h] += v;
    p.usual[wk][h] = { median: Number(r.usual), peak: Number(r.peak) };
  }

  const band = new Map<string, number[]>();
  let cells = 0;
  let absErr = 0;
  let vol = 0;
  let bandDays = 0;
  let bandFrom: string | null = null;
  let bandTo: string | null = null;
  for (const r of bandQ.rows) {
    const q = (r.q ?? []).map(Number);
    if (q.length !== LEVELS.length || q.some((x) => !Number.isFinite(x))) continue;
    band.set(r.plaza, q);
    cells += Number(r.n);
    absErr += Number(r.abs_err);
    vol += Number(r.vol);
    bandDays = Math.max(bandDays, Number(r.days));
    if (!bandFrom || r.lo < bandFrom) bandFrom = r.lo;
    if (!bandTo || r.hi > bandTo) bandTo = r.hi;
  }

  return {
    champion,
    future: futureQ.rows
      .map((r) => ({ date: r.d, dow: Number(r.dow), v: Number(r.v) }))
      .filter((r) => Number.isFinite(r.v) && r.v > 0),
    plazas: [...byPlaza.values()],
    corridor,
    usualFrom: usualQ.rows[0]?.lo ?? null,
    usualTo: usualQ.rows[0]?.hi ?? null,
    usualDays,
    band,
    bandBasis: bandFrom && bandTo && vol > 0
      ? { from: bandFrom, to: bandTo, days: bandDays, cells, wmapePct: Math.round((absErr / vol) * 10000) / 100 }
      : null,
    segments: segmentQ.rows.map((r) => r.name),
  };
}

/* ── the endpoint ─────────────────────────────────────────────────────────── */

/** Most certain first, then the furthest above usual. */
const byCertainty = (a: StaffingHour, b: StaffingHour) =>
  (b.chance ?? -1) - (a.chance ?? -1) || (b.load ?? 0) - (a.load ?? 0);

export async function getTrafficPrescriptive(opts: { split?: string }): Promise<TrafficPrescriptive | null> {
  if (!db) return null;
  const split = opts.split ?? "80_20";

  // In parallel: the congestion reads are independent of the staffing inputs.
  const [inputs, congestionRows, evidence] = await Promise.all([loadInputs(split), loadCongestion(), loadCalibration()]);
  if (!inputs) return null;
  const { champion, future, corridor } = inputs;

  const priorities: StaffingPriority[] = [];

  /** One day's comparison. `hourly` false keeps only each plaza's summary. */
  const buildDay = (date: string, dow: number, forecast: number, hourly: boolean): StaffingDay => {
    const weekend = dow === 0 || dow === 6;
    const wk: 0 | 1 = weekend ? 1 : 0;
    const dayType = weekend ? "weekend" : "weekday";
    const denom = corridor[wk] || 1;
    const plazas: StaffingPlazaDay[] = [];
    for (const p of inputs.plazas) {
      const share = p.v[wk].reduce((a, x) => a + x, 0) / denom;
      if (!(share > 0)) continue;
      const q = inputs.band.get(p.plaza) ?? null;
      const hours = p.v[wk].map((v, h) => staffingCell(h, (forecast * v) / denom, p.usual[wk][h], q));
      const peakHour = hours.reduce((m, x) => (x.forecast > hours[m].forecast ? x.hour : m), 0);
      const top = [...hours].filter((x) => x.chance != null).sort(byCertainty)[0] ?? null;
      for (const x of hours) if (x.level !== "normal") priorities.push({ ...x, date, dayType, plaza: p.plaza });
      plazas.push({
        plaza: p.plaza,
        sharePct: Math.round(share * 10000) / 100,
        peakHour,
        top,
        aboveHours: hours.filter((x) => x.level === "above").length,
        likelyHours: hours.filter((x) => x.level === "likely").length,
        hours: hourly ? hours : [],
      });
    }
    plazas.sort((a, b) => (a.top && b.top ? byCertainty(a.top, b.top) : a.top ? -1 : b.top ? 1 : b.sharePct - a.sharePct));
    return {
      date,
      dayType,
      corridorForecast: Math.round(forecast),
      aboveCells: plazas.reduce((s, x) => s + x.aboveHours, 0),
      likelyCells: plazas.reduce((s, x) => s + x.likelyHours, 0),
      plazas,
    };
  };

  const built = future.map((r, i) => buildDay(r.date, r.dow, r.v, i === 0));
  // The hourly detail rides on the first day only (shiftPlan); the week rows are summaries, so it is not sent twice.
  const shiftPlan = built[0] ?? null;
  const week = built.map((d, i) => (i === 0 ? { ...d, plazas: d.plazas.map((p) => ({ ...p, hours: [] })) } : d));
  priorities.sort(byCertainty);

  /* ── congestion ─────────────────────────────────────────────────────────── */
  const { cal, all } = calibrate(evidence);
  const cutoff = cal.ok && cal.threshold != null ? Math.round(cal.threshold * 100) : null;
  /** Of archived forecasts at or above p, the share High followed. */
  const hitAt = (p: number) => {
    const c = all[Math.max(0, Math.min(94, Math.floor(p * 100 + 1e-9) - 1))];
    const n = c ? c.tp + c.fp : 0;
    return { hitRate: c && n >= MIN_HIT_N && p >= 0.01 ? r3(c.tp / n) : null, hitN: n };
  };

  type SegAgg = { segment: string; km: number | null; peak: number; peakH: number; firstAct: number | null };
  const bySeg = new Map<string, SegAgg>();
  const timeline = new Map<string, { h: number; pHigh: number }[]>();
  for (const c of congestionRows ?? []) {
    // The 1-12 h horizon the panel names (fix list A3, 2 Nov 2026).
    const hrs = Number(c.hours);
    if (!(hrs >= 1 && hrs <= 12)) continue;
    const p = Number(c.probability);
    if (!Number.isFinite(p)) continue;
    const high = String(c.state).toLowerCase() === "high";
    /* `probability` is always the chance of High, the forecast's own p_high. The complement stays only for a row
       with no p_high: with Low, Med and High, 1 - p of a Low row also holds Med (31 Oct 2026). */
    const stored = Number(c.pHigh);
    const pHigh = c.pHigh != null && Number.isFinite(stored) ? stored : high ? p : 1 - p;
    const tl = timeline.get(c.segment) ?? [];
    tl.push({ h: hrs, pHigh: r3(pHigh) });
    timeline.set(c.segment, tl);
    const cur = bySeg.get(c.segment) ?? { segment: c.segment, km: c.km ?? null, peak: -1, peakH: hrs, firstAct: null };
    if (pHigh > cur.peak || (pHigh === cur.peak && hrs < cur.peakH)) {
      cur.peak = pHigh;
      cur.peakH = hrs;
    }
    // Compared in ten-thousandths, as stored, so 0.16 is at a 0.16 cut-off and not a rounding error below it.
    if (cutoff != null && Math.round(pHigh * 10000) >= cutoff * 100 && (cur.firstAct == null || hrs < cur.firstAct)) cur.firstAct = hrs;
    bySeg.set(c.segment, cur);
  }
  const congestion: CongestionAdvice[] = [...bySeg.values()]
    .map((s) => {
      const label: CongestionAdvice["label"] = s.firstAct != null ? "Act" : "Monitor";
      return {
        segment: s.segment,
        km: s.km,
        probability: r3(Math.max(0, s.peak)),
        hoursAhead: s.peakH,
        firstAct: s.firstAct,
        label,
        action: cal.ok ? ACTION[label] : "No Act line until enough past forecasts are scored; read the chance directly.",
        ...hitAt(Math.max(0, s.peak)),
      };
    })
    .sort((a, b) => (a.label === b.label ? 0 : a.label === "Act" ? -1 : 1) || b.probability - a.probability || (a.firstAct ?? 99) - (b.firstAct ?? 99));
  const forecastSegments = new Set((congestionRows ?? []).map((c) => c.segment));
  const congestionMissing = inputs.segments.filter((s) => !forecastSegments.has(s));

  return {
    champion: {
      model: champion.model_name,
      wmapePct: champion.wmape == null ? null : Math.round(Number(champion.wmape) * 100) / 100,
      accepted: Boolean(champion.accepted),
    },
    basis: {
      usualFrom: inputs.usualFrom,
      usualTo: inputs.usualTo,
      usualWeekdays: inputs.usualDays[0],
      usualWeekends: inputs.usualDays[1],
      usualPeakPercentile: Math.round(USUAL_PEAK_PCT * 100),
      plazasProfiled: inputs.plazas.length,
      forecastFrom: future[0]?.date ?? null,
      forecastTo: future[future.length - 1]?.date ?? null,
      band: inputs.bandBasis,
      minCellVehicles: MIN_CELL,
    },
    shiftPlan,
    week,
    priorities: priorities.slice(0, 12),
    plazasWithoutBand: inputs.plazas.filter((p) => !inputs.band.has(p.plaza)).map((p) => p.plaza),
    congestion,
    congestionCalibration: cal,
    congestionMissing,
    congestionUnavailable: congestionRows == null,
    congestionBaseTs: congestionRows?.find((c) => c.baseTs)?.baseTs ?? null,
    congestionTimeline: [...timeline.entries()].map(([segment, hours]) => ({ segment, hours: hours.sort((a, b) => a.h - b.h) })),
  };
}
