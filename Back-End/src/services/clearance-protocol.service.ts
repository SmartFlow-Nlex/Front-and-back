import { db } from "../config/db.js";

// ---------------------------------------------------------------------------
// Incident → Prescriptive: Clearance Response Protocol.
//
// Answers a different question than PrescriptiveDeploymentPanel (where to
// place units) or PatrolAlertWindowPanel (when to be on alert): once an
// incident is reported, when to escalate it.
//
// Data only (2 Nov 2026, "no assumptions across the prescriptive analytics").
// This used to be a two-stage stochastic MILP that picked a dispatch count
// from a unit effect, unit and delay costs, lane capacity, a demand v/c level
// and a response delay, none of which the record holds; the count followed
// whatever those were set to. What is left is what the record measures:
//   1. A Kaplan-Meier clearance-time curve from real per-event durations
//      (silver.nlex_accident_events_clean / silver.nlex_breakdown_events_clean),
//      right-censored at 1440 min rather than dropped -- see toObservations().
//      Type, severity and weather pick which events go in; they are filters
//      on the data, not settings.
//   2. The escalation rule read off that curve: if an incident is still open
//      at the set's own P50, the chance it runs past the P80 is
//      S(P80) / S(P50), the curve's conditional survival, with a Greenwood
//      95% interval (escalationRule()).
//   3. Checkpoints at P25 / P50 / P80: the share still open, how many events
//      that rests on, the median time left, and the chance of running past
//      the P95 (checkpointAt()).
// ---------------------------------------------------------------------------

type CacheEntry = { at: number; data: unknown };
const clearanceCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export type ClearanceType = "accident" | "breakdown";
export type ClearanceSeverity = "all" | "pdo" | "injury" | "fatal";
export type ClearanceWeather = "all" | "dry" | "wet";

export type ClearanceProtocolFilters = {
  type: ClearanceType;
  severity: ClearanceSeverity;
  weather: ClearanceWeather;
  months: "3" | "12" | "all";
  from?: string;
  to?: string;
};

// ---------------------------------------------------------------------------
// Pure math — exported so they're unit-testable without a database.
// ---------------------------------------------------------------------------

export type Observation = { duration: number; censored: boolean };
export type SurvivalPoint = { minute: number; survival: number; atRisk: number };

/**
 * Durations beyond 1440 min (24h) are right-censored at 1440, not dropped --
 * the event is known to have still been open at minute 1440, which is real
 * information a Kaplan-Meier estimator can use, unlike the Descriptive tab's
 * MTTC (incident.service.ts), which excludes anything outside [0,1440]
 * entirely because a simple mean has no way to represent "still ongoing."
 * Negative/missing durations have no sensible "still open" interpretation
 * (they're chronology errors or absent timestamps, not large-but-real
 * durations) and are excluded either way.
 */
export function toObservations(rawMinutes: (number | null)[]): Observation[] {
  const obs: Observation[] = [];
  for (const raw of rawMinutes) {
    if (raw == null || !Number.isFinite(raw)) continue;
    // 0 minutes is a recording artefact, not a clearance (fix list A7, 2 Nov 2026); negatives were already dropped.
    if (raw <= 0) continue;
    if (raw > 1440) obs.push({ duration: 1440, censored: true });
    else obs.push({ duration: raw, censored: false });
  }
  return obs;
}

/**
 * Standard Kaplan-Meier product-limit estimator. At each distinct EVENT
 * (non-censored) time t: S(t) = S(t-) * (1 - d(t)/n(t)), where n(t) is
 * everyone whose duration >= t (not yet failed or censored before t) and
 * d(t) is how many actually cleared exactly at t. Censored observations
 * leave the risk set at their own time without contributing a "death" --
 * they shrink n(t) for later event times but never move S(t) directly.
 */
export function kaplanMeier(obs: Observation[]): SurvivalPoint[] {
  const n0 = obs.length;
  if (n0 === 0) return [{ minute: 0, survival: 1, atRisk: 0 }];
  const sorted = [...obs].sort((a, b) => a.duration - b.duration);

  /* One pass over the sorted sample, a tie group at a time (19 Oct 2026). The earlier version re-scanned
     the WHOLE sample for d(t) at every distinct event time -- O(n x distinct times) -- and durations come
     from second-precision timestamps, so nearly every event is its own time: 11,819 breakdowns over 12
     months (6,476 times) cost seconds, and Range "All" (48k breakdowns) about 40 s, all of it synchronous,
     so the Node event loop stalled and EVERY dashboard request waited behind it. That is the "Breakdown
     never loads" half of testers' IN-15..IN-21. Output is identical: points only at times with at least
     one real clearance, n(t) = everyone with duration >= t (the group's start index), d(t) = the
     uncensored members of the tie group. */
  const points: SurvivalPoint[] = [{ minute: 0, survival: 1, atRisk: n0 }];
  let survival = 1;
  let i = 0; // start of the current tie group: how many observations have duration strictly < t
  while (i < sorted.length) {
    const t = sorted[i].duration;
    const atRisk = n0 - i;
    let d = 0;
    let j = i;
    while (j < sorted.length && sorted[j].duration === t) {
      if (!sorted[j].censored) d++;
      j++;
    }
    if (d > 0) {
      survival = survival * (1 - d / Math.max(atRisk, 1));
      points.push({ minute: t, survival, atRisk });
    }
    i = j;
  }
  return points;
}

/** S(t): the curve's value at or just before t (step function, holds until the next event). */
export function survivalAt(curve: SurvivalPoint[], t: number): number {
  let s = 1;
  for (const p of curve) {
    if (p.minute <= t) s = p.survival;
    else break;
  }
  return s;
}

/** Smallest minute at which S(t) <= 1-q, i.e. the q-th quantile of the duration distribution. */
export function quantileFromCurve(curve: SurvivalPoint[], q: number): number {
  const target = 1 - q;
  for (const p of curve) if (p.survival <= target) return p.minute;
  return curve.length > 0 ? curve[curve.length - 1].minute : 0;
}

/** Area under the step survival curve from 0 to its last observed time -- the
 *  restricted mean survival time (RMST), i.e. a mean duration that properly
 *  accounts for censored events instead of averaging only the ones that
 *  resolved (which would understate the mean by construction). */
export function restrictedMean(curve: SurvivalPoint[]): number {
  let area = 0;
  let prevT = 0;
  let prevS = 1;
  for (const p of curve) {
    area += prevS * (p.minute - prevT);
    prevT = p.minute;
    prevS = p.survival;
  }
  return area;
}

export type ScenarioLabel = "fast" | "typical" | "slow" | "extreme";
export type ScenarioDef = { label: ScenarioLabel; probability: number; durationMin: number };

/**
 * Cuts the curve into 4 bands at its own P50/P80/P95 (a corridor with a
 * slower mix gets wider bands, not a fixed "30/60/90 min" assumption).
 * Probability per band is S(lower)-S(upper) read directly off the curve, so
 * the four probabilities sum to exactly 1 by telescoping regardless of
 * where the quantiles actually land on real, tied, or sparse data.
 * Each band's representative duration is the conditional median of the
 * actual (non-censored) raw events inside it -- censored observations have
 * an unknown true duration, so they inform the survival curve and the
 * probabilities but not a band's point estimate.
 */
export function buildScenarios(curve: SurvivalPoint[], rawEvents: number[]): { scenarios: ScenarioDef[]; p50: number; p80: number; p95: number } {
  const p50 = quantileFromCurve(curve, 0.5);
  const p80 = quantileFromCurve(curve, 0.8);
  const p95 = quantileFromCurve(curve, 0.95);
  const sP50 = survivalAt(curve, p50);
  const sP80 = survivalAt(curve, p80);
  const sP95 = survivalAt(curve, p95);

  const conditionalMedian = (lo: number, hi: number, fallback: number): number => {
    const inBand = rawEvents.filter((d) => d > lo && d <= hi).sort((a, b) => a - b);
    if (inBand.length === 0) return fallback;
    const mid = Math.floor(inBand.length / 2);
    return inBand.length % 2 === 0 ? (inBand[mid - 1] + inBand[mid]) / 2 : inBand[mid];
  };

  const bands: { label: ScenarioLabel; lo: number; hi: number; probability: number; fallback: number }[] = [
    { label: "fast", lo: 0, hi: p50, probability: 1 - sP50, fallback: p50 / 2 },
    { label: "typical", lo: p50, hi: p80, probability: sP50 - sP80, fallback: (p50 + p80) / 2 },
    { label: "slow", lo: p80, hi: p95, probability: sP80 - sP95, fallback: (p80 + p95) / 2 },
    { label: "extreme", lo: p95, hi: Infinity, probability: sP95, fallback: p95 * 1.5 },
  ];

  const scenarios = bands.map((b) => ({
    label: b.label,
    probability: Math.max(b.probability, 0),
    durationMin: conditionalMedian(b.lo, b.hi, b.fallback),
  }));
  return { scenarios, p50, p80, p95 };
}

/** A probability read off the curve, with its 95% interval. */
export type Chance = { p: number; lo: number; hi: number };

/**
 * P(T > b | T > a) = S(b) / S(a): of the incidents still open at minute a,
 * the share still open at minute b. On the Kaplan-Meier curve that is the
 * product of (1 - d/n) over the event times in (a, b]. Its 95% interval uses
 * Greenwood's variance over the same times, on the log scale (the default in
 * R's survfit), capped at 1. d at each point is recovered from the curve
 * itself: S(t) = S(t-) x (1 - d/n).
 */
export function conditionalSurvival(curve: SurvivalPoint[], a: number, b: number): Chance {
  let p = 1;
  let v = 0;
  for (let i = 1; i < curve.length; i++) {
    const pt = curve[i];
    if (pt.minute <= a) continue;
    if (pt.minute > b) break;
    const prev = curve[i - 1].survival;
    const n = pt.atRisk;
    const step = prev > 0 ? pt.survival / prev : 0;
    const d = Math.round(n * (1 - step));
    p *= step;
    if (n > d && n > 0) v += d / (n * (n - d));
  }
  if (p <= 0) return { p: 0, lo: 0, hi: 0 };
  const se = Math.sqrt(v);
  return { p, lo: p * Math.exp(-1.96 * se), hi: Math.min(1, p * Math.exp(1.96 * se)) };
}

/** Of the incidents still open at minute t, the median further time to clear: the first event time u with
 *  S(u) / S(t) <= 0.5, minus t. Null when the curve never gets there (too much censoring). */
export function medianRemaining(curve: SurvivalPoint[], t: number): number | null {
  const base = survivalAt(curve, t);
  if (base <= 0) return null;
  for (const pt of curve) if (pt.minute > t && pt.survival / base <= 0.5) return pt.minute - t;
  return null;
}

export type EscalationRule = { checkAtMinute: number; pastMinute: number; chance: Chance; openAtCheck: number };

/** The rule: still open at the P50, the chance of running past the P80. `obs` gives how many were still open. */
export function escalationRule(curve: SurvivalPoint[], obs: Observation[], p50: number, p80: number): EscalationRule {
  return {
    checkAtMinute: p50,
    pastMinute: p80,
    chance: conditionalSurvival(curve, p50, p80),
    openAtCheck: obs.filter((o) => o.duration > p50).length,
  };
}

export type Checkpoint = {
  label: "P25" | "P50" | "P80";
  minute: number;
  /** S(minute): the share of all incidents still open then. */
  stillOpen: number;
  /** How many of the measured incidents were still open then: what the figures after it rest on. */
  openCount: number;
  medianRemainingMin: number | null;
  /** Still open at minute, the chance of running past the P95. */
  pastP95: Chance;
};

export function checkpointAt(curve: SurvivalPoint[], obs: Observation[], label: Checkpoint["label"], minute: number, p95: number): Checkpoint {
  return {
    label,
    minute,
    stillOpen: survivalAt(curve, minute),
    openCount: obs.filter((o) => o.duration > minute).length,
    medianRemainingMin: medianRemaining(curve, minute),
    pastP95: conditionalSurvival(curve, minute, p95),
  };
}

// ---------------------------------------------------------------------------
// KPI coupling — same RAG doctrine the manuscript specifies, type-dependent.
// ---------------------------------------------------------------------------

export const KPI_TARGETS: Record<ClearanceType, { greenMax: number; amberMax: number }> = {
  breakdown: { greenMax: 10, amberMax: 18 },
  accident: { greenMax: 30, amberMax: 45 },
};

export function ragFor(type: ClearanceType, minutes: number): "green" | "amber" | "red" {
  const t = KPI_TARGETS[type];
  if (minutes <= t.greenMax) return "green";
  if (minutes <= t.amberMax) return "amber";
  return "red";
}

// ---------------------------------------------------------------------------
// The clearance-duration sample, cached on the filters that actually select it
// ---------------------------------------------------------------------------

/* Only type/severity/weather/Range pick WHICH events go into the curve, so the sample is cached and
   single-flighted on just those: the bounds query and the event scan take 1.5-2.7 s with weather Wet/Dry or
   type Breakdown (the hourly_weather join and the deployments JSON unnest). */
type ClearanceSample = { lo: string; hi: string; rawMinutes: (number | null)[] };
const sampleCache = new Map<string, { at: number; data: ClearanceSample }>();
/* A sample holds every event's minutes (tens of thousands of numbers for a wide Range), and each custom Range
   is its own key, so the cache is bounded: expired entries go on every write, and past this many the oldest
   written goes (a Map iterates in insertion order, and a refresh re-inserts its key). */
const SAMPLE_CACHE_MAX = 32;
const sampleInflight = new Map<string, Promise<ClearanceSample>>();

function sampleKey(filters: ClearanceProtocolFilters): string {
  return JSON.stringify({
    type: filters.type,
    // No severity column on the breakdown table, so it must not split that cache.
    severity: filters.type === "accident" ? filters.severity : null,
    weather: filters.weather,
    months: filters.months,
    from: filters.from ?? null,
    to: filters.to ?? null,
  });
}

async function getClearanceSample(filters: ClearanceProtocolFilters): Promise<ClearanceSample> {
  const key = sampleKey(filters);
  const hit = sampleCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const running = sampleInflight.get(key);
  if (running) return running;
  const p = loadClearanceSample(filters)
    .then((data) => {
      const now = Date.now();
      for (const [k, e] of sampleCache) if (now - e.at >= CACHE_TTL_MS) sampleCache.delete(k);
      sampleCache.delete(key);
      sampleCache.set(key, { at: now, data });
      while (sampleCache.size > SAMPLE_CACHE_MAX) sampleCache.delete(sampleCache.keys().next().value!);
      return data;
    })
    .finally(() => sampleInflight.delete(key));
  sampleInflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// DB-backed orchestrator
// ---------------------------------------------------------------------------

export type ClearanceProtocolOk = {
  status: "ok";
  /** "If not cleared by {P50} min, there is a {x}% chance it runs past {P80} min -> escalate." */
  rule: EscalationRule & { text: string };
  checkpoints: Checkpoint[];
  survivalCurve: SurvivalPoint[];
  quantiles: { p50: number; p80: number; p95: number };
  kpi: {
    /** Restricted mean clearance time, the area under the measured curve. */
    baselineMttr: number;
    rag: "green" | "amber" | "red";
    targets: { greenMax: number; amberMax: number };
    /** What the duration above actually measures — accident: real lane-clearance proxy; breakdown: last unit departure, NOT lane clearance. */
    metricLabel: string;
    /** True for breakdowns: the warehouse has no "lane reopened" timestamp for them, so RAG is a proxy reading, not a direct one. */
    indicative: boolean;
  };
  /** How the durations are measured: data definitions, not settings. */
  method: string[];
  scoringWindow: { from: string; to: string };
  sampleSize: number;
  censoredCount: number;
};

export type ClearanceProtocolInsufficientData = {
  status: "insufficient_data";
  sampleSize: number;
  scoringWindow: { from: string; to: string };
  message: string;
};

export type ClearanceProtocolResult = ClearanceProtocolOk | ClearanceProtocolInsufficientData;

/** Bounds, Range resolution and the raw clearance durations -- the only DB work behind the panel. Throws
 *  on a query error (caught by getClearanceProtocolFromDb) so a failed read is never cached as a sample. */
async function loadClearanceSample(filters: ClearanceProtocolFilters): Promise<ClearanceSample> {
  if (!db) throw new Error("database not configured");
  // Bounds + range resolution mirror getIncidentAnalyticsFromDb's own
  // (incident.service.ts) exactly: clamp to real data, trailing window
  // counted back from the last actual day, not today's wall-clock date.
  const bounds = await db.query(
    `SELECT LEAST(a.lo, b.lo)::text AS lo, GREATEST(a.hi, b.hi)::text AS hi
     FROM (SELECT min(event_start_date)::date AS lo, max(event_start_date)::date AS hi FROM silver.nlex_accident_events_clean) a,
          (SELECT min(event_encoded_date)::date AS lo, max(event_encoded_date)::date AS hi FROM silver.nlex_breakdown_events_clean) b`,
  );
  const minDate: string = bounds.rows[0].lo;
  const maxDate: string = bounds.rows[0].hi;

  let lo: string;
  let hi: string;
  if (filters.from && filters.to) {
    const [f, t] = filters.from <= filters.to ? [filters.from, filters.to] : [filters.to, filters.from];
    lo = f < minDate ? minDate : f;
    hi = t > maxDate ? maxDate : t;
  } else if (filters.months === "all") {
    lo = minDate;
    hi = maxDate;
  } else {
    hi = maxDate;
    lo = (
      await db.query(`SELECT GREATEST(($1::date - ($2 || ' months')::interval)::date, $3::date)::text AS lo`, [hi, filters.months, minDate])
    ).rows[0].lo;
  }

  const wx = filters.weather !== "all" ? filters.weather : null;
  let rawMinutes: (number | null)[];

  if (filters.type === "accident") {
    let severityClause = "";
    if (filters.severity === "pdo") severityClause = "AND number_of_injured = 0 AND number_of_fatality = 0";
    else if (filters.severity === "injury") severityClause = "AND number_of_injured > 0 AND number_of_fatality = 0";
    else if (filters.severity === "fatal") severityClause = "AND number_of_fatality > 0";

    const { rows } = await db.query(
      `WITH wxall AS (
         SELECT (timestamp_utc + interval '8 hours')::date AS d,
                EXTRACT(hour FROM timestamp_utc + interval '8 hours')::int AS h,
                AVG(rainfall) > 0.3 AS wet
         FROM hourly_weather
         WHERE (timestamp_utc + interval '8 hours')::date BETWEEN $1 AND $2
         GROUP BY 1, 2
       )
       -- site_cleared, NOT blockage_cleared -- see this file's "Clearance
       -- method" note: blockage_cleared equals event_start_date
       -- exactly (0-minute "clearance") in 21-32% of rows across every
       -- severity, a spike no real road-reopening-time distribution would
       -- produce, consistent with a data-entry default rather than a
       -- genuine timestamp. Reverted after checking.
       SELECT EXTRACT(EPOCH FROM (e.site_cleared - e.event_start_date)) / 60.0 AS raw_duration_min
       FROM silver.nlex_accident_events_clean e
       WHERE e.event_start_date::date BETWEEN $1 AND $2
         ${severityClause}
         AND ($3::text IS NULL OR EXISTS (
           SELECT 1 FROM wxall w WHERE w.d = e.event_start_date::date AND w.h = EXTRACT(hour FROM e.event_start_date)::int AND w.wet = ($3 = 'wet')
         ))`,
      [lo, hi, wx],
    );
    rawMinutes = rows.map((r: { raw_duration_min: string | null }) => (r.raw_duration_min == null ? null : Number(r.raw_duration_min)));
  } else {
    // Breakdown: same deployments-array derivation incident.service.ts
    // uses for its own breakdown MTTC -- last departure across every
    // logged unit, minus the encoded report time. Only events that HAVE a
    // deployments log with at least one real departure_time contribute;
    // see method[] for what that excludes.
    const { rows } = await db.query(
      `WITH wxall AS (
         SELECT (timestamp_utc + interval '8 hours')::date AS d,
                EXTRACT(hour FROM timestamp_utc + interval '8 hours')::int AS h,
                AVG(rainfall) > 0.3 AS wet
         FROM hourly_weather
         WHERE (timestamp_utc + interval '8 hours')::date BETWEEN $1 AND $2
         GROUP BY 1, 2
       ),
       scoped AS (
         SELECT b.event_number, b.event_encoded_date, b.deployments
         FROM silver.nlex_breakdown_events_clean b
         WHERE b.event_encoded_date::date BETWEEN $1 AND $2
           AND ($3::text IS NULL OR EXISTS (
             SELECT 1 FROM wxall w WHERE w.d = b.event_encoded_date::date AND w.h = EXTRACT(hour FROM b.event_encoded_date)::int AND w.wet = ($3 = 'wet')
           ))
       ),
       per_event AS (
         SELECT s.event_number, s.event_encoded_date,
                MAX(NULLIF(d->>'departure_time', '')::timestamp) AS last_departure
         FROM scoped s, jsonb_array_elements(s.deployments) d
         WHERE s.deployments IS NOT NULL
           AND d->>'departure_time' IS NOT NULL AND d->>'departure_time' <> ''
         GROUP BY s.event_number, s.event_encoded_date
       )
       SELECT EXTRACT(EPOCH FROM (last_departure - event_encoded_date)) / 60.0 AS raw_duration_min
       FROM per_event`,
      [lo, hi, wx],
    );
    rawMinutes = rows.map((r: { raw_duration_min: string | null }) => (r.raw_duration_min == null ? null : Number(r.raw_duration_min)));
  }

  return { lo, hi, rawMinutes };
}

export async function getClearanceProtocolFromDb(filters: ClearanceProtocolFilters): Promise<ClearanceProtocolResult | null> {
  if (!db) return null;

  const cacheKey = sampleKey(filters);
  const cached = clearanceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data as ClearanceProtocolResult;

  try {
    const { lo, hi, rawMinutes } = await getClearanceSample(filters);

    const observations = toObservations(rawMinutes);
    const sampleSize = observations.length;
    const censoredCount = observations.filter((o) => o.censored).length;
    const scoringWindow = { from: lo, to: hi };

    if (sampleSize < 30) {
      const data: ClearanceProtocolInsufficientData = {
        status: "insufficient_data",
        sampleSize,
        scoringWindow,
        message: `Only ${sampleSize} ${filters.type}${filters.type === "accident" && filters.severity !== "all" ? ` (${filters.severity})` : ""} event${sampleSize === 1 ? "" : "s"} with a usable clearance duration in this Range/weather combination — below the 30-event floor for a trustworthy survival curve.`,
      };
      clearanceCache.set(cacheKey, { at: Date.now(), data });
      return data;
    }

    const curve = kaplanMeier(observations);
    const p25 = quantileFromCurve(curve, 0.25);
    const p50 = quantileFromCurve(curve, 0.5);
    const p80 = quantileFromCurve(curve, 0.8);
    const p95 = quantileFromCurve(curve, 0.95);

    const rule = escalationRule(curve, observations, p50, p80);
    const pct = (x: number) => Math.round(x * 100);
    const text = `If not cleared by ${Math.round(p50)} min, there is a ${pct(rule.chance.p)}% chance it runs past ${Math.round(p80)} min → escalate.`;
    const checkpoints: Checkpoint[] = [
      checkpointAt(curve, observations, "P25", p25, p95),
      checkpointAt(curve, observations, "P50", p50, p95),
      checkpointAt(curve, observations, "P80", p80, p95),
    ];

    const baselineMttr = restrictedMean(curve);
    const metricLabel =
      filters.type === "accident"
        ? "Scene fully cleared - report time (overstates lane-clearance slightly)"
        : "Last responder departs scene (not lane-clearance time)";

    const method: string[] = [
      filters.type === "accident"
        ? "Accident clearance: event_start_date -> site_cleared (scene fully cleared). blockage_cleared was not used: it equals the start time exactly in 21-32% of rows at every severity, a data-entry default, so site_cleared slightly overstates lane-clearance time."
        : "Breakdown clearance: report time -> the last logged unit's departure. Only breakdowns with a deployments log can be timed (about 31%); the rest are left out. There is no lane-reopened time for breakdowns, so this is not lane clearance.",
      `Durations over 1,440 min are kept as still open at 1,440 (${censoredCount} of ${sampleSize}), not dropped; 0-minute and negative durations are recording errors and left out.`,
      "The chance and its 95% range are the Kaplan-Meier curve's conditional survival S(P80) / S(P50) with Greenwood's variance.",
    ];

    const data: ClearanceProtocolOk = {
      status: "ok",
      rule: { ...rule, text },
      checkpoints,
      survivalCurve: curve,
      quantiles: { p50, p80, p95 },
      kpi: { baselineMttr, rag: ragFor(filters.type, baselineMttr), targets: KPI_TARGETS[filters.type], metricLabel, indicative: filters.type === "breakdown" },
      method,
      scoringWindow,
      sampleSize,
      censoredCount,
    };

    clearanceCache.set(cacheKey, { at: Date.now(), data });
    return data;
  } catch (error) {
    console.error("Database query failed for clearance protocol:", error);
    return null;
  }
}
