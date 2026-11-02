import { db } from "../config/db.js";
import { solve } from "yalps";
import { getIncidentPredictiveAnchors, getIncidentPredictiveFromDb } from "./incident.service.js";

// ---------------------------------------------------------------------------
// Incident → Prescriptive: Clearance Response Protocol.
//
// Answers a different question than PrescriptiveDeploymentPanel (where to
// station units) or PatrolAlertWindowPanel (when to be on alert): given an
// incident has just been reported, how many units to dispatch now, and
// whether/how much to escalate at a fixed decision point, to minimize the
// combined cost of unit-hours and downstream queue delay.
//
// Method, end to end:
//   1. Kaplan-Meier clearance-time curve from real per-event durations
//      (silver.nlex_accident_events_clean / silver.nlex_breakdown_events_clean),
//      right-censored at 1440 min rather than dropped — see
//      toObservations()'s own comment for why this differs from the
//      Descriptive tab's MTTC, which drops invalid rows outright.
//   2. The curve is cut into 4 scenarios (fast/typical/slow/extreme) at its
//      own P50/P80/P95 — not fixed cutoffs, so a corridor with a
//      slower-clearing mix gets wider bands automatically.
//   3. A two-stage stochastic MILP (YALPS): dispatch x units now (first
//      stage), optionally escalate by e more at tau = P50 once the operator
//      learns the incident outnumbered a "fast" one (second stage,
//      scenario-dependent recourse).
//   4. EVPI/VSS compare the stochastic solution against perfect-information
//      and mean-value baselines -- the evidence that solving this
//      stochastically, not with one average duration, is worth doing.
// ---------------------------------------------------------------------------

type CacheEntry = { at: number; data: unknown };
const clearanceCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export type ClearanceType = "accident" | "breakdown";
export type ClearanceSeverity = "all" | "pdo" | "injury" | "fatal";
export type ClearanceWeather = "all" | "dry" | "wet";
export type ClearanceDemandLevel = "offpeak" | "normal" | "peak";

export type ClearanceProtocolFilters = {
  type: ClearanceType;
  severity: ClearanceSeverity;
  weather: ClearanceWeather;
  months: "3" | "12" | "all";
  from?: string;
  to?: string;
  maxUnits: number;
  unitCostPerHour: number;
  delayCostPerVehHour: number;
  unitEffect: number;
  demandLevel: ClearanceDemandLevel;
  deltaResponseMin: number;
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

/**
 * Deterministic vertical-queueing delay for a temporary capacity drop:
 * total delay (veh-hr) = D^2 (q-cr)(c-cr) / (2(c-q)), D in HOURS.
 * Guards: q must stay below c (capped here, flagged) or the formula
 * diverges/goes negative; if demand never exceeds the REDUCED capacity
 * (q <= cr), no queue forms at all and delay is exactly 0, not negative.
 */
export function queueDelayVehHours(durationMin: number, q: number, c: number, cr: number): { delayVehHours: number; qCapped: boolean } {
  let qq = q;
  let qCapped = false;
  if (qq >= c) {
    qq = c * 0.999;
    qCapped = true;
  }
  if (qq <= cr) return { delayVehHours: 0, qCapped };
  const hours = durationMin / 60;
  const delayVehHours = (hours * hours * (qq - cr) * (c - cr)) / (2 * (c - qq));
  return { delayVehHours, qCapped };
}

/**
 * Effective (real) clearance duration with x units deployed from t=0 and
 * optionally e more added at the real decision time tau. Worked in raw
 * "1-unit-equivalent minutes" of work, not compressed time, specifically to
 * avoid a bug an earlier version of this function had: applying
 * baseRate(x) to the whole duration and THEN a separate (1+beta*e) factor to
 * the post-tau remainder compounds the two multiplicatively (e.g.
 * baseRate(3)=1.5 then x1.25 for e=1 gives an effective 1.875x speedup),
 * which can exceed baseRate(x+e) (1.75x for x+e=4) -- i.e. it let adding ONE
 * more unit partway through a response outperform having deployed that same
 * total headcount from t=0, which is physically backwards (staging units
 * can never beat having them all there from the start) and silently broke
 * EVPI>=0 the moment a real scenario set made escalation competitive, since
 * the two-stage solve could then look better than even the perfect-
 * information baseline. The fix: the post-tau portion is rated at
 * baseRate(x+e) -- total headcount present at that point, not a second
 * multiplier stacked on top of x's own rate.
 *
 * x units complete tauMin*baseRate(x) raw minutes of work by the real time
 * tau. If that already covers the whole incident, it cleared before the
 * operator ever had to decide on escalation (D/baseRate(x) <= tau) --
 * matching "fast scenarios end before tau" at the x-adjusted level, not
 * just the raw scenario level. Otherwise the remaining raw work is finished
 * at the combined (x+e)-unit rate.
 */
export function effectiveDurationMin(durationMin: number, tauMin: number, x: number, e: number, beta: number): number {
  const baseRateX = 1 + beta * (x - 1);
  const workDoneByTau = tauMin * baseRateX;
  if (workDoneByTau >= durationMin) return durationMin / baseRateX;
  const remainingWork = durationMin - workDoneByTau;
  const baseRateXE = 1 + beta * (x + e - 1);
  return tauMin + remainingWork / baseRateXE;
}

export type CapacityConfig = { q: number; c: number; cr: number };

/** The single-scenario, no-recourse cost of flatly deploying x units for a
 *  KNOWN duration -- the "if we'd known which scenario it was" sub-problem
 *  WS and EEV are both built from. */
function flatCost(x: number, durationMin: number, beta: number, unitCostPerHour: number, delayCostPerVehHour: number, cap: CapacityConfig): number {
  const eff = durationMin / (1 + beta * (x - 1));
  const { delayVehHours } = queueDelayVehHours(eff, cap.q, cap.c, cap.cr);
  return x * unitCostPerHour * (eff / 60) + delayCostPerVehHour * delayVehHours;
}

function solveDeterministic(durationMin: number, maxUnits: number, beta: number, unitCostPerHour: number, delayCostPerVehHour: number, cap: CapacityConfig): { x: number; cost: number } {
  let best = { x: 1, cost: Infinity };
  for (let x = 1; x <= maxUnits; x++) {
    const cost = flatCost(x, durationMin, beta, unitCostPerHour, delayCostPerVehHour, cap);
    if (cost < best.cost) best = { x, cost };
  }
  return best;
}

/** For a FIXED x, the cheapest escalation e for one scenario -- exactly the
 *  per-(x,s) term the two-stage MILP's objective minimizes over e, factored
 *  out so EEV can reuse it below without re-solving the whole MILP. */
function bestRecourseCost(x: number, s: ScenarioDef, tauMin: number, maxUnits: number, beta: number, unitCostPerHour: number, delayCostPerVehHour: number, cap: CapacityConfig): number {
  let best = Infinity;
  for (let e = 0; e <= maxUnits - x; e++) {
    const eff = effectiveDurationMin(s.durationMin, tauMin, x, e, beta);
    const afterTauHr = Math.max(eff - tauMin, 0) / 60;
    const { delayVehHours } = queueDelayVehHours(eff, cap.q, cap.c, cap.cr);
    const cost = (x + e) * unitCostPerHour * afterTauHr + delayCostPerVehHour * delayVehHours;
    if (cost < best) best = cost;
  }
  return best;
}

/** firstStageCost(x) + Sum_s p_s * bestRecourseCost(x,s,...) -- the exact
 *  function the MILP minimizes over x. RP (the MILP's optimum) is this
 *  function's minimum by construction, so evaluating it at any OTHER fixed
 *  x (as EEV does, at the mean-value-optimal x) can only come out >= RP --
 *  this is what guarantees VSS = EEV - RP >= 0 mathematically, not just
 *  empirically. */
function totalCostAtFixedX(x: number, scenarios: ScenarioDef[], tauMin: number, maxUnits: number, beta: number, unitCostPerHour: number, delayCostPerVehHour: number, cap: CapacityConfig): number {
  const firstStage = x * unitCostPerHour * (tauMin / 60);
  return firstStage + scenarios.reduce((sum, s) => sum + s.probability * bestRecourseCost(x, s, tauMin, maxUnits, beta, unitCostPerHour, delayCostPerVehHour, cap), 0);
}

export type ProtocolSolution = {
  unitsAtDispatch: number;
  escalationByScenario: Record<ScenarioLabel, number>;
  scenarioResults: { label: ScenarioLabel; effectiveDurationMin: number; delayVehHours: number }[];
  rp: number;
  evpi: number;
  vss: number;
};

/**
 * The two-stage stochastic MILP. Binary z_x (first stage, Sum z_x = 1) picks
 * the dispatch size; binary w_{x,s,e} (second stage, Sum_e w_{x,s,e} = z_x
 * for every x,s) picks each scenario's escalation IF x was chosen -- the
 * equality both forces exactly one e per (chosen x, scenario) and forces
 * every w for a non-chosen x to 0. Fast scenarios only get an e=0 variable,
 * realizing "no escalation is possible before tau" as a modelling
 * restriction rather than a separate constraint.
 *
 * Objective: z_x carries the flat, scenario-independent cost of committing
 * x units through the tau-minute observation window (paid regardless of how
 * the incident turns out); each w_{x,s,e} carries that scenario's p_s-
 * weighted cost of keeping x units (and any e escalation units) on scene
 * beyond tau, plus the delay its effective duration causes.
 */
export function solveClearanceProtocol(
  scenarios: ScenarioDef[],
  tauMin: number,
  maxUnits: number,
  beta: number,
  unitCostPerHour: number,
  delayCostPerVehHour: number,
  cap: CapacityConfig,
): ProtocolSolution {
  const constraints: Record<string, { min?: number; max?: number; equal?: number }> = { pick_x: { equal: 1 } };
  const variables: Record<string, Record<string, number>> = {};

  for (let x = 1; x <= maxUnits; x++) {
    variables[`z${x}`] = { pick_x: 1, cost: x * unitCostPerHour * (tauMin / 60) };
  }

  for (let x = 1; x <= maxUnits; x++) {
    for (const s of scenarios) {
      const linkKey = `link_${x}_${s.label}`;
      constraints[linkKey] = { equal: 0 };
      variables[`z${x}`][linkKey] = -1;
      const esAllowed = s.label === "fast" ? [0] : Array.from({ length: maxUnits - x + 1 }, (_, i) => i);
      for (const e of esAllowed) {
        const eff = effectiveDurationMin(s.durationMin, tauMin, x, e, beta);
        const afterTauHr = Math.max(eff - tauMin, 0) / 60;
        const { delayVehHours } = queueDelayVehHours(eff, cap.q, cap.c, cap.cr);
        const cost = s.probability * ((x + e) * unitCostPerHour * afterTauHr + delayCostPerVehHour * delayVehHours);
        variables[`w_${x}_${s.label}_${e}`] = { [linkKey]: 1, cost };
      }
    }
  }

  const solution = solve({ direction: "minimize", objective: "cost", constraints, variables, binaries: true });
  const chosenX = Number(
    solution.variables.find(([k, v]: [string, number]) => k.startsWith("z") && v > 0.5)?.[0].slice(1) ?? 1,
  );
  const escalationByScenario = {} as Record<ScenarioLabel, number>;
  const scenarioResults: ProtocolSolution["scenarioResults"] = [];
  for (const s of scenarios) {
    const prefix = `w_${chosenX}_${s.label}_`;
    const chosenW = solution.variables.find(([k, v]: [string, number]) => k.startsWith(prefix) && v > 0.5)?.[0];
    const e = chosenW ? Number(chosenW.slice(prefix.length)) : 0;
    escalationByScenario[s.label] = e;
    const eff = effectiveDurationMin(s.durationMin, tauMin, chosenX, e, beta);
    const { delayVehHours } = queueDelayVehHours(eff, cap.q, cap.c, cap.cr);
    scenarioResults.push({ label: s.label, effectiveDurationMin: eff, delayVehHours });
  }

  const rp = solution.status === "optimal" ? solution.result : Infinity;

  // WS (wait-and-see): solve each scenario separately with perfect
  // foreknowledge of its duration, weighted by probability.
  const ws = scenarios.reduce((sum, s) => sum + s.probability * solveDeterministic(s.durationMin, maxUnits, beta, unitCostPerHour, delayCostPerVehHour, cap).cost, 0);
  const evpi = rp - ws;

  // EEV (expected value of the mean-value solution): pick the single best x
  // for the PROBABILITY-WEIGHTED MEAN duration (the "if we just planned for
  // the average incident" x), then see what that FIXED x truly costs when
  // each real scenario still gets its own optimal escalation -- using
  // flatCost (no recourse) here would understate EEV relative to RP (which
  // does get recourse) and could make VSS come out negative, which is
  // mathematically impossible for a correct solve; totalCostAtFixedX keeps
  // the comparison apples-to-apples.
  const meanDuration = scenarios.reduce((sum, s) => sum + s.probability * s.durationMin, 0);
  const meanValueX = solveDeterministic(meanDuration, maxUnits, beta, unitCostPerHour, delayCostPerVehHour, cap).x;
  const eev = totalCostAtFixedX(meanValueX, scenarios, tauMin, maxUnits, beta, unitCostPerHour, delayCostPerVehHour, cap);
  const vss = eev - rp;

  return { unitsAtDispatch: chosenX, escalationByScenario, scenarioResults, rp, evpi, vss };
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
// Capacity/demand config — no Mejia & Sigua capacity-drop factor, lane
// capacity, or hourly segment-demand forecast exists anywhere in this
// warehouse (confirmed by search, Phase 1). These are therefore stated
// config defaults, not fitted or measured -- surfaced in `assumptions`
// below and in the UI, never presented as data.
// ---------------------------------------------------------------------------

const LANE_CAPACITY_VEH_HR = 2000;
const LANES_PER_DIRECTION = 3;
const CAPACITY_VEH_HR = LANE_CAPACITY_VEH_HR * LANES_PER_DIRECTION; // 6000 veh/hr
const REDUCED_CAPACITY_FACTOR = 0.5;
const REDUCED_CAPACITY_VEH_HR = CAPACITY_VEH_HR * REDUCED_CAPACITY_FACTOR; // 3000 veh/hr
const DEMAND_VC_RATIO: Record<ClearanceDemandLevel, number> = { offpeak: 0.5, normal: 0.7, peak: 0.9 };

const DEFAULT_UNIT_COST_PER_HOUR = 1500; // PHP/hr per unit — illustrative, not from the warehouse
const DEFAULT_DELAY_COST_PER_VEH_HOUR = 300; // PHP/veh-hr — illustrative value-of-time proxy
const DEFAULT_UNIT_EFFECT_BETA = 0.25;
const DEFAULT_DELTA_RESPONSE_MIN = 15; // minutes — see deriveUncoveredIncidentCost's own comment

export { DEFAULT_UNIT_COST_PER_HOUR, DEFAULT_DELAY_COST_PER_VEH_HOUR, DEFAULT_UNIT_EFFECT_BETA, DEFAULT_DELTA_RESPONSE_MIN, CAPACITY_VEH_HR, REDUCED_CAPACITY_VEH_HR };

/**
 * Coverage opportunity cost: a unit committed to this incident isn't on
 * patrol elsewhere, so it isn't suppressing/covering whatever incidents its
 * own zone would otherwise see -- the same tradeoff
 * PrescriptiveDeploymentPanel's covering-location solve is built around,
 * just priced here instead of optimized spatially. Without this, the model
 * only weighs unit-hours against downstream queue delay, and more units are
 * nearly always worth it (confirmed empirically: the MILP picked max units
 * in every tested configuration before this existed) -- a trivial "send
 * everything" corner solution that doesn't reflect a real fleet being finite.
 *
 * Rate = (expected incidents/hr in one "average" coverage zone, from the
 * SAME forecast PrescriptiveDeploymentPanel uses) x (a DERIVED cost per
 * incident that zone goes uncovered for -- not a flat guess). See
 * deriveUncoveredIncidentCost for the derivation. incidentsPerHourPerUnit
 * returns null (coverage cost skipped, flagged in assumptions) only once a
 * retry has also come back empty -- see the cache below for why a single
 * null here used to be worse than it looked.
 *
 * Cached on its own, separately from clearanceCache: this call takes no
 * filters (always {weather:"all", months:"12"}), so every distinct
 * accident/severity/weather/demandLevel/slider combination the operator
 * tries was re-running the SAME heavy nested forecast query -- the one
 * /api/incident/predictive keeps warm for everyone else via server.ts's
 * cache warmer -- because this is a direct function call, not an HTTP
 * request, so it never touched that warm HTTP-level cache. That made EVERY
 * new control combination pay the forecast's full cold cost (seconds, per
 * the warmer's own measurements) on top of this file's own KM/MILP work,
 * which is the main reason Clearance Response Protocol felt unreliable and
 * "stuck" after a control change -- a slow request with no distinct answer
 * to show yet, not a different one failing to arrive.
 *
 * Worse, a transient null used to be indistinguishable from a genuinely
 * empty pipeline: getClearanceProtocolFromDb would fold it into a
 * "coverage cost skipped" response that still reports success, and that
 * whole response is then cached for real -- not just by clearanceCache's
 * 10-minute TTL, but by the generic /api route cache in
 * middleware/route-cache.ts, which stores any 200 JSON body for 3 hours.
 * That is the same shape of bug already fixed once on the Predictive tab:
 * a resolved null persisted as if it were the real, final answer. The retry
 * below plus caching only a real number (never null) closes it here too --
 * null is now only ever returned, and only ever reaches that 3-hour cache,
 * after two attempts both come back empty, which is a much stronger signal
 * that the pipeline genuinely has no output yet rather than one cold query.
 */
type RateCacheEntry = { at: number; value: number };
let rateCache: RateCacheEntry | null = null;
const RATE_CACHE_TTL_MS = 10 * 60 * 1000;
/* Single-flight for the nested forecast (19 Oct 2026, testers IN-15..IN-21: "not loading or reflecting
   changes"). Each slider step is a different URL, so the route cache's own per-URL single-flight never
   coalesced them: dragging Max units 1 -> 6 on a cold rate cache started five copies of this ~3 s forecast
   read at once, plus each one's own sample query, against a pool of ten -- the request the operator
   actually wanted (the last one) queued behind four it no longer needed. One shared promise now. */
let rateInflight: Promise<number | null> | null = null;

async function computeIncidentsPerHourPerUnit(): Promise<number | null> {
  const anchors = await getIncidentPredictiveAnchors();
  if (!anchors) return null;
  // months is NOT optional in practice despite the type: omitting it (even
  // though IncidentPredictiveFilters marks it optional) returns
  // success:true with corridorForecast missing -- confirmed by direct test
  // against the live endpoint. "12" matches PrescriptiveDeploymentPanel's
  // own default Range.
  const predictive = await getIncidentPredictiveFromDb({ weather: "all", months: "12" }, anchors);
  if (!predictive || !predictive.corridorForecast || predictive.corridorForecast.length === 0) return null;
  const totalPredicted = predictive.corridorForecast.reduce((s, x) => s + x.predictedIncidents, 0);
  const horizonHours = predictive.corridorForecastDays * 24;
  const numZones = predictive.corridorForecast.length;
  if (horizonHours <= 0 || numZones <= 0) return null;
  return totalPredicted / horizonHours / numZones;
}

async function refreshIncidentsPerHourPerUnit(): Promise<number | null> {
  let result = await computeIncidentsPerHourPerUnit();
  if (result == null) {
    // One short retry before accepting "no output yet" -- cheap (only runs
    // on a cache miss that also came back empty) and turns a cold-start
    // blip into a transparent extra few hundred ms instead of a silently
    // degraded answer that then gets cached for hours.
    await new Promise((r) => setTimeout(r, 300));
    result = await computeIncidentsPerHourPerUnit();
  }
  if (result == null) return null; // genuinely nothing to cache yet

  rateCache = { at: Date.now(), value: result };
  return result;
}

async function getIncidentsPerHourPerUnit(): Promise<number | null> {
  if (rateCache && Date.now() - rateCache.at < RATE_CACHE_TTL_MS) return rateCache.value;

  if (!rateInflight) {
    rateInflight = refreshIncidentsPerHourPerUnit()
      .catch(() => null)
      .finally(() => {
        rateInflight = null;
      });
  }
  // Expired but present: answer with the last real rate now and let the
  // refresh above land for the next request. The forecast behind it is
  // rewritten by a weekly retrain, so a rate a few minutes past its TTL is
  // still the right one -- whereas waiting on it made the first control
  // change after every ten-minute lull pay the full ~3 s forecast read.
  if (rateCache) return rateCache.value;
  return rateInflight;
}

// ---------------------------------------------------------------------------
// The clearance-duration sample, cached on the filters that actually select it
// ---------------------------------------------------------------------------

/* Only type/severity/weather/Range pick WHICH events go into the curve. Demand level, Max units, beta and
   delta change only the in-memory KM-to-MILP arithmetic (~0.1 s), yet clearanceCache is keyed on every
   filter, so each slider step re-ran the bounds query and the event scan -- 1.5-2.7 s per step with
   weather Wet/Dry or type Breakdown (the hourly_weather join and the deployments JSON unnest), the
   "graphs and info do not change with the controls" testers saw while a drag queued up. Cached and
   single-flighted here on just those four, so a slider is pure compute once its sample is read. */
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

/**
 * What one incident going "uncovered" actually costs, derived from the SAME
 * queueing model already in this file rather than a flat guess: if the
 * nearest unit is committed elsewhere, a new incident in its zone waits an
 * extra deltaResponseMin before a (farther) unit reaches it, which (via the
 * same deterministic-queue formula) adds delay(D+deltaResponseMin) -
 * delay(D) extra vehicle-hours to THAT incident's own queue -- valued at the
 * same delayCostPerVehHour already in use. D is the scenario-weighted
 * expected clearance duration (not the chosen protocol's duration -- that
 * would be circular, since this cost feeds INTO the choice of protocol).
 * Deliberately NOT tuned to produce a particular (x, escalation) outcome:
 * every input is either already a model parameter or the stated
 * deltaResponseMin assumption.
 */
function deriveUncoveredIncidentCost(meanDurationMin: number, deltaResponseMin: number, delayCostPerVehHour: number, cap: CapacityConfig): number {
  const delayAtD = queueDelayVehHours(meanDurationMin, cap.q, cap.c, cap.cr).delayVehHours;
  const delayAtDPlusDelta = queueDelayVehHours(meanDurationMin + deltaResponseMin, cap.q, cap.c, cap.cr).delayVehHours;
  return delayCostPerVehHour * (delayAtDPlusDelta - delayAtD);
}

// ---------------------------------------------------------------------------
// DB-backed orchestrator
// ---------------------------------------------------------------------------

export type ClearanceProtocolOk = {
  status: "ok";
  recommendation: {
    unitsAtDispatch: number;
    escalateAtMinute: number;
    escalationUnitsByScenario: Record<ScenarioLabel, number>;
    action: string;
    when: string;
    effect: string;
    confidence: string;
  };
  survivalCurve: SurvivalPoint[];
  quantiles: { p50: number; p80: number; p95: number };
  scenarios: { label: ScenarioLabel; probability: number; durationMin: number; delayVehHours: number; recourseUnits: number; effectiveDurationMin: number }[];
  kpi: {
    projectedMttr: number;
    baselineMttr: number;
    rag: "green" | "amber" | "red";
    targets: { greenMax: number; amberMax: number };
    /** What the duration above actually measures — accident: real lane-clearance proxy; breakdown: last unit departure, NOT lane clearance. */
    metricLabel: string;
    /** True for breakdowns: the warehouse has no "lane reopened" timestamp for them, so RAG is a proxy reading, not a direct one. */
    indicative: boolean;
  };
  evpi: number;
  vss: number;
  /** False when the forecast behind the coverage-opportunity cost was unavailable: the answer is real but
   *  degraded, so the controller keeps it out of the 3-hour route cache and the next request tries again. */
  coverageCostApplied: boolean;
  assumptions: string[];
  sensitivity: { beta: number; delayCostMultiplier: number; unitsAtDispatch: number; maxEscalation: number }[];
  deltaSensitivity: { deltaResponseMin: number; unitsAtDispatch: number; maxEscalation: number; derivedCostPerUncoveredIncident: number }[];
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
       -- method" assumption: blockage_cleared equals event_start_date
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
    // see assumptions[] for what that excludes.
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

  const cacheKey = JSON.stringify(filters);
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
    const rawEvents = observations.filter((o) => !o.censored).map((o) => o.duration);
    const { scenarios, p50, p80, p95 } = buildScenarios(curve, rawEvents);

    const cap: CapacityConfig = {
      q: CAPACITY_VEH_HR * DEMAND_VC_RATIO[filters.demandLevel],
      c: CAPACITY_VEH_HR,
      cr: REDUCED_CAPACITY_VEH_HR,
    };

    // Coverage opportunity cost, derived (not a flat guess -- see
    // deriveUncoveredIncidentCost) and folded into one combined
    // per-unit-hour rate (see getIncidentsPerHourPerUnit's own comment) --
    // the solver's cost terms are all already structured as (units x rate x
    // hours), so this keeps every first- and second-stage cost term correct
    // without touching the MILP-building code itself, and still "keeps the
    // existing hourly unit cost" exactly as asked, additively.
    const incidentsPerHourPerUnit = await getIncidentsPerHourPerUnit();
    const meanDurationMin = scenarios.reduce((sum, s) => sum + s.probability * s.durationMin, 0);

    // delayCostPerVehHour is an input to the derivation itself (the derived
    // cost is valued at that same rate), so when sweeping it in sensitivity
    // below, the coverage-cost term is recomputed too, not held at the base
    // rate -- otherwise a "2x delay cost" row would be internally
    // inconsistent with its own coverage-cost component.
    const effectiveRate = (delayCostPerVehHour: number, deltaResponseMin: number) => {
      const derivedCost = deriveUncoveredIncidentCost(meanDurationMin, deltaResponseMin, delayCostPerVehHour, cap);
      const coverageRate = incidentsPerHourPerUnit != null ? incidentsPerHourPerUnit * derivedCost : 0;
      return { rate: filters.unitCostPerHour + coverageRate, derivedCost };
    };

    const { rate: effectiveUnitCostPerHour, derivedCost: derivedCostPerUncoveredIncident } = effectiveRate(filters.delayCostPerVehHour, filters.deltaResponseMin);

    const solution = solveClearanceProtocol(scenarios, p50, filters.maxUnits, filters.unitEffect, effectiveUnitCostPerHour, filters.delayCostPerVehHour, cap);

    // Sensitivity strip 1: does the recommendation hold up across a
    // reasonable spread of the two parameters that are pure assumptions
    // (beta) or illustrative (delay cost)? Coverage cost is recomputed per
    // delay-cost multiplier (see effectiveRate above); deltaResponseMin is
    // held at the request's own value.
    const SENSITIVITY_BETAS = [0.1, 0.15, 0.25, 0.35, 0.5];
    const SENSITIVITY_DELAY_MULTIPLIERS = [0.5, 1, 2];
    const sensitivity = SENSITIVITY_BETAS.flatMap((b) =>
      SENSITIVITY_DELAY_MULTIPLIERS.map((m) => {
        const dcph = filters.delayCostPerVehHour * m;
        const { rate } = effectiveRate(dcph, filters.deltaResponseMin);
        const sol = solveClearanceProtocol(scenarios, p50, filters.maxUnits, b, rate, dcph, cap);
        const maxEscalation = Math.max(0, ...Object.values(sol.escalationByScenario));
        return { beta: b, delayCostMultiplier: m, unitsAtDispatch: sol.unitsAtDispatch, maxEscalation };
      }),
    );

    // Sensitivity strip 2: deltaResponseMin, the one new assumption this
    // round introduced, swept on its own (beta/delay cost held at the
    // request's own values) rather than crossed into strip 1 -- a 5x3x3
    // table stops being "compact."
    const SENSITIVITY_DELTA_RESPONSE = [5, 15, 30];
    const deltaSensitivity = SENSITIVITY_DELTA_RESPONSE.map((delta) => {
      const { rate, derivedCost } = effectiveRate(filters.delayCostPerVehHour, delta);
      const sol = solveClearanceProtocol(scenarios, p50, filters.maxUnits, filters.unitEffect, rate, filters.delayCostPerVehHour, cap);
      const maxEscalation = Math.max(0, ...Object.values(sol.escalationByScenario));
      return { deltaResponseMin: delta, unitsAtDispatch: sol.unitsAtDispatch, maxEscalation, derivedCostPerUncoveredIncident: derivedCost };
    });

    const projectedMttr = scenarios.reduce((sum, s, i) => sum + s.probability * solution.scenarioResults[i].effectiveDurationMin, 0);
    const baselineMttr = restrictedMean(curve);
    const rag = ragFor(filters.type, projectedMttr);
    const targets = KPI_TARGETS[filters.type];
    const metricLabel =
      filters.type === "accident"
        ? "Scene fully cleared - report time (overstates lane-clearance slightly)"
        : "Last responder departs scene (not lane-clearance time)";

    const escalatedScenarios = scenarios.filter((s) => solution.escalationByScenario[s.label] > 0).map((s) => s.label);
    const action =
      escalatedScenarios.length > 0
        ? `Dispatch ${solution.unitsAtDispatch} unit${solution.unitsAtDispatch === 1 ? "" : "s"}; escalate if not cleared by minute ${Math.round(p50)} (${escalatedScenarios.join(", ")} scenarios add ${escalatedScenarios.map((l) => solution.escalationByScenario[l]).join("/")} unit${Math.max(...escalatedScenarios.map((l) => solution.escalationByScenario[l])) === 1 ? "" : "s"}).`
        : `Dispatch ${solution.unitsAtDispatch} unit${solution.unitsAtDispatch === 1 ? "" : "s"}; no scenario's expected delay cost justifies escalating further.`;

    const assumptions: string[] = [
      `Unit cost: ${filters.unitCostPerHour} PHP/hr per unit — illustrative, not sourced from the warehouse (no responder operating-cost figure exists in this data).`,
      `Response delay (delta): ${filters.deltaResponseMin} min — stated assumption for how much longer a NEW incident waits when the nearest unit is already committed here. Feeds the derived coverage cost below, not tuned to produce any particular recommendation.`,
      incidentsPerHourPerUnit != null
        ? `Coverage opportunity cost (derived, not a flat guess): delay(${meanDurationMin.toFixed(1)}+${filters.deltaResponseMin} min) - delay(${meanDurationMin.toFixed(1)} min) at this demand level, valued at ${filters.delayCostPerVehHour} PHP/veh-hr, = ${derivedCostPerUncoveredIncident.toFixed(0)} PHP per incident a zone goes uncovered for. x ${incidentsPerHourPerUnit.toFixed(4)} predicted incidents/hr in an average unit's coverage area (same /api/incident/predictive forecast PrescriptiveDeploymentPanel uses) = ${(incidentsPerHourPerUnit * derivedCostPerUncoveredIncident).toFixed(2)} PHP/hr added on top of the raw unit cost above, giving an effective ${effectiveUnitCostPerHour.toFixed(2)} PHP/hr per unit actually used in the solve.`
        : `Coverage opportunity cost: skipped (the predictive forecast pipeline hasn't written output yet) — only the raw ${filters.unitCostPerHour} PHP/hr unit cost above was used.`,
      `Delay cost: ${filters.delayCostPerVehHour} PHP/veh-hr — illustrative value-of-time proxy, not a measured figure.`,
      `Unit effect (beta=${filters.unitEffect}): a stated assumption, not fit from data. The warehouse's own deployment_count is confounded with severity — a prior analysis in this repo (smartflow_scripts/4_studies_audits/incident_response/README.md) found "more units sent goes with longer clearance within each severity, but bigger incidents get more units, so this does not show that units slow or speed clearance."`,
      `Capacity: ${CAPACITY_VEH_HR} veh/hr/direction (${LANE_CAPACITY_VEH_HR} veh/hr/lane x ${LANES_PER_DIRECTION} lanes) — a config default; no Mejia & Sigua capacity-drop factor or lane-capacity figure exists in this warehouse.`,
      `Reduced capacity during the incident: ${REDUCED_CAPACITY_VEH_HR} veh/hr (${REDUCED_CAPACITY_FACTOR * 100}% of capacity) — a config default, not measured.`,
      `Demand: "${filters.demandLevel}" maps to v/c = ${DEMAND_VC_RATIO[filters.demandLevel]} (q = ${Math.round(cap.q)} veh/hr) — a stated level, not a per-segment forecast. nlex_traffic_volume has real hourly counts but only at toll plazas, not at arbitrary incident locations, so it is not proxied in here.`,
      filters.type === "breakdown"
        ? "Breakdown durations come only from events with a deployments log (last departure time recorded) — roughly 31% of all breakdowns in this warehouse have one; the rest cannot be timed and are excluded, not treated as censored."
        : "Accident durations use event_start_date -> site_cleared (full scene cleared) -- see the clearance-method note below.",
      filters.type === "accident"
        ? "Clearance method: event_start_date -> site_cleared. blockage_cleared (road reopened) was tried and reverted: it equals event_start_date exactly (a 0-minute \"clearance\") in 21-32% of rows across EVERY severity (PDO 31.5%, Injury 21.4%, Fatal 30.8%) -- a sharp spike no real road-reopening-time distribution would produce, and not specific to one severity, consistent with a data-entry default rather than a genuine timestamp. site_cleared therefore overstates true road-impact duration somewhat (it includes post-blockage scene cleanup), so RAG here should be read as a conservative (not optimistic) estimate of lane-clearance time, not an exact one."
        : "Clearance method: last logged unit departure_time -> event_encoded_date. This is NOT the same quantity as \"lane cleared\" -- a stalled vehicle's lane can reopen well before the last responder (e.g. a tow truck) actually leaves the scene, and this warehouse has no separate \"road reopened\" timestamp for breakdowns the way accidents do. KPI RAG below is therefore marked indicative, not a direct read of the manuscript's lane-clearance target.",
      `Censoring: durations recomputed from raw timestamps so that >1440 min could be told apart from missing/negative -- >1440 is right-censored at 1440 (${censoredCount} of ${sampleSize} observations here), not dropped. The Descriptive tab's own MTTC instead drops anything outside [0,1440] from its average; this panel's baselineMttr is a restricted-mean (area under the Kaplan-Meier curve), which is why it will not exactly equal the Descriptive tab's figure even on the same filters.`,
    ];

    const data: ClearanceProtocolOk = {
      status: "ok",
      recommendation: {
        unitsAtDispatch: solution.unitsAtDispatch,
        escalateAtMinute: Math.round(p50),
        escalationUnitsByScenario: solution.escalationByScenario,
        action,
        when: `Decision point at minute ${Math.round(p50)} (this set's own median clearance time)`,
        effect: `Projected mean clearance ${projectedMttr.toFixed(1)} min vs a ${baselineMttr.toFixed(1)} min historical baseline`,
        confidence: `n=${sampleSize} (${censoredCount} right-censored at 1440 min)`,
      },
      survivalCurve: curve,
      quantiles: { p50, p80, p95 },
      scenarios: scenarios.map((s, i) => ({
        label: s.label,
        probability: s.probability,
        durationMin: s.durationMin,
        delayVehHours: solution.scenarioResults[i].delayVehHours,
        recourseUnits: solution.escalationByScenario[s.label],
        effectiveDurationMin: solution.scenarioResults[i].effectiveDurationMin,
      })),
      kpi: { projectedMttr, baselineMttr, rag, targets, metricLabel, indicative: filters.type === "breakdown" },
      evpi: solution.evpi,
      vss: solution.vss,
      coverageCostApplied: incidentsPerHourPerUnit != null,
      assumptions,
      sensitivity,
      deltaSensitivity,
      scoringWindow,
      sampleSize,
      censoredCount,
    };

    // A degraded answer (coverage cost skipped) is served but not kept: the next request retries the forecast.
    if (data.coverageCostApplied) clearanceCache.set(cacheKey, { at: Date.now(), data });
    return data;
  } catch (error) {
    console.error("Database query failed for clearance protocol:", error);
    return null;
  }
}
