/**
 * Verification for the scenario catalogue, calibration, assumptions and sampler.
 *
 *   cd Back-End && ./node_modules/.bin/tsx ../Front-End-Dashboard/app/dashboard/ai-sandbox/scenarios/verify.ts
 *
 * Read-only. Exits 1 on any failure. It guards:
 *   1. the sampler really reproduces the calibrated quantiles (durations AND response shares),
 *      is reproducible per seed, caps as told (explicitly, or from the fallback chain) and says so;
 *   2. the breakdown hierarchy falls back in the stated order and only uses cells with enough events,
 *      and the cap comes from the first level in the chain with at least CAP_MIN_N events;
 *   3. the catalogue and assumptions are internally consistent (phases, shares, lanes, lengths);
 *   4. the closure geometry (upstream buffer, wreck length, clamping) behaves as documented;
 *   5. values MIRRORED from elsewhere have not drifted (engine constants, chainage table, the
 *      generator's minimum n) and the generator has no built-in data path.
 */
import { readFileSync } from "node:fs";
import calibrationJson from "./calibration.json";
import { CLASS_META, TrafficSim, type Interventions, type Metrics } from "../simulation";
import { combineBaselines, combineMetrics, flowWeightedSpeed } from "../bothMetrics";
import { drawBorrowedLanes, drawMovableBarrier, drawScenes, drawWater, drawWeather, hasSceneArt, type SceneCtx, type SceneGeometry } from "../sceneArt";
import { borrowedLanes, planZipper, REALLOCATION_NAME, zipperCounts, zipperHolds } from "../zipper";
import { BUS_PAINTS, CAB_PAINTS, CAR_PAINTS, PAINT_WHITE, TRAILER_PAINTS, paintFor, trailerPaintFor, type Paint } from "../vehiclePaint";
import {
  ASSUMPTIONS,
  CHAINAGE_DERIVATION,
  CHAINAGE_OFFSET_KM,
  UPSTREAM_BUFFER_M,
  appKmToChainageKm,
  chainageKmToAppKm,
  closureStretch,
  engineIndexToOperatorLane,
  incidentSlotsFor,
  listAssumptions,
  NLEX_RAIN_FREE_FLOW_KMH,
  operatorLaneToEngineIndex,
  RAIN_INTENSITIES,
  type RainIntensity,
} from "./assumptions";
import {
  NO_OWNERS,
  sceneMarks,
  type SceneMark,
  addEvent,
  applyAtBoundary,
  boundaryTimes,
  canvasMarks,
  composeInterventions,
  createEngineBinding,
  addEventToBucket,
  addTargets,
  directionBucketsConsistent,
  inconsistentBucketMessage,
  wrongCarriagewayMessage,
  MANUAL_CLOSURE_MESSAGE,
  manualClosureMessage,
  SAME_STRETCH_TOL_M,
  describeActiveEvents,
  describeBoundary,
  describeOwner,
  describeResolution,
  describeYield,
  effectiveState,
  eventProblems,
  eventProgress,
  eventState,
  formatClock,
  nextBoundaryAfter,
  NO_CALIBRATION_NOTE,
  ownershipKey,
  phaseAt,
  removeEvent,
  resourceWindows,
  resolutionView,
  roadOf,
  scenarioLockedLanes,
  scenarioTimeS,
  schedulePhases,
  stepToScenarioTime,
  type Direction,
  type EngineBinding,
  type ManualClosure,
  type ManualControls,
  type ManualInterventions,
  type NewEventSpec,
  type Ownership,
  type Road,
  type RoadFrame,
  type ScenarioEvent,
} from "./adapter";
import {
  BREAKDOWN_CAUSES,
  BREAKDOWN_FAMILIES,
  BREAKDOWN_VEHICLES,
  CALIBRATION_KEYS,
  RESOURCE_SHARING,
  SCENARIO_TEMPLATES,
  TEMPLATE_BY_FAMILY,
  calibratedVariantOf,
  calibrationKeyFor,
  causeKey,
  causeVehicleKey,
  defaultOperatorLane,
  NOT_YET_BUILT,
  UNSUPPORTED_FAMILIES,
  defaultVariant,
  phaseOffsetFractions,
  vehicleKey,
  type BreakdownCause,
  type BreakdownFamilyKey,
  type CalibratedVariant,
  type CollisionLabel,
  type EngineResource,
  type FamilyKey,
  type HierarchyKey,
  type ScenarioVariant,
  type VehicleKind,
} from "./catalogue";
import {
  SHARE_SEED_SALT,
  drawDuration,
  getCalibration,
  inverseCdf,
  isLowSample,
  makeRng,
  parseCalibration,
  resolveDuration,
  sampleDuration,
  selectCalibration,
  selectFromCalibration,
  type Calibration,
  type CalibrationEntry,
  type DurationMode,
  type QuantileSet,
} from "./sampler";

let checks = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}
function near(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
/** The message of whatever fn() throws, or null if it does not throw. For asserting WHY, not just that. */
function thrownMessage(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const FAMILIES: readonly FamilyKey[] = ["breakdown_in_lane", "breakdown_shoulder", "minor_collision", "multi_vehicle_collision", "self_accident", "overturned_vehicle", "flood", "scheduled_roadworks", "rain"];
/** Families with a real calibration.json entry: FAMILIES minus NO_CALIBRATION_FAMILIES. */
const CALIBRATED_FAMILIES: readonly FamilyKey[] = FAMILIES.filter((f) => !ASSUMPTIONS.NO_CALIBRATION_FAMILIES.value.some((n) => n === f));
const KNOT_P = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1] as const;
const MIN_N = ASSUMPTIONS.LOW_SAMPLE_N.value;

/* ───────────────────────────── 1. calibration file ───────────────────────────── */
const cal = getCalibration();
const allEntries: CalibrationEntry[] = [
  ...CALIBRATION_KEYS.map((k) => cal.entries[k]),
  ...Object.values(cal.hierarchy).filter((e): e is CalibrationEntry => e !== undefined),
];
check("calibration parses", CALIBRATION_KEYS.every((k) => cal.entries[k].n > 0));
check("parseCalibration rejects a non-object", throws(() => parseCalibration(42)));
check("parseCalibration rejects a missing family", throws(() => parseCalibration({ provenance: {}, families: {} })));
check(`hierarchy min n in the file equals LOW_SAMPLE_N (${MIN_N})`, cal.hierarchyMinN === MIN_N && calibrationJson.provenance.hierarchy.min_n === MIN_N);
check("every hierarchy entry has at least min n usable events", Object.values(cal.hierarchy).every((e) => e !== undefined && e.n >= MIN_N));
check(
  "hierarchy entries are exactly the qualifying non-family cells",
  cal.hierarchyCells.filter((c) => c.level !== "family" && c.qualifies).length === Object.values(cal.hierarchy).length,
);
check("every cell's n is the usable events behind it: family cell n equals the family entry n", BREAKDOWN_FAMILIES.every((f) => cal.hierarchyCells.some((c) => c.level === "family" && c.family === f && c.n === cal.entries[f].n)));
check("breakdown entries carry a response share; accident entries do not", allEntries.every((e) => (e.durationKind === "response_plus_service_min_per_event") === (e.responseShare !== null)));
check("breakdown entries are per-event response + service", BREAKDOWN_FAMILIES.every((f) => cal.entries[f].durationKind === "response_plus_service_min_per_event"));

// A corrupted file must fail loudly, not quietly. Fixtures are edited through typed helpers, no casts.
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function child(o: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = o[key];
  if (!isObj(v)) throw new Error(`fixture: ${key} is not an object`);
  return v;
}
function withEdit(edit: (families: Record<string, unknown>) => void): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(calibrationJson));
  if (!isObj(copy)) throw new Error("fixture: root is not an object");
  edit(child(copy, "families"));
  return copy;
}
check("parse rejects a total whose quantiles decrease", throws(() => parseCalibration(withEdit((f) => { child(f, "self_accident").p90 = 1; }))));
check("parse rejects a share above 1", throws(() => parseCalibration(withEdit((f) => { child(child(f, "breakdown_in_lane"), "response_share").max = 1.5; }))));
check("parse rejects an unknown entry key", throws(() => parseCalibration(withEdit((f) => { f.breakdown_in_lane__cause_bogus = f.breakdown_in_lane; }))));
check("parse rejects an entry for a cell below the hierarchy minimum", throws(() => parseCalibration(withEdit((f) => { f.breakdown_in_lane__vehicle_bus = f.breakdown_in_lane__vehicle_car; }))));
check("parse rejects a breakdown entry with no response share", throws(() => parseCalibration(withEdit((f) => { child(f, "breakdown_shoulder").response_share = null; }))));

/* ───────────────────────────── 2. sampler, every entry ───────────────────────────── */
const N = 100_000;
function knotsOf(q: QuantileSet): readonly number[] {
  return [q.min, q.p10, q.p25, q.p50, q.p75, q.p90, q.p99, q.max];
}
/** Empirical CDF at each interior knot against its probability (compared on probabilities: the p99 VALUE is poorly determined by a sample). */
function cdfMatches(name: string, q: QuantileSet, values: readonly number[]): void {
  const knots = knotsOf(q);
  for (let i = 1; i < KNOT_P.length - 1; i++) {
    const v = knots[i];
    let expected: number = KNOT_P[i];
    for (let j = 0; j < knots.length; j++) if (knots[j] === v) expected = Math.max(expected, KNOT_P[j]);
    let below = 0;
    for (const x of values) if (x <= v) below++;
    const emp = below / values.length;
    const tol = 5 * Math.sqrt((expected * (1 - expected)) / values.length) + 1e-3;
    check(`${name}: empirical CDF at the p${Math.round(KNOT_P[i] * 100)} knot`, near(emp, expected, tol), `got ${emp.toFixed(4)}, want ${expected}`);
  }
}

for (const e of allEntries) {
  const q = e.quantiles;
  const knots = knotsOf(q);
  const name = e.key;

  for (let i = 0; i < KNOT_P.length; i++) check(`${name}: inverseCdf(${KNOT_P[i]}) is the knot`, near(inverseCdf(q, KNOT_P[i]), knots[i], 1e-9));
  let prev = -Infinity;
  let monotone = true;
  for (let i = 0; i <= 5_000; i++) {
    const v = inverseCdf(q, i / 5_000);
    if (v < prev) monotone = false;
    prev = v;
  }
  check(`${name}: inverseCdf is non-decreasing`, monotone);

  const medianShare = e.responseShare === null ? null : e.responseShare.quantiles.p50;
  const p50 = drawDuration(e, { kind: "p50" }, q.p99);
  const p90 = drawDuration(e, { kind: "p90" }, q.p99);
  const man = drawDuration(e, { kind: "manual", minutes: q.p99 * 3 }, q.p99);
  check(`${name}: p50 / p90 modes are the quantiles, uncapped even when a cap is passed, with the median share`, p50.minutes === q.p50 && p90.minutes === q.p90 && !p50.capped && !p90.capped && p50.responseShare === medianShare && p90.responseShare === medianShare);
  check(`${name}: manual is never capped, even far above p99`, man.minutes === q.p99 * 3 && !man.capped && man.capMinutes === null);

  // sampled: distribution, cap, share
  const raw: number[] = [];
  const minutes: number[] = [];
  const shares: number[] = [];
  let cappedCount = 0;
  let cappedRight = true;
  let inRange = true;
  const uT: number[] = [];
  const uS: number[] = [];
  for (let s = 1; s <= N; s++) {
    const r = inverseCdf(q, makeRng(s)());
    const d = drawDuration(e, { kind: "sampled", seed: s }, q.p99);
    raw.push(r);
    minutes.push(d.minutes);
    if (d.capped) cappedCount++;
    if (d.minutes !== Math.min(r, q.p99) || d.capped !== r > q.p99 || d.capMinutes !== q.p99) cappedRight = false;
    if (e.responseShare !== null) {
      if (d.responseShare === null) inRange = false;
      else {
        shares.push(d.responseShare);
        if (d.responseShare < e.responseShare.quantiles.min || d.responseShare > e.responseShare.quantiles.max) inRange = false;
      }
      uT.push(makeRng(s)());
      uS.push(makeRng(s ^ SHARE_SEED_SALT)());
    } else if (d.responseShare !== null) inRange = false;
  }
  cdfMatches(`${name} duration`, q, raw);
  check(`${name}: sampled minutes = min(draw, the cap passed); capped iff the draw exceeded it; the cap in force is that cap`, cappedRight);
  check(`${name}: no sampled duration exceeds the cap passed`, minutes.every((m) => m <= q.p99));
  const frac = cappedCount / N;
  check(`${name}: about 1% of draws are capped at its own p99`, near(frac, 0.01, 5 * Math.sqrt(0.01 * 0.99 / N) + 1e-3), `got ${frac.toFixed(4)}`);
  check(`${name}: response share is drawn for breakdowns only, within its range`, inRange);
  if (e.responseShare !== null) {
    cdfMatches(`${name} response share`, e.responseShare.quantiles, shares);
    const mt = uT.reduce((a, b) => a + b, 0) / N;
    const ms = uS.reduce((a, b) => a + b, 0) / N;
    let cov = 0;
    let vt = 0;
    let vs = 0;
    for (let i = 0; i < N; i++) {
      cov += (uT[i] - mt) * (uS[i] - ms);
      vt += (uT[i] - mt) ** 2;
      vs += (uS[i] - ms) ** 2;
    }
    check(`${name}: the share draw is independent of the duration draw`, Math.abs(cov / Math.sqrt(vt * vs)) < 0.02, `corr ${(cov / Math.sqrt(vt * vs)).toFixed(4)}`);
  }
}

// cap options
const inLane = cal.entries.breakdown_in_lane;
const unc = Array.from({ length: 20_000 }, (_, i) => drawDuration(inLane, { kind: "sampled", seed: i + 1 }, null));
check("drawDuration cap null: no cap, nothing reported capped, some draws exceed p99", unc.every((d) => !d.capped && d.capMinutes === null) && unc.some((d) => d.minutes > inLane.quantiles.p99));
let cap30Ok = true;
let cap30Hit = false;
for (let s = 1; s <= 5_000; s++) {
  const d = drawDuration(inLane, { kind: "sampled", seed: s }, 30);
  const r = inverseCdf(inLane.quantiles, makeRng(s)());
  if (d.minutes !== Math.min(r, 30) || d.capped !== r > 30 || d.capMinutes !== 30) cap30Ok = false;
  if (d.capped) cap30Hit = true;
}
check("drawDuration cap 30: clamps to min(draw, 30), reports capped exactly when the draw exceeded it", cap30Ok && cap30Hit);
check("a cap of 0, a negative cap and NaN are rejected", throws(() => drawDuration(inLane, { kind: "sampled", seed: 1 }, 0)) && throws(() => drawDuration(inLane, { kind: "sampled", seed: 1 }, -5)) && throws(() => drawDuration(inLane, { kind: "sampled", seed: 1 }, Number.NaN)));

// reproducibility and validation
const v0: ScenarioVariant = { family: "self_accident" };
check("same seed gives the same resolved duration", JSON.stringify(sampleDuration(v0, 12345)) === JSON.stringify(sampleDuration(v0, 12345)));
check("different seeds give different durations", new Set(Array.from({ length: 50 }, (_, i) => sampleDuration(v0, i + 1).minutes)).size > 40);
const us = Array.from({ length: 20_000 }, (_, i) => makeRng(i + 1)());
const meanU = us.reduce((s, v) => s + v, 0) / us.length;
let cov = 0;
let varU = 0;
for (let i = 0; i < us.length - 1; i++) cov += (us[i] - meanU) * (us[i + 1] - meanU);
for (const v of us) varU += (v - meanU) ** 2;
check("consecutive seeds: first draw is uniform (mean ~ 0.5)", near(meanU, 0.5, 0.01), `mean ${meanU.toFixed(4)}`);
check("consecutive seeds: lag-1 correlation is negligible", Math.abs(cov / varU) < 0.03, `corr ${(cov / varU).toFixed(4)}`);
check("manual returns the operator's figure; rejects 0, negative, NaN", drawDuration(inLane, { kind: "manual", minutes: 42.5 }, null).minutes === 42.5 && throws(() => drawDuration(inLane, { kind: "manual", minutes: 0 }, null)) && throws(() => drawDuration(inLane, { kind: "manual", minutes: -3 }, null)) && throws(() => drawDuration(inLane, { kind: "manual", minutes: Number.NaN }, null)));
check("inverseCdf rejects u outside [0,1]", throws(() => inverseCdf(inLane.quantiles, -0.1)) && throws(() => inverseCdf(inLane.quantiles, 1.1)));
check("makeRng rejects a non-integer seed", throws(() => makeRng(1.5)));
check("low-sample flag: hit-and-run yes, self accident no", isLowSample(cal.entries.minor_collision_hit_and_run) && !isLowSample(cal.entries.self_accident));

/* ───────────────────────────── 3. hierarchy ───────────────────────────── */
const cellQualifies = (family: BreakdownFamilyKey, cause: BreakdownCause | null, vehicle: VehicleKind | null): boolean =>
  calibrationJson.provenance.hierarchy.cells.some((c) => c.family === family && c.cause === cause && c.vehicle === vehicle && c.qualifies);
let hierarchyOk = true;
let variantCount = 0;
const levelsSeen = new Set<string>();
for (const family of BREAKDOWN_FAMILIES) {
  for (const cause of BREAKDOWN_CAUSES) {
    for (const vehicle of BREAKDOWN_VEHICLES) {
      variantCount++;
      const sel = selectCalibration({ family, vehicle, cause });
      let level: string = "family";
      let key: string = family;
      let skipped = 3;
      if (cellQualifies(family, cause, vehicle)) { level = "cause_vehicle"; key = causeVehicleKey(family, cause, vehicle); skipped = 0; }
      else if (cellQualifies(family, cause, null)) { level = "cause"; key = causeKey(family, cause); skipped = 1; }
      else if (cellQualifies(family, null, vehicle)) { level = "vehicle"; key = vehicleKey(family, vehicle); skipped = 2; }
      levelsSeen.add(sel.level);
      if (sel.level !== level || sel.entry.key !== key || sel.skipped.length !== skipped) hierarchyOk = false;
      if (sel.level !== "family" && sel.entry.n < MIN_N) hierarchyOk = false;
      if (sel.skipped.some((s) => s.reason === "below_min_n" && (s.n === null || s.n >= MIN_N))) hierarchyOk = false;
      const r = resolveDuration({ family, vehicle, cause }, { kind: "p50" });
      if (r.level !== sel.level || r.calibrationKey !== sel.entry.key || r.n !== sel.entry.n) hierarchyOk = false;
    }
  }
}
check(`hierarchy: all ${variantCount} breakdown variants take the first qualifying level, in the stated order`, hierarchyOk && variantCount === 30);
check("hierarchy: the real file exercises cause x vehicle and cause levels", levelsSeen.has("cause_vehicle") && levelsSeen.has("cause"), [...levelsSeen].join());

// the vehicle and family levels need a synthetic calibration: no real cause cell is below the minimum
const tireTruck: ScenarioVariant = { family: "breakdown_in_lane", vehicle: "truck", cause: "tire" };
const onlyVehicles: Partial<Record<HierarchyKey, CalibrationEntry>> = {};
const onlyCauses: Partial<Record<HierarchyKey, CalibrationEntry>> = {};
for (const f of BREAKDOWN_FAMILIES) {
  for (const v of BREAKDOWN_VEHICLES) { const e = cal.hierarchy[vehicleKey(f, v)]; if (e !== undefined) onlyVehicles[vehicleKey(f, v)] = e; }
  for (const c of BREAKDOWN_CAUSES) { const e = cal.hierarchy[causeKey(f, c)]; if (e !== undefined) onlyCauses[causeKey(f, c)] = e; }
}
const asCal = (h: Partial<Record<HierarchyKey, CalibrationEntry>>): Calibration => ({ ...cal, hierarchy: h });
const selVehicle = selectFromCalibration(asCal(onlyVehicles), tireTruck);
const selCause = selectFromCalibration(asCal(onlyCauses), tireTruck);
const selFamily = selectFromCalibration(asCal({}), tireTruck);
check("fallback: without cause entries a breakdown uses its vehicle level (2 levels skipped)", selVehicle.level === "vehicle" && selVehicle.entry.key === vehicleKey("breakdown_in_lane", "truck") && selVehicle.skipped.length === 2);
check("fallback: without cause x vehicle entries it uses its cause level (1 level skipped)", selCause.level === "cause" && selCause.entry.key === causeKey("breakdown_in_lane", "tire") && selCause.skipped.length === 1);
check("fallback: with no hierarchy it uses the family entry (3 levels skipped)", selFamily.level === "family" && selFamily.entry.key === "breakdown_in_lane" && selFamily.skipped.length === 3);
const busFuel = selectCalibration({ family: "breakdown_in_lane", vehicle: "bus", cause: "fuel" });
check("a skipped level says why and how many events it had", busFuel.skipped.length >= 1 && busFuel.skipped[0].level === "cause_vehicle" && busFuel.skipped[0].reason === "below_min_n" && busFuel.skipped[0].n !== null && busFuel.skipped[0].n < MIN_N);
check("accident families never use the hierarchy", (["self_accident", "multi_vehicle_collision"] as const).every((f) => { const s = selectCalibration({ family: f }); return s.skipped.length === 0 && s.entry.key === f; }) && selectCalibration({ family: "minor_collision", label: "hit_and_run" }).entry.key === "minor_collision_hit_and_run" && selectCalibration({ family: "minor_collision", label: "hit_and_run" }).level === "label");
const hr = resolveDuration({ family: "breakdown_in_lane", vehicle: "truck", cause: "engine" }, { kind: "sampled", seed: 7 });
check("resolveDuration reports the level used, n, capped and the share", hr.level === "cause_vehicle" && hr.n >= MIN_N && typeof hr.capped === "boolean" && hr.responseShare !== null && hr.calibrationKey === causeVehicleKey("breakdown_in_lane", "engine", "truck"));

/* ───────────────────────────── 3b. the cap comes from the first level with enough events ───────────────────────────── */
const CAP_MIN_N = ASSUMPTIONS.CAP_MIN_N.value;
check(`CAP_MIN_N is ${CAP_MIN_N} and is stricter than the hierarchy minimum`, CAP_MIN_N === 1000 && CAP_MIN_N > MIN_N);

// An independent oracle: it walks the RAW cell counts and the raw p99s in the JSON, never the sampler's chain.
const rawCells = calibrationJson.provenance.hierarchy.cells;
const rawStats = new Map<string, { n: number; p99: number }>(Object.entries(calibrationJson.families).map(([k, v]) => [k, { n: v.n, p99: v.p99 }]));
function rawN(family: BreakdownFamilyKey, cause: BreakdownCause | null, vehicle: VehicleKind | null): number {
  const c = rawCells.find((cell) => cell.family === family && cell.cause === cause && cell.vehicle === vehicle);
  if (c === undefined) return 0;
  return c.n;
}
type Expected = { key: string; level: string; n: number; p99: number };
/**
 * Expected cap source for a breakdown variant, from the raw file. The quantile level is the first of cause x
 * vehicle, cause, vehicle, family with at least MIN_N events; the CAP is then the first with at least CAP_MIN_N
 * events in the order resolved level, VEHICLE, CAUSE, family.
 */
function expectedBreakdownCap(family: BreakdownFamilyKey, cause: BreakdownCause, vehicle: VehicleKind): Expected | null {
  const order = [
    { level: "cause_vehicle", key: causeVehicleKey(family, cause, vehicle), n: rawN(family, cause, vehicle) },
    { level: "cause", key: causeKey(family, cause), n: rawN(family, cause, null) },
    { level: "vehicle", key: vehicleKey(family, vehicle), n: rawN(family, null, vehicle) },
    { level: "family", key: family, n: rawN(family, null, null) },
  ];
  const resolved = order.find((o) => o.level === "family" || o.n >= MIN_N);
  if (resolved === undefined) return null;
  const capOrder = [resolved, order[2], order[1], order[3]];
  for (const o of capOrder) {
    if (o.level !== "family" && o.n < MIN_N) continue; // no entry exists for that cell
    if (o.n < CAP_MIN_N) continue;
    const s = rawStats.get(o.key);
    if (s === undefined) throw new Error(`no raw entry for ${o.key}`);
    return { key: o.key, level: o.level, n: s.n, p99: s.p99 };
  }
  return null;
}

let capWalkOk = true;
let capFromAncestor = 0;
let capFromSelf = 0;
let chainShapeOk = true;
for (const family of BREAKDOWN_FAMILIES) {
  for (const cause of BREAKDOWN_CAUSES) {
    for (const vehicle of BREAKDOWN_VEHICLES) {
      const variant: CalibratedVariant = { family, vehicle, cause };
      const want = expectedBreakdownCap(family, cause, vehicle);
      const sel = selectCalibration(variant);
      const r = resolveDuration(variant, { kind: "sampled", seed: 99 });
      if (want === null || sel.cap === null) { capWalkOk = false; continue; }
      if (sel.cap.key !== want.key || sel.cap.level !== want.level || sel.cap.n !== want.n || sel.cap.minutes !== want.p99) capWalkOk = false;
      if (r.capKey !== want.key || r.capLevel !== want.level || r.capN !== want.n || r.capMinutes !== want.p99) capWalkOk = false;
      if (want.key === sel.entry.key) capFromSelf++;
      else capFromAncestor++;
      // the chain: starts at the entry the quantiles come from, ends at the family, only existing entries, no repeats
      const keys = sel.chain.map((l) => l.entry.key);
      if (keys[0] !== sel.entry.key || keys[keys.length - 1] !== family || new Set(keys).size !== keys.length || sel.chain[0].level !== sel.level) chainShapeOk = false;
      if (sel.chain.some((l) => l.entry.n < MIN_N && l.level !== "family")) chainShapeOk = false;
    }
  }
}
check("cap: all 30 breakdown variants take their cap from the first of resolved level, vehicle, cause, family with n >= CAP_MIN_N (independent walk of the raw counts)", capWalkOk);
check("cap: every breakdown chain runs from the chosen entry to the family, over existing entries only", chainShapeOk);
check("cap: the real file has variants capped by their own level AND by an ancestor", capFromSelf > 0 && capFromAncestor > 0, `self ${capFromSelf}, ancestor ${capFromAncestor}`);

// The named cases. Tire x truck (in-lane) has 456 events, so it is capped from an ancestor: the VEHICLE level (truck), not its own p99 and not the tire cause level.
const ttOwn = cal.hierarchy[causeVehicleKey("breakdown_in_lane", "tire", "truck")];
const tireCause = cal.hierarchy[causeKey("breakdown_in_lane", "tire")];
const truckVehicle = cal.hierarchy[vehicleKey("breakdown_in_lane", "truck")];
const carVehicle = cal.hierarchy[vehicleKey("breakdown_in_lane", "car")];
const mechCause = cal.hierarchy[causeKey("breakdown_in_lane", "mechanical")];
const carMech = resolveDuration({ family: "breakdown_in_lane", vehicle: "car", cause: "mechanical" }, { kind: "sampled", seed: 1 });
check(
  "in-lane car x mechanical (n = 278) caps from VEHICLE: car, not from the mechanical cause level",
  carVehicle !== undefined && mechCause !== undefined && carMech.level === "cause_vehicle" && carMech.n < CAP_MIN_N &&
    carMech.capLevel === "vehicle" && carMech.capKey === vehicleKey("breakdown_in_lane", "car") && carMech.capN === carVehicle.n &&
    carMech.capMinutes === carVehicle.quantiles.p99 && carMech.capMinutes !== mechCause.quantiles.p99,
  `cap ${carMech.capMinutes} from ${carMech.capLevel}`,
);
const tt = resolveDuration(tireTruck, { kind: "sampled", seed: 1 });
check("tire x truck (in-lane): quantiles from cause x vehicle (n < CAP_MIN_N)", ttOwn !== undefined && ttOwn.n < CAP_MIN_N && tt.level === "cause_vehicle" && tt.n === ttOwn.n);
check(
  "tire x truck (in-lane): the cap comes from the truck vehicle level, not its own p99 and not the tire cause level",
  ttOwn !== undefined && tireCause !== undefined && truckVehicle !== undefined && truckVehicle.n >= CAP_MIN_N &&
    tt.capLevel === "vehicle" && tt.capKey === vehicleKey("breakdown_in_lane", "truck") && tt.capN === truckVehicle.n &&
    tt.capMinutes === truckVehicle.quantiles.p99 && tt.capMinutes !== ttOwn.quantiles.p99 && tt.capMinutes !== tireCause.quantiles.p99,
);
if (ttOwn !== undefined && truckVehicle !== undefined) {
  // Every sampled draw is min(raw draw from the tire x truck quantiles, the truck-vehicle p99); capped iff raw exceeded it.
  // Some raw draws fall between the two p99s: capped here, and NOT capped under the old own-p99 rule when the own p99 is the higher.
  let perSeedOk = true;
  let cappedBetween = 0;
  let cappedAll = 0;
  const seeds = 20_000;
  for (let s = 1; s <= seeds; s++) {
    const raw = inverseCdf(ttOwn.quantiles, makeRng(s)());
    const d = resolveDuration(tireTruck, { kind: "sampled", seed: s });
    if (d.minutes !== Math.min(raw, truckVehicle.quantiles.p99) || d.capped !== raw > truckVehicle.quantiles.p99) perSeedOk = false;
    if (d.capped) cappedAll++;
    if (d.capped && raw <= ttOwn.quantiles.p99) cappedBetween++;
  }
  check("tire x truck (in-lane): every sampled draw is min(its own draw, the truck-vehicle p99), capped exactly above it", perSeedOk);
  check(
    "tire x truck (in-lane): the ancestor cap really differs from the own-p99 rule (draws below its own p99 are capped when the vehicle p99 is lower)",
    truckVehicle.quantiles.p99 < ttOwn.quantiles.p99 ? cappedBetween > 0 : cappedBetween === 0,
    `capped below own p99: ${cappedBetween} of ${seeds}, capped in all: ${cappedAll}`,
  );
}
// Other modes report no cap in force; an explicit cap or none is honoured and names no source.
const ttP50 = resolveDuration(tireTruck, { kind: "p50" });
const ttMan = resolveDuration(tireTruck, { kind: "manual", minutes: 9999 });
const ttNoCap = resolveDuration(tireTruck, { kind: "sampled", seed: 5 }, { capMinutes: null });
const ttCap30 = resolveDuration(tireTruck, { kind: "sampled", seed: 5 }, { capMinutes: 30 });
check("cap: p50 and manual report no cap in force (nothing to source)", [ttP50, ttMan].every((d) => d.capMinutes === null && d.capKey === null && d.capLevel === null && d.capN === null && !d.capped));
check("cap: capMinutes null means no cap, and a number is used as given, with no source named", ttNoCap.capMinutes === null && ttNoCap.capKey === null && ttNoCap.capN === null && !ttNoCap.capped && ttCap30.capMinutes === 30 && ttCap30.capKey === null && ttCap30.capLevel === null && ttCap30.capN === null);
check("cap: an explicit cap of 0, a negative cap and NaN are rejected by resolveDuration", throws(() => resolveDuration(tireTruck, { kind: "sampled", seed: 1 }, { capMinutes: 0 })) && throws(() => resolveDuration(tireTruck, { kind: "sampled", seed: 1 }, { capMinutes: -1 })) && throws(() => resolveDuration(tireTruck, { kind: "sampled", seed: 1 }, { capMinutes: Number.NaN })));

// Accident families: minor collision's chain is label -> minor_collision; hit-and-run (n < CAP_MIN_N) inherits the family cap.
const accidentVariants: readonly { v: CalibratedVariant; key: string; level: string }[] = [
  { v: { family: "minor_collision", label: "rear_end" }, key: "minor_collision_rear_end", level: "label" },
  { v: { family: "minor_collision", label: "sideswipe" }, key: "minor_collision_sideswipe", level: "label" },
  { v: { family: "minor_collision", label: "hit_and_run" }, key: "minor_collision", level: "family" },
  { v: { family: "multi_vehicle_collision" }, key: "multi_vehicle_collision", level: "family" },
  { v: { family: "self_accident" }, key: "self_accident", level: "family" },
];
let accidentCapOk = true;
for (const a of accidentVariants) {
  const r = resolveDuration(a.v, { kind: "sampled", seed: 3 });
  const want = rawStats.get(a.key);
  if (want === undefined || r.capKey !== a.key || r.capLevel !== a.level || r.capN !== want.n || r.capMinutes !== want.p99 || want.n < CAP_MIN_N) accidentCapOk = false;
}
check("cap: rear-end, sideswipe, multi-vehicle and self-accident cap from their own entry; hit-and-run (n=129) from minor_collision", accidentCapOk);
const hnr = resolveDuration({ family: "minor_collision", label: "hit_and_run" }, { kind: "p50" });
check("resolveDuration carries the low-sample flag: hit-and-run yes, self accident and tire x truck no", hnr.lowSample && !resolveDuration({ family: "self_accident" }, { kind: "p50" }).lowSample && !tt.lowSample);
check("selectCalibration chain for a minor collision is label then minor_collision", selectCalibration({ family: "minor_collision", label: "hit_and_run" }).chain.map((l) => l.entry.key).join() === "minor_collision_hit_and_run,minor_collision");

// capMinN is a parameter of the pure selector: a synthetic threshold moves the cap source along the chain.
const at400 = selectFromCalibration(cal, tireTruck, 400);
const at1e6 = selectFromCalibration(cal, tireTruck, 1_000_000);
const at1 = selectFromCalibration(cal, tireTruck, 1);
check("capMinN 400: tire x truck (456 events) caps from its own level", at400.cap !== null && at400.cap.level === "cause_vehicle" && ttOwn !== undefined && at400.cap.minutes === ttOwn.quantiles.p99);
const atExact = ttOwn === undefined ? null : selectFromCalibration(cal, tireTruck, ttOwn.n);
const atExactPlus1 = ttOwn === undefined ? null : selectFromCalibration(cal, tireTruck, ttOwn.n + 1);
check("capMinN exactly equal to a level's n includes that level (>=), one more excludes it", atExact !== null && atExact.cap !== null && atExact.cap.level === "cause_vehicle" && atExactPlus1 !== null && atExactPlus1.cap !== null && atExactPlus1.cap.level === "vehicle");
// The cause level only matters to the cap when there is no vehicle entry to stop at first: a synthetic calibration.
const noVehicleEntries: Partial<Record<HierarchyKey, CalibrationEntry>> = {};
if (ttOwn !== undefined && tireCause !== undefined) {
  noVehicleEntries[causeVehicleKey("breakdown_in_lane", "tire", "truck")] = ttOwn;
  noVehicleEntries[causeKey("breakdown_in_lane", "tire")] = tireCause;
}
const selNoVehicle = selectFromCalibration(asCal(noVehicleEntries), tireTruck);
check("cap chain: with no vehicle entry, the cause level is the next stop (cause x vehicle, cause, family)", selNoVehicle.chain.map((l) => l.level).join() === "cause_vehicle,cause,family" && selNoVehicle.cap !== null && selNoVehicle.cap.level === "cause" && tireCause !== undefined && selNoVehicle.cap.minutes === tireCause.quantiles.p99);
check("cap chain: with all three levels it runs resolved level, vehicle, cause, family (the real file, tire x truck)", selectCalibration(tireTruck).chain.map((l) => l.level).join() === "cause_vehicle,vehicle,cause,family");
check("capMinN 1: the chosen entry is always its own cap source", at1.cap !== null && at1.cap.key === at1.entry.key);
check("capMinN above every level: no cap source, so a sampled draw is uncapped", at1e6.cap === null);
const famOnly = selectFromCalibration(asCal({}), tireTruck);
check("with no hierarchy entries the chain is the family alone, and it caps (n >= CAP_MIN_N)", famOnly.chain.length === 1 && famOnly.cap !== null && famOnly.cap.key === "breakdown_in_lane");
check("every shipped variant has a cap source (so 'no level qualifies' is not reachable)", [...BREAKDOWN_FAMILIES.flatMap((family) => BREAKDOWN_CAUSES.flatMap((cause) => BREAKDOWN_VEHICLES.map((vehicle): CalibratedVariant => ({ family, cause, vehicle })))), ...accidentVariants.map((a) => a.v)].every((v) => selectCalibration(v).cap !== null));

/* ───────────────────────────── 4. catalogue + assumptions ───────────────────────────── */
const EXPECTED_RESOURCES: Record<FamilyKey, readonly EngineResource[]> = {
  breakdown_in_lane: ["incident_slot"],
  breakdown_shoulder: ["speed_zone"],
  minor_collision: ["closure_stretch"],
  multi_vehicle_collision: ["closure_stretch"],
  self_accident: ["closure_stretch"],
  overturned_vehicle: ["closure_stretch"],
  flood: ["closure_stretch"],
  scheduled_roadworks: ["closure_stretch"],
  rain: ["speed_zone"],
};
check("one template per family, in the catalogue", SCENARIO_TEMPLATES.length === FAMILIES.length && FAMILIES.every((f) => SCENARIO_TEMPLATES.some((t) => t.family === f)));
check("display names are unique", new Set(SCENARIO_TEMPLATES.map((t) => t.displayName)).size === SCENARIO_TEMPLATES.length);
check("PHASE_SPLIT has entries for the closure families only (breakdown splits come from data)", Object.keys(ASSUMPTIONS.PHASE_SPLIT.value).sort().join() === "flood,minor_collision,multi_vehicle_collision,overturned_vehicle,scheduled_roadworks,self_accident");

for (const t of SCENARIO_TEMPLATES) {
  const f = t.family;
  check(`${f}: first phase is fixed at 0`, t.phases[0].offset.kind === "fixed" && phaseOffsetFractions(t.phases, 0.5)[0] === 0);
  check(`${f}: every phase has a label`, t.phases.every((p) => p.label.trim().length > 0));
  check(`${f}: resources are ${EXPECTED_RESOURCES[f].join("+")}`, [...t.resources].sort().join() === [...EXPECTED_RESOURCES[f]].sort().join());
  check(`${f}: default placement is a valid percentage`, t.defaultPlacement.pct > 0 && t.defaultPlacement.pct < 100);
  // Branches on durationSource itself (not a re-check: the aggregate check right after this loop already
  // verifies durationSource classification agrees with NO_CALIBRATION_FAMILIES) so TS narrows `t` to the
  // union member that actually carries `calibrationKey`, for any current or future manual_only family.
  if (t.durationSource === "calibrated") {
    check(`${f}: calibration key exists`, CALIBRATION_KEYS.some((k) => k === t.calibrationKey));
  } else {
    check(`${f}: a manual_only template has no calibrationKey field`, !("calibrationKey" in t));
  }
  check(`${f}: default lane is valid on a 2..6 lane road`, [2, 3, 4, 5, 6].every((lc) => { const l = defaultOperatorLane(t, lc); return l >= 1 && l <= lc; }));
  check(`${f}: lanes-blocked table covers exactly the phase ids`, Object.keys(ASSUMPTIONS.LANES_BLOCKED.value[f]).sort().join() === t.phases.map((p) => p.id).sort().join());
}
check("durationSource is calibrated for exactly the families with a calibration entry", SCENARIO_TEMPLATES.filter((t) => t.durationSource === "calibrated").map((t) => t.family).sort().join() === [...CALIBRATED_FAMILIES].sort().join());
for (const f of ["minor_collision", "multi_vehicle_collision", "self_accident", "overturned_vehicle"] as const) {
  const t = TEMPLATE_BY_FAMILY[f];
  const split = ASSUMPTIONS.PHASE_SPLIT.value[f];
  const offsets = phaseOffsetFractions(t.phases, null);
  check(`${f}: all phase offsets are fixed, start at 0, strictly increase and stay below 1`, t.phases.every((p) => p.offset.kind === "fixed") && offsets[0] === 0 && offsets.every((o, i) => o < 1 && (i === 0 || o > offsets[i - 1])));
  check(`${f}: phase shares sum to 1 and match the phases`, near(split.reduce((s, p) => s + p.share, 0), 1, 1e-9) && split.length === t.phases.length && t.phases.every((p, i) => p.id === split[i].id));
  const lanes: Record<string, number> = ASSUMPTIONS.LANES_BLOCKED.value[f];
  const lengths: Record<string, number> = ASSUMPTIONS.CLOSURE_LENGTH_M.value[f];
  check(`${f}: wreck length is >0 exactly when lanes are blocked`, Object.keys(lanes).every((id) => (lanes[id] > 0) === (lengths[id] > 0)));
  check(`${f}: last phase blocks no lane (lanes reopen before the scene is cleared)`, lanes[t.phases[t.phases.length - 1].id] === 0);
}
// Flood and scheduled roadworks are single-phase closure families (ASSUMPTIONS.PHASE_SPLIT gives each one phase
// at share 1): there is no "clearing" phase to reopen a lane before the scene ends, so the "last phase blocks no
// lane" check above does not apply — the phase itself blocks a lane for the whole event, and the closure simply
// ends when the event does (composeInterventions holds nothing for an event with no current phase).
for (const f of ["flood", "scheduled_roadworks"] as const) {
  const t = TEMPLATE_BY_FAMILY[f];
  const split = ASSUMPTIONS.PHASE_SPLIT.value[f];
  const offsets = phaseOffsetFractions(t.phases, null);
  check(`${f}: a single phase, fixed at offset 0`, t.phases.length === 1 && t.phases[0].offset.kind === "fixed" && offsets[0] === 0);
  check(`${f}: its one phase takes the whole share`, split.length === 1 && split[0].share === 1 && split[0].id === t.phases[0].id);
  const lanes: Record<string, number> = ASSUMPTIONS.LANES_BLOCKED.value[f];
  const lengths: Record<string, number> = ASSUMPTIONS.CLOSURE_LENGTH_M.value[f];
  check(`${f}: wreck length is >0 exactly when lanes are blocked`, Object.keys(lanes).every((id) => (lanes[id] > 0) === (lengths[id] > 0)));
  check(`${f}: its one phase blocks exactly 1 lane for the whole event`, lanes[t.phases[0].id] === 1);
}
for (const f of BREAKDOWN_FAMILIES) {
  const t = TEMPLATE_BY_FAMILY[f];
  check(`${f}: two phases, "Waiting for responder" then "Service / tow"`, t.phases.length === 2 && t.phases[0].id === "waiting" && t.phases[0].label === "Waiting for responder" && t.phases[1].id === "service" && t.phases[1].label === "Service / tow");
  check(`${f}: the service phase starts at the event's response share`, t.phases[1].offset.kind === "response_share");
  const at = (s: number): string => phaseOffsetFractions(t.phases, s).join();
  check(`${f}: offsets follow the share (0.6 -> 0,0.6; a share of 1 gives a zero-length service phase)`, at(0.6) === "0,0.6" && at(0) === "0,0" && at(1) === "0,1");
  check(`${f}: a response-share phase needs a valid share`, throws(() => phaseOffsetFractions(t.phases, null)) && throws(() => phaseOffsetFractions(t.phases, 1.2)) && throws(() => phaseOffsetFractions(t.phases, -0.1)));
}
check("accident phases need no share and ignore one", phaseOffsetFractions(TEMPLATE_BY_FAMILY.self_accident.phases, null).length === 3 && phaseOffsetFractions(TEMPLATE_BY_FAMILY.self_accident.phases, 0.9).join() === phaseOffsetFractions(TEMPLATE_BY_FAMILY.self_accident.phases, null).join());
check("TEMPLATE_BY_FAMILY agrees with the list", FAMILIES.every((f) => TEMPLATE_BY_FAMILY[f].family === f));

// default lanes = modal numbered lane in the data; default breakdown vehicle / cause = the most frequent cells
const lane = (d: Record<string, number>): string => {
  const numbered: [string, number][] = [["Lane1", d.Lane1], ["Lane2", d.Lane2], ["Lane3", d.Lane3], ["Lane4", d.Lane4]];
  return numbered.reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
};
const modal = {
  breakdown_in_lane: lane(calibrationJson.families.breakdown_in_lane.reference.lane_distribution.all),
  minor_collision: lane(calibrationJson.families.minor_collision.reference.lane_distribution.all),
  multi_vehicle_collision: lane(calibrationJson.families.multi_vehicle_collision.reference.lane_distribution.all),
  self_accident: lane(calibrationJson.families.self_accident.reference.lane_distribution.all),
};
for (const f of ["breakdown_in_lane", "minor_collision", "multi_vehicle_collision", "self_accident"] as const) {
  const d = TEMPLATE_BY_FAMILY[f].defaultLane;
  check(`${f}: default lane is the modal lane in the data (${modal[f]})`, d.kind === "operator_lane" && `Lane${d.lane}` === modal[f], JSON.stringify(d));
}
check("breakdown_shoulder: default lane is the outermost", TEMPLATE_BY_FAMILY.breakdown_shoulder.defaultLane.kind === "outermost");
check(
  "flood, scheduled roadworks: default lane is operator lane 1 (LANES_BLOCKED gives each just one lane; no data exists to prefer any other)",
  TEMPLATE_BY_FAMILY.flood.defaultLane.kind === "operator_lane" && TEMPLATE_BY_FAMILY.flood.defaultLane.lane === 1 &&
    TEMPLATE_BY_FAMILY.scheduled_roadworks.defaultLane.kind === "operator_lane" && TEMPLATE_BY_FAMILY.scheduled_roadworks.defaultLane.lane === 1,
);
check("rain: default lane is the outermost, like the other speed-zone family (it blocks no lane, but defaultOperatorLane still needs an index)", TEMPLATE_BY_FAMILY.rain.defaultLane.kind === "outermost");
for (const f of BREAKDOWN_FAMILIES) {
  const cells = calibrationJson.provenance.hierarchy.cells.filter((c) => c.family === f);
  const top = (level: string): string | null => {
    const rows = cells.filter((c) => c.level === level);
    const best = rows.reduce((a, b) => (b.n > a.n ? b : a));
    return level === "cause" ? best.cause : best.vehicle;
  };
  check(`${f}: default cause and vehicle are the most frequent usable cells (${top("cause")}, ${top("vehicle")})`, TEMPLATE_BY_FAMILY[f].defaultCause === top("cause") && TEMPLATE_BY_FAMILY[f].defaultVehicle === top("vehicle"));
}

// variants all resolve to a real base entry
const variants: CalibratedVariant[] = [];
for (const f of BREAKDOWN_FAMILIES) for (const vehicle of TEMPLATE_BY_FAMILY[f].vehicles) for (const cause of TEMPLATE_BY_FAMILY[f].causes) variants.push({ family: f, vehicle: vehicle.id, cause: cause.id });
for (const label of TEMPLATE_BY_FAMILY.minor_collision.labels) variants.push({ family: "minor_collision", label: label.id });
variants.push({ family: "multi_vehicle_collision" }, { family: "self_accident" });
check(`${variants.length} variants (2 x 3 vehicles x 5 causes + 3 labels + 2 single) all resolve to a base entry`, variants.length === 35 && variants.every((v) => CALIBRATION_KEYS.some((k) => k === calibrationKeyFor(v))));
check("every CALIBRATED family's default variant resolves to a real entry", CALIBRATED_FAMILIES.every((f) => { const v = calibratedVariantOf(defaultVariant(f)); return v !== null && CALIBRATION_KEYS.some((k) => k === calibrationKeyFor(v)); }));

// NO_CALIBRATION_FAMILIES: manual is the only valid mode, and the resolution carries no calibration information
for (const f of ASSUMPTIONS.NO_CALIBRATION_FAMILIES.value) {
  const v = defaultVariant(f);
  // Message text asserted, not just "it throws": a mode with no `minutes` field would throw for the WRONG
  // reason (checkManualMinutes rejecting `undefined`) if the family/mode guard were ever accidentally removed.
  const sampledMsg = thrownMessage(() => resolveDuration(v, { kind: "sampled", seed: 1 }));
  const p50Msg = thrownMessage(() => resolveDuration(v, { kind: "p50" }));
  const p90Msg = thrownMessage(() => resolveDuration(v, { kind: "p90" }));
  check(
    `${f}: sampled, median and 90th percentile are all rejected (no entry to draw from), naming the real reason`,
    [sampledMsg, p50Msg, p90Msg].every((m) => m !== null && m.includes("no calibration entry") && m.includes("manual")),
    JSON.stringify([sampledMsg, p50Msg, p90Msg]),
  );
  const r = resolveDuration(v, { kind: "manual", minutes: 42 });
  check(`${f}: a manual duration resolves with no calibration info (mode, minutes, level, n, cap all inert)`, r.mode === "manual" && r.minutes === 42 && r.uncappedMinutes === 42 && !r.capped && r.capMinutes === null && r.responseShare === null && r.level === "none" && r.n === 0 && !r.lowSample && r.skippedLevels.length === 0 && r.capKey === null && r.capLevel === null && r.capN === null && r.calibrationKey === f);
  check(`${f}: calibratedVariantOf is null (excluded from CalibratedVariant)`, calibratedVariantOf(v) === null);
  check(`${f}: not in CALIBRATION_KEYS`, !CALIBRATION_KEYS.some((k) => String(k) === f));
  check(`${f}: a manual duration of 0, negative or NaN is rejected, same as any other family`, throws(() => resolveDuration(v, { kind: "manual", minutes: 0 })) && throws(() => resolveDuration(v, { kind: "manual", minutes: -3 })) && throws(() => resolveDuration(v, { kind: "manual", minutes: Number.NaN })));
}
check("NO_CALIBRATION_FAMILIES lists exactly the families whose template says manual_only", [...ASSUMPTIONS.NO_CALIBRATION_FAMILIES.value].sort().join() === SCENARIO_TEMPLATES.filter((t) => t.durationSource === "manual_only").map((t) => t.family).sort().join());
check(
  "CLASS_FILTERED_BLOCKAGE names exactly flood (not overturned_vehicle or scheduled_roadworks: both are genuine full-width closures, so a binary lane-closed lever is not a simplification for them the way it is for flood)",
  ASSUMPTIONS.CLASS_FILTERED_BLOCKAGE.value.join() === "flood" && ASSUMPTIONS.CLASS_FILTERED_BLOCKAGE.status === "ASSUMPTION" && ASSUMPTIONS.CLASS_FILTERED_BLOCKAGE.reason.includes("outer lanes") && ASSUMPTIONS.CLASS_FILTERED_BLOCKAGE.reason.includes("PLACEHOLDER"),
);
const labels: readonly CollisionLabel[] = ["rear_end", "sideswipe", "hit_and_run"];
check("each collision label maps to its own entry", labels.every((l) => calibrationKeyFor({ family: "minor_collision", label: l }) === `minor_collision_${l}`));

check("incident slots: car 1, bus 2, truck 3", incidentSlotsFor("car") === 1 && incidentSlotsFor("bus") === 2 && incidentSlotsFor("truck") === 3);
let laneOk = true;
for (let lc = 1; lc <= 6; lc++) {
  for (let l = 1; l <= lc; l++) {
    const idx = operatorLaneToEngineIndex(l, lc);
    if (idx === null || idx < 0 || idx >= lc || engineIndexToOperatorLane(idx, lc) !== l) laneOk = false;
  }
  if (operatorLaneToEngineIndex(0, lc) !== null || operatorLaneToEngineIndex(lc + 1, lc) !== null) laneOk = false;
}
check("operator lane <-> engine index round-trips; out-of-range is null", laneOk);
check("with LANE1_IS_INNERMOST, operator lane 1 is engine index 0", operatorLaneToEngineIndex(1, 4) === 0 && operatorLaneToEngineIndex(4, 4) === 3);

/* ───────────────────────────── 5. closure geometry ───────────────────────────── */
check("UPSTREAM_BUFFER_M is a recorded assumption", ASSUMPTIONS.UPSTREAM_BUFFER_M.status === "ASSUMPTION" && UPSTREAM_BUFFER_M === ASSUMPTIONS.UPSTREAM_BUFFER_M.value && UPSTREAM_BUFFER_M > 0);
const B = UPSTREAM_BUFFER_M;
const s1 = closureStretch(330, 40, 600);
check("closure: interior event -> [position - buffer, position + wreck], nothing clamped", s1 !== null && s1.closurePointM === 330 - B && s1.closureEndM === 370 && !s1.clampedStart && !s1.clampedEnd);
const s2 = closureStretch(50, 40, 600);
check("closure: buffer past the segment start is clamped to 0", s2 !== null && s2.closurePointM === 0 && s2.closureEndM === 90 && s2.clampedStart && !s2.clampedEnd);
const s3 = closureStretch(590, 100, 600);
check("closure: wreck past the segment end is clamped to the segment length", s3 !== null && s3.closureEndM === 600 && s3.closurePointM === 590 - B && !s3.clampedStart && s3.clampedEnd);
const s4 = closureStretch(0, 40, 600);
check("closure: an event at the very start", s4 !== null && s4.closurePointM === 0 && s4.closureEndM === 40 && s4.clampedStart);
const s5 = closureStretch(600, 40, 600);
check("closure: an event at the very end", s5 !== null && s5.closureEndM === 600 && s5.closurePointM === 600 - B && s5.clampedEnd);
const s6 = closureStretch(50, 40, 100);
check("closure: a segment shorter than the buffer clamps both ends", s6 !== null && s6.closurePointM === 0 && s6.closureEndM === 90 && s6.clampedStart && !s6.clampedEnd);
check("closure: no stretch for a position outside the segment, or non-positive / non-finite lengths", closureStretch(-1, 40, 600) === null && closureStretch(601, 40, 600) === null && closureStretch(300, 0, 600) === null && closureStretch(300, 40, 0) === null && closureStretch(Number.NaN, 40, 600) === null && closureStretch(300, Number.POSITIVE_INFINITY, 600) === null);
let geomOk = true;
const g = makeRng(2026);
for (let i = 0; i < 20_000; i++) {
  const L = 50 + g() * 3000;
  const pos = g() * L;
  const w = 1 + g() * 200;
  const s = closureStretch(pos, w, L);
  if (s === null) { geomOk = false; continue; }
  const okInvariants =
    s.closurePointM >= 0 && s.closureEndM <= L && s.closurePointM < s.closureEndM && s.closurePointM <= pos && pos <= s.closureEndM &&
    near(s.closurePointM, Math.max(0, pos - B), 1e-9) && near(s.closureEndM, Math.min(L, pos + w), 1e-9) &&
    s.clampedStart === pos - B < 0 && s.clampedEnd === pos + w > L;
  if (!okInvariants) geomOk = false;
}
check("closure: 20,000 random cases keep 0 <= closurePoint <= position <= closureEnd <= length, with correct clamp flags", geomOk);

/* ───────────────────────────── 6. drift guards ───────────────────────────── */
const jsonRows = calibrationJson.chainage_offset.rows;
check("chainage table: same number of places in assumptions.ts and calibration.json", jsonRows.length === CHAINAGE_DERIVATION.length);
check(
  "chainage table: every row identical",
  CHAINAGE_DERIVATION.every((r, i) => {
    const j = jsonRows[i];
    return j !== undefined && j.app_exit === r.appExit && j.event_label === r.eventLabel && j.events === r.events && near(j.app_km, r.appKm, 1e-9) && near(j.chainage_km, r.chainageKm, 1e-9) && near(j.offset_km, r.offsetKm, 1e-9);
  }),
);
const offsets = CHAINAGE_DERIVATION.map((r) => r.offsetKm).sort((a, b) => a - b);
const medianOffset = offsets.length % 2 === 1 ? offsets[(offsets.length - 1) / 2] : (offsets[offsets.length / 2 - 1] + offsets[offsets.length / 2]) / 2;
check("chainage offset constant is the median of the table", near(medianOffset, CHAINAGE_OFFSET_KM, 0.005), `median ${medianOffset}`);
check("chainage offset constant equals the generator's median", CHAINAGE_OFFSET_KM === calibrationJson.chainage_offset.median_offset_km);
check("chainage offset: each row's offset is chainage minus app km", CHAINAGE_DERIVATION.every((r) => near(r.chainageKm - r.appKm, r.offsetKm, 0.011)));
check("km conversions round-trip", near(chainageKmToAppKm(appKmToChainageKm(33.33)), 33.33, 1e-9));

const engineSource = readFileSync(new URL("../simulation.ts", import.meta.url), "utf8");
const incidentLength = /const INCIDENT_LENGTH = (\d+(?:\.\d+)?)/.exec(engineSource);
check("engine INCIDENT_LENGTH equals ENGINE_INCIDENT_SLOT_M", incidentLength !== null && Number(incidentLength[1]) === ASSUMPTIONS.ENGINE_INCIDENT_SLOT_M.value, incidentLength ? `engine says ${incidentLength[1]}` : "constant not found");
const closureDefault = /closurePoint:\s*cfg\.length\s*\*\s*(\d+(?:\.\d+)?)/.exec(engineSource);
check("engine default closure position equals DEFAULT_PLACEMENT_PCT", closureDefault !== null && near(Number(closureDefault[1]) * 100, ASSUMPTIONS.DEFAULT_PLACEMENT_PCT.value, 1e-9), closureDefault ? `engine says ${closureDefault[1]}` : "not found");
const mergeZone = /const MERGE_ZONE_M = (\d+)/.exec(engineSource);
check("the upstream buffer sits inside the engine's merge zone, as the assumption's evidence claims", mergeZone !== null && UPSTREAM_BUFFER_M <= Number(mergeZone[1]));

const sim = new TrafficSim({ length: 600, laneCount: 4, inflowVehPerHour: 1000, seed: 1 });
const iv = sim.interventions;
check("engine: exactly one closurePoint/closureEnd pair", typeof iv.closurePoint === "number" && typeof iv.closureEnd === "number" && RESOURCE_SHARING.closure_stretch === "exclusive");
check("engine: exactly one speed zone", Array.isArray(iv.speedZone) && iv.speedZone.length === 2 && (iv.speedLimitKmh === null || typeof iv.speedLimitKmh === "number") && RESOURCE_SHARING.speed_zone === "exclusive");
check("engine: incidents are a list (shared)", Array.isArray(iv.incidents) && RESOURCE_SHARING.incident_slot === "shared");

// the generator: no built-in data path, the CSV folder is a required argument
const generator = readFileSync(new URL("./tools/build_calibration.py", import.meta.url), "utf8");
check("generator has no OneDrive path", !/onedrive/i.test(generator));
check("generator has no hard-coded drive path", !/[A-Za-z]:\\/.test(generator));
check("generator requires --csv-dir (or NLEX_CSV_DIR)", /"--csv-dir"[^)]*required=env_dir is None/s.test(generator) && /NLEX_CSV_DIR/.test(generator));
check("generator takes --min-n, defaulting to the LOW_SAMPLE_N value", /DEFAULT_MIN_N\s*=\s*(\d+)/.exec(generator)?.[1] === String(MIN_N));
check("calibration.json names its generator", calibrationJson.provenance.generator.endsWith("build_calibration.py"));

// assumptions are all marked and reasoned; the amended ones say so
const listed = listAssumptions();
check("every assumption is marked ASSUMPTION with a reason", listed.length > 0 && listed.every((a) => a.assumption.status === "ASSUMPTION" && a.assumption.reason.trim().length > 20));
check("LANE1_IS_INNERMOST is recorded as pending confirmation", (ASSUMPTIONS.LANE1_IS_INNERMOST.settledBy ?? "").includes("PENDING"));
check("BREAKDOWN_DURATION_SCOPE records the change to response + service", ASSUMPTIONS.BREAKDOWN_DURATION_SCOPE.value === "response_plus_service_per_event" && ASSUMPTIONS.BREAKDOWN_DURATION_SCOPE.reason.includes("AMENDED"));
check("the multi-deployment rule, share model and cap rule are recorded", ASSUMPTIONS.MULTI_DEPLOYMENT_RULE.status === "ASSUMPTION" && ASSUMPTIONS.RESPONSE_SHARE_MODEL.status === "ASSUMPTION" && ASSUMPTIONS.SAMPLED_CAP.value === "chain_p99" && ASSUMPTIONS.CAP_MIN_N.status === "ASSUMPTION" && ASSUMPTIONS.CAP_MIN_N.value === 1000);

/* ───────────────────────────── 7. adapter: scheduler and ownership ───────────────────────────── */
const FROM_KM = 10;
// Rounded to a millimetre: (10.33 - 10) * 1000 is 330.00000000000006 in floating point, and these tests compare positions exactly.
const frame: RoadFrame = { warmupS: 60, metresAt: (km) => Math.round((km - FROM_KM) * 1e6) / 1e3 };
const kmOf = (m: number): number => FROM_KM + m / 1000;
const road600: Road = { laneCount: 4, segmentLengthM: 600, ...frame };
const idle: ManualControls = { closedLanes: [false, false, false, false], closurePoint: 330, closureEnd: 600, showClosurePreview: false, speedLimitKmh: null, speedZone: [180, 480] };
const abs = (minutesAfterWarmup: number): number => frame.warmupS + minutesAfterWarmup * 60;

/** No lane closed by hand. */
const noClosure: ManualClosure = { closedLanes: [false, false, false, false], closurePoint: 330, closureEnd: 600 };
function must(events: readonly ScenarioEvent[], spec: NewEventSpec, seq: number, road: Road = road600, manual: ManualClosure = noClosure): { events: readonly ScenarioEvent[]; event: ScenarioEvent } {
  const r = addEvent(events, spec, road, seq, manual);
  if (!r.ok) throw new Error(`fixture: addEvent refused: ${r.reason}`);
  return { events: r.events, event: r.event };
}
function refused(events: readonly ScenarioEvent[], spec: NewEventSpec, seq: number, road: Road = road600, manual: ManualClosure = noClosure): string | null {
  const r = addEvent(events, spec, road, seq, manual);
  return r.ok ? null : r.reason;
}
const manualMinutes = (minutes: number): DurationMode => ({ kind: "manual", minutes });
// Every fixture defaults to NB: almost none of the 1,200+ existing checks are about direction at
// all, so defaulting keeps that whole body of tests unchanged. The direction-specific tests below
// pass "SB" explicitly through this same trailing parameter.
const inLaneSpec = (vehicle: VehicleKind, lane: number, posM: number, startMin: number, duration: DurationMode, direction: Direction = "NB"): NewEventSpec => ({
  variant: { family: "breakdown_in_lane", vehicle, cause: "engine" }, direction, lane, positionKm: kmOf(posM), startMinutes: startMin, duration,
});
const shoulderSpec = (posM: number, startMin: number, duration: DurationMode, direction: Direction = "NB"): NewEventSpec => ({
  variant: { family: "breakdown_shoulder", vehicle: "car", cause: "engine" }, direction, lane: null, positionKm: kmOf(posM), startMinutes: startMin, duration,
});
const collisionSpec = (family: "minor_collision" | "multi_vehicle_collision" | "self_accident" | "overturned_vehicle" | "flood" | "scheduled_roadworks", lane: number, posM: number, startMin: number, duration: DurationMode, direction: Direction = "NB"): NewEventSpec => ({
  variant: family === "minor_collision" ? { family, label: "rear_end" } : { family }, direction, lane, positionKm: kmOf(posM), startMinutes: startMin, duration,
});
const rainSpec = (posM: number, startMin: number, duration: DurationMode, direction: Direction = "NB", intensity: RainIntensity = "heavy"): NewEventSpec => ({
  variant: { family: "rain", intensity }, direction, lane: null, positionKm: kmOf(posM), startMinutes: startMin, duration,
});
const ALL_SPECS: readonly { name: string; spec: NewEventSpec }[] = [
  { name: "in-lane", spec: inLaneSpec("truck", 3, 330, 5, { kind: "sampled", seed: 7 }) },
  { name: "shoulder", spec: shoulderSpec(330, 5, { kind: "sampled", seed: 7 }) },
  { name: "minor", spec: collisionSpec("minor_collision", 1, 330, 5, { kind: "sampled", seed: 7 }) },
  { name: "multi", spec: collisionSpec("multi_vehicle_collision", 1, 330, 5, { kind: "sampled", seed: 7 }) },
  { name: "self", spec: collisionSpec("self_accident", 1, 330, 5, { kind: "sampled", seed: 7 }) },
];

// --- the stored resolution holds everything the UI needs, and matches a fresh draw
let resolutionOk = true;
let phasesOk = true;
for (const { spec } of ALL_SPECS) {
  const { event } = must([], spec, 1);
  const fresh = resolveDuration(spec.variant, { kind: "sampled", seed: 7 });
  if (JSON.stringify(event.resolved) !== JSON.stringify(fresh)) resolutionOk = false;
  const r = event.resolved;
  if (!(r.minutes > 0) || !(r.uncappedMinutes >= r.minutes) || r.capLevel === null || r.capN === null || r.capKey === null || r.capMinutes === null) resolutionOk = false;
  if (r.calibrationKey.length === 0 || !(r.n > 0) || typeof r.lowSample !== "boolean" || typeof r.capped !== "boolean") resolutionOk = false;
  if (event.duration.kind !== "sampled" || event.duration.seed !== 7) resolutionOk = false;
  const sumS = event.phases.reduce((a, p) => a + p.durationS, 0);
  if (!near(sumS, r.minutes * 60, 1e-6) || !near(event.endS - event.startS, r.minutes * 60, 1e-9) || event.startS !== 300) phasesOk = false;
  if (event.phases[0].offsetS !== 0 || event.phases.some((p, i) => i > 0 && p.offsetS < event.phases[i - 1].offsetS)) phasesOk = false;
  if (!event.phases.every((p) => p.text.startsWith(p.label) && (p.skipped ? p.text.endsWith(" — 0 min (skipped)") : /— [\d.]+ min$/.test(p.text)))) phasesOk = false;
  if (event.phases.some((p) => !near(p.minutes * 60, p.durationS, 1e-9))) phasesOk = false;
  if (r.responseShare !== null && !near(event.phases[0].minutes, r.minutes * r.responseShare, 1e-9)) phasesOk = false;
}
check("event: the stored resolution equals a fresh draw and carries level, n, low-sample, cap (level, n, key), uncapped draw, seed and share", resolutionOk);
check("event: phases tile the whole duration, start at 0, ascend, are labelled with their minutes, and split at the response share", phasesOk);

// --- purity: nothing is mutated, the result depends only on the inputs
{
  const events = [must([], inLaneSpec("truck", 3, 330, 0, manualMinutes(2)), 1).event, must([], collisionSpec("multi_vehicle_collision", 1, 330, 10, manualMinutes(30)), 2).event];
  const manual: ManualInterventions = { ...idle, incidents: [{ lane: 1, x: 100 }] };
  const before = JSON.stringify([events, manual]);
  const a = composeInterventions(manual, events, abs(0.5), road600);
  const b = composeInterventions(manual, events, abs(0.5), road600);
  check("compose: does not mutate its inputs, and is deterministic", JSON.stringify([events, manual]) === before && JSON.stringify(a) === JSON.stringify(b));
  check("compose: returns fresh arrays, never the operator's own", a.interventions.closedLanes !== manual.closedLanes && a.interventions.speedZone !== manual.speedZone && a.interventions.incidents[0] !== manual.incidents[0]);
}

// --- times count from the end of warm-up
{
  const { event } = must([], inLaneSpec("car", 3, 330, 1, manualMinutes(10)), 1);
  const at = (t: number) => composeInterventions({ ...idle, incidents: [] }, [event], t, road600).owners.incidents.length;
  check("time: nothing before warm-up ends, nothing at 1 min less a step, the event from +1 min, gone at its end", at(0) === 0 && at(abs(1) - 0.05) === 0 && at(abs(1)) === 1 && at(abs(11) - 0.05) === 1 && at(abs(11)) === 0);
  check("time: scenarioTimeS is engine time less warm-up", scenarioTimeS(75, frame) === 15 && scenarioTimeS(30, frame) === -30);
}

// --- in-lane breakdown: obstacle slots, lane mapping, for its whole duration
{
  let ok = true;
  for (const [vehicle, slots] of [["car", 1], ["bus", 2], ["truck", 3]] as const) {
    const { event } = must([], inLaneSpec(vehicle, 3, 330, 0, manualMinutes(10)), 1);
    const c = composeInterventions({ ...idle, incidents: [] }, [event], abs(1), road600);
    const want = Array.from({ length: slots }, (_, k) => ({ lane: 2, x: 330 - 5 * k }));
    if (JSON.stringify(c.interventions.incidents) !== JSON.stringify(want) || c.owners.incidents.length !== slots || c.interventions.closedLanes.some(Boolean) || c.owners.closure !== null || c.owners.speedZone !== null) ok = false;
    if (incidentSlotsFor(vehicle) !== slots) ok = false;
  }
  check("in-lane breakdown: a car uses 1 slot, a bus 2, a truck 3, chained upstream from the event position, in engine lane (operator lane - 1); no closure or zone", ok);
  const near0 = must([], inLaneSpec("truck", 3, 8, 0, manualMinutes(10)), 1).event;
  check("in-lane breakdown: slots that would start before the segment are dropped", composeInterventions({ ...idle, incidents: [] }, [near0], abs(1), road600).owners.incidents.length === 2);
  const both = must(must([], inLaneSpec("truck", 3, 330, 0, manualMinutes(10)), 1).events, inLaneSpec("car", 2, 200, 3, manualMinutes(10)), 2);
  check("in-lane breakdowns share the incident list: overlapping events are accepted", composeInterventions({ ...idle, incidents: [] }, both.events, abs(4), road600).owners.incidents.length === 4);
}

// --- collisions: the closure stretch, phase by phase
{
  const expectedLanes = (base: number, count: number, laneCount: number): number[] => {
    const out = [base];
    for (let i = base + 1; out.length < count && i < laneCount; i++) out.push(i);
    for (let i = base - 1; out.length < count && i >= 0; i--) out.push(i);
    return out.sort((a, b) => a - b);
  };
  let ok = true;
  let checked = 0;
  for (const family of ["minor_collision", "multi_vehicle_collision", "self_accident", "overturned_vehicle", "flood", "scheduled_roadworks"] as const) {
    const blocked = new Map(Object.entries(ASSUMPTIONS.LANES_BLOCKED.value[family]));
    const wreck = new Map(Object.entries(ASSUMPTIONS.CLOSURE_LENGTH_M.value[family]));
    for (const opLane of [1, 2, 4]) {
      const base = operatorLaneToEngineIndex(opLane, 4);
      if (base === null) throw new Error("fixture: lane");
      for (const posM of [330, 40, 590]) {
        const { event } = must([], collisionSpec(family, opLane, posM, 0, manualMinutes(50)), 1);
        for (const p of event.phases) {
          const t = frame.warmupS + event.startS + p.offsetS + p.durationS / 2;
          const c = composeInterventions({ ...idle, incidents: [] }, [event], t, road600);
          const n = blocked.get(p.id);
          const w = wreck.get(p.id);
          if (n === undefined || w === undefined) { ok = false; continue; }
          checked++;
          if (n === 0) {
            if (c.owners.closure !== null || c.interventions.closedLanes.some(Boolean) || c.interventions.closurePoint !== idle.closurePoint || c.interventions.closureEnd !== idle.closureEnd) ok = false;
          } else {
            const lanes = expectedLanes(base, n, 4);
            const point = Math.max(0, posM - UPSTREAM_BUFFER_M);
            const end = Math.min(600, posM + w);
            if (c.owners.closure === null || c.owners.closure.phaseId !== p.id || c.owners.closure.phaseLabel !== p.label) { ok = false; continue; }
            if (JSON.stringify(c.owners.closure.lanes) !== JSON.stringify(lanes)) ok = false;
            if (c.interventions.closedLanes.map((x, i) => (x ? i : -1)).filter((i) => i >= 0).join() !== lanes.join()) ok = false;
            if (c.interventions.closurePoint !== point || c.interventions.closureEnd !== end || c.interventions.showClosurePreview) ok = false;
          }
        }
      }
    }
  }
  check(`collisions: in every phase (${checked} cases: 6 families x 3 lanes x 3 positions, 13 phases per lane and position: 2+3+3+3+1+1) the lanes, stretch and owner match the assumption tables, updating as phases advance`, ok && checked === 117);
}

// --- shoulder breakdown: the speed zone, unless the operator is using it
{
  const { event } = must([], shoulderSpec(330, 0, manualMinutes(20)), 1);
  const zone = ASSUMPTIONS.GAWK_ZONE_M.value;
  const c = composeInterventions({ ...idle, incidents: [] }, [event], abs(1), road600);
  check("shoulder: while it runs, the zone is [position - 150, position + 100] at 70 km/h, owned by the event, no lane closed", c.interventions.speedLimitKmh === 70 && c.interventions.speedZone[0] === 330 - zone.upstream && c.interventions.speedZone[1] === 330 + zone.downstream && c.owners.speedZone !== null && c.owners.speedZone.eventId === event.id && !c.interventions.closedLanes.some(Boolean));
  const edge = composeInterventions({ ...idle, incidents: [] }, [must([], shoulderSpec(60, 0, manualMinutes(20)), 1).event], abs(1), road600);
  check("shoulder: the zone is clamped to the stretch, never moved", edge.interventions.speedZone[0] === 0 && edge.interventions.speedZone[1] === 160);
  const opLimit = composeInterventions({ ...idle, speedLimitKmh: 50, incidents: [] }, [event], abs(1), road600);
  check("shoulder: yields when the operator has a limit set (the operator's limit and zone stand, the event is listed as yielded)", opLimit.interventions.speedLimitKmh === 50 && opLimit.interventions.speedZone[0] === 180 && opLimit.owners.speedZone === null && opLimit.owners.yielded.length === 1 && opLimit.owners.yielded[0].eventId === event.id);
  const later = composeInterventions({ ...idle, speedLimitKmh: null, incidents: [] }, [event], abs(5), road600);
  check("shoulder: takes the zone as soon as the operator no longer uses it, for the rest of its window", later.owners.speedZone !== null && later.interventions.speedLimitKmh === 70);
  const after = composeInterventions({ ...idle, incidents: [] }, [event], abs(21), road600);
  check("shoulder: free for the operator once it ends (the operator's zone and limit come straight back)", after.owners.speedZone === null && after.interventions.speedLimitKmh === null && after.interventions.speedZone[0] === 180);
}

// --- operator controls while a scenario owns a lever
{
  const { event } = must([], collisionSpec("minor_collision", 1, 330, 0, manualMinutes(10)), 1);
  const clean: ManualControls = { closedLanes: [false, false, false, false], closurePoint: 100, closureEnd: 200, showClosurePreview: true, speedLimitKmh: null, speedZone: [180, 480] };
  // The operator has no closure when the event takes the stretch; they close lane 3 while it owns it.
  const taken = composeInterventions({ ...clean, incidents: [] }, [event], abs(1), road600);
  const rode: ManualControls = { ...clean, closedLanes: [false, false, true, false] };
  const during = composeInterventions({ ...rode, incidents: [] }, [event], abs(1.1), road600, taken.owners);
  check("lock: a lane the operator closes WHILE the event owns the stretch is kept, on the scenario's stretch", taken.owners.closure !== null && during.interventions.closedLanes.join() === "true,false,true,false" && during.interventions.closurePoint === 230 && during.interventions.closureEnd === 370);
  check("lock: the operator cannot move the stretch while it is owned (their stretch and preview are ignored)", during.interventions.closurePoint !== rode.closurePoint && during.interventions.showClosurePreview === false);
  const reopen = composeInterventions({ ...clean, incidents: [] }, [event], abs(1.1), road600, taken.owners);
  check("lock: the operator cannot reopen a lane the scenario blocks (it stays closed with their state open)", reopen.interventions.closedLanes[0] === true && scenarioLockedLanes(reopen.owners, 4).join() === "true,false,false,false");
  const both = composeInterventions({ ...clean, closedLanes: [true, false, false, false], incidents: [] }, [event], abs(1.1), road600, taken.owners);
  check("lock: closing the same lane as the scenario changes nothing", both.interventions.closedLanes.join() === "true,false,false,false");
  const after = composeInterventions({ ...rode, incidents: [] }, [event], abs(11), road600, during.owners);
  check("lock: when the event ends the operator's lanes, stretch and preview come back exactly", after.interventions.closedLanes.join() === "false,false,true,false" && after.interventions.closurePoint === 100 && after.interventions.closureEnd === 200 && after.interventions.showClosurePreview === true && after.owners.closure === null);
  check("lock: the owner reads \"<event> — <phase>\"", during.owners.closure !== null && describeOwner(during.owners.closure) === `${event.name} — Lane blocked: awaiting response` && event.name === "Minor collision #1");

  // No carry-over: a closure the operator ALREADY has elsewhere is never moved onto the event's stretch; the event stands aside.
  const elsewhere: ManualControls = { ...clean, closedLanes: [false, false, true, false] };
  const yielded = composeInterventions({ ...elsewhere, incidents: [] }, [event], abs(1), road600);
  const y0 = yielded.owners.yielded[0];
  check(
    "no carry-over: an operator closure already on another stretch is left exactly as it is, and the event yields",
    yielded.interventions.closedLanes.join() === "false,false,true,false" && yielded.interventions.closurePoint === 100 && yielded.interventions.closureEnd === 200 && yielded.owners.closure === null &&
      yielded.owners.yielded.length === 1 && y0.resource === "closure_stretch" && y0.eventId === event.id,
  );
  check("no carry-over: the event row says why", describeYield(y0) === "Closure suspended — operator lane closure active");
  const stillYielding = composeInterventions({ ...elsewhere, incidents: [] }, [event], abs(2), road600, yielded.owners);
  check("no carry-over: it keeps yielding for as long as the operator's closure stands", stillYielding.owners.closure === null && stillYielding.owners.yielded.length === 1);
  const released = composeInterventions({ ...clean, incidents: [] }, [event], abs(3), road600, yielded.owners);
  check("no carry-over: the moment the operator clears their closure the event takes the stretch, for the rest of its blocking phase", released.owners.closure !== null && released.interventions.closurePoint === 230 && released.interventions.closedLanes.join() === "true,false,false,false");
  const sameStretch = composeInterventions({ ...elsewhere, closurePoint: 230, closureEnd: 370, incidents: [] }, [event], abs(1), road600);
  check("no carry-over: an operator closure on exactly the event's stretch is no conflict (nothing moves)", sameStretch.owners.closure !== null && sameStretch.owners.yielded.length === 0 && sameStretch.interventions.closedLanes.join() === "true,false,true,false");
  const nearlySame = composeInterventions({ ...elsewhere, closurePoint: 230 + SAME_STRETCH_TOL_M - 0.01, closureEnd: 370, incidents: [] }, [event], abs(1), road600);
  const notSame = composeInterventions({ ...elsewhere, closurePoint: 230 + SAME_STRETCH_TOL_M + 0.01, closureEnd: 370, incidents: [] }, [event], abs(1), road600);
  check("no carry-over: 'the same stretch' means within the tolerance at each end", nearlySame.owners.closure !== null && notSame.owners.closure === null);
  const noLimit = composeInterventions({ ...clean, incidents: [] }, [must([], shoulderSpec(330, 0, manualMinutes(20)), 1).event], abs(1), road600).owners;
  // Only the yield differs between these two (same operator limit, nothing else owned): the event running, then finished.
  const yieldEvent = must([], shoulderSpec(330, 0, manualMinutes(20)), 1).event;
  const limited = { ...clean, speedLimitKmh: 50, incidents: [] };
  const whileYielding = composeInterventions(limited, [yieldEvent], abs(1), road600).owners;
  const afterYield = composeInterventions(limited, [yieldEvent], abs(30), road600).owners;
  check("ownership: the key changes when an event starts or stops yielding, nothing else changing (a suspended row must re-render)", whileYielding.yielded.length === 1 && afterYield.yielded.length === 0 && ownershipKey(whileYielding) !== ownershipKey(afterYield) && ownershipKey(noLimit) !== ownershipKey(whileYielding));
  const shoulderY = composeInterventions({ ...clean, speedLimitKmh: 50, incidents: [] }, [must([], shoulderSpec(330, 0, manualMinutes(20)), 1).event], abs(1), road600).owners.yielded[0];
  check("speed zone: while the operator's limit suspends a shoulder event, its row says \"Speed zone suspended — operator speed limit active\"", shoulderY.resource === "speed_zone" && describeYield(shoulderY) === "Speed zone suspended — operator speed limit active");
}

// --- rain: the speed zone spans the WHOLE segment regardless of position, at RAIN_SPEED_KMH, blocking no lane
{
  const near0 = must([], rainSpec(20, 0, manualMinutes(30)), 1).event;
  const nearEnd = must([], rainSpec(580, 0, manualMinutes(30)), 1).event;
  const c0 = composeInterventions({ ...idle, incidents: [] }, [near0], abs(1), road600);
  const c1 = composeInterventions({ ...idle, incidents: [] }, [nearEnd], abs(1), road600);
  check(
    "rain: the zone is [0, segment length] no matter where positionKm places the event (RAIN_ZONE = whole_segment), at RAIN_SPEED_KMH (heavy, for the spec these use)",
    c0.interventions.speedZone[0] === 0 && c0.interventions.speedZone[1] === 600 && c0.interventions.speedLimitKmh === ASSUMPTIONS.RAIN_SPEED_KMH.value.heavy &&
      c1.interventions.speedZone[0] === 0 && c1.interventions.speedZone[1] === 600 && c1.interventions.speedLimitKmh === ASSUMPTIONS.RAIN_SPEED_KMH.value.heavy,
  );
  check("rain: no lane is closed", !c0.interventions.closedLanes.some(Boolean) && c0.owners.closure === null);
  check("rain: it owns the speed zone, not a shoulder breakdown's gawk zone (a different speed, so the two are told apart by who owns it)", c0.owners.speedZone !== null && c0.owners.speedZone.eventId === near0.id && ASSUMPTIONS.RAIN_SPEED_KMH.value.heavy !== ASSUMPTIONS.GAWK_SPEED_KMH.value.breakdown_shoulder);
  check("rain: has no lane, whatever lane the spec was given (effectOf routes it to speed_zone, same as a shoulder breakdown)", must([], { ...rainSpec(330, 0, manualMinutes(5)), lane: 2 }, 1).event.lane === null);

  const opLimit = composeInterventions({ ...idle, speedLimitKmh: 50, incidents: [] }, [near0], abs(1), road600);
  check("rain: yields when the operator has a speed limit set, same as a shoulder breakdown yielding", opLimit.interventions.speedLimitKmh === 50 && opLimit.owners.speedZone === null && opLimit.owners.yielded.length === 1 && opLimit.owners.yielded[0].reason === "operator_limit_active" && describeYield(opLimit.owners.yielded[0]) === "Speed zone suspended — operator speed limit active");

  // The engine's single speed zone: rain and a shoulder breakdown cannot both hold it.
  const rainAlone = must([], rainSpec(330, 5, manualMinutes(20)), 1);
  const overlap = refused(rainAlone.events, shoulderSpec(200, 10, manualMinutes(20)), 2);
  check("rain: conflicts with an overlapping shoulder breakdown (the engine's single speed zone), naming both", overlap !== null && overlap.includes("Heavy rain #1") && overlap.includes("Breakdown on the shoulder #2") && overlap.includes("speed zone"));
  const after = addEvent(rainAlone.events, shoulderSpec(200, 26, manualMinutes(20)), road600, 2, noClosure);
  check("rain: a shoulder breakdown starting after rain ends is accepted", after.ok);
  const alongCollision = addEvent(rainAlone.events, collisionSpec("minor_collision", 1, 330, 6, manualMinutes(10)), road600, 2, noClosure);
  check("rain: a collision may run alongside it (a different lever, closure_stretch)", alongCollision.ok);
}

// --- adding an event while the operator has a closure of their own elsewhere
{
  const elsewhere: ManualClosure = { closedLanes: [false, false, true, false], closurePoint: 100, closureEnd: 200 };
  const minor = collisionSpec("minor_collision", 1, 330, 5, manualMinutes(10));
  check(
    "manual closure: an event that needs the closure stretch is refused with exactly the stated message, named to its carriageway (all these fixtures default to NB)",
    refused([], minor, 1, road600, elsewhere) === "NB: Clear your manual lane closure first — this event needs the closure stretch." &&
      MANUAL_CLOSURE_MESSAGE === "Clear your manual lane closure first — this event needs the closure stretch." &&
      manualClosureMessage("NB") === "NB: Clear your manual lane closure first — this event needs the closure stretch." &&
      manualClosureMessage("SB") === "SB: Clear your manual lane closure first — this event needs the closure stretch.",
  );
  check("manual closure: ... for every closure family", (["minor_collision", "multi_vehicle_collision", "self_accident", "overturned_vehicle", "flood", "scheduled_roadworks"] as const).every((f) => refused([], collisionSpec(f, 1, 330, 5, manualMinutes(10)), 1, road600, elsewhere) === manualClosureMessage("NB")));
  check("manual closure: rain does not use the closure stretch, so it is unaffected by one elsewhere", refused([], rainSpec(330, 5, manualMinutes(10)), 1, road600, elsewhere) === null);
  check("manual closure: events that do not use the closure stretch are not affected", refused([], inLaneSpec("truck", 3, 330, 5, manualMinutes(10)), 1, road600, elsewhere) === null && refused([], shoulderSpec(330, 5, manualMinutes(10)), 1, road600, elsewhere) === null);
  check("manual closure: no lane closed by hand means no conflict, whatever stretch is set", refused([], minor, 1, road600, { ...elsewhere, closedLanes: [false, false, false, false] }) === null);
  check("manual closure: a closure on exactly the event's stretch (230 to 370 m) is accepted", refused([], minor, 1, road600, { ...elsewhere, closurePoint: 230, closureEnd: 370 }) === null);
  check("manual closure: the tolerance at each end decides", refused([], minor, 1, road600, { ...elsewhere, closurePoint: 230.4, closureEnd: 370 }) === null && refused([], minor, 1, road600, { ...elsewhere, closurePoint: 230, closureEnd: 370.6 }) === manualClosureMessage("NB"));
  const multi = collisionSpec("multi_vehicle_collision", 1, 330, 5, manualMinutes(10));
  check("manual closure: an event with several closure phases is judged on the stretch it takes first (multi-vehicle: 230 to 430 m)", refused([], multi, 1, road600, { ...elsewhere, closurePoint: 230, closureEnd: 430 }) === null && refused([], multi, 1, road600, { ...elsewhere, closurePoint: 230, closureEnd: 390 }) === manualClosureMessage("NB"));
  check("manual closure: an invalid event is refused for its own reason first", (refused([], collisionSpec("minor_collision", 9, 330, 5, manualMinutes(10)), 1, road600, elsewhere) ?? "").includes("does not exist"));
  const minorSb = collisionSpec("minor_collision", 1, 330, 5, manualMinutes(10), "SB");
  check(
    "manual closure: an SB event's refusal names SB, not NB — the direction on the SPEC decides the message, not some ambient default",
    refused([], minorSb, 1, road600, elsewhere) === manualClosureMessage("SB") && refused([], minorSb, 1, road600, elsewhere) !== manualClosureMessage("NB"),
  );
  const sbHost = must([], collisionSpec("multi_vehicle_collision", 1, 330, 10, manualMinutes(40), "SB"), 1);
  check(
    "conflict: an SB event's conflict message is named to SB, not NB",
    (() => {
      const r = refused(sbHost.events, collisionSpec("self_accident", 2, 200, 20, manualMinutes(30), "SB"), 2, road600, noClosure);
      return r !== null && r.startsWith("SB: Cannot add") && !r.startsWith("NB:");
    })(),
  );
}

// --- direction bookkeeping: an event's own .direction field must always agree with which
// per-direction list it is stored in (see useDirectionSim). addEvent stamps it from the spec and
// never infers it, so the ONLY way the two can drift is a caller bug — directionBucketsConsistent
// is the guard against that, and it must actually catch a mismatch, not just accept everything.
{
  const nbEvent = must([], collisionSpec("minor_collision", 1, 330, 0, manualMinutes(10), "NB"), 1).event;
  const sbEvent = must([], collisionSpec("minor_collision", 1, 330, 0, manualMinutes(10), "SB"), 1).event;
  check("direction: addEvent stamps the event's own .direction from the spec, for both directions", nbEvent.direction === "NB" && sbEvent.direction === "SB");
  check(
    "directionBucketsConsistent: true for correctly-bucketed events (including an empty SB bucket, and a bucket missing from the map entirely)",
    directionBucketsConsistent({ NB: [nbEvent], SB: [] }) && directionBucketsConsistent({ NB: [nbEvent] }) && directionBucketsConsistent({}),
  );
  check(
    "directionBucketsConsistent: FALSE (a hard failure, not a warning) when an SB-direction event sits in the NB bucket — the exact mistake this guards against",
    directionBucketsConsistent({ NB: [sbEvent] }) === false,
  );
  check(
    "directionBucketsConsistent: FALSE when a bucket mixes directions, even with one correct entry alongside the wrong one",
    directionBucketsConsistent({ NB: [nbEvent, sbEvent] }) === false && directionBucketsConsistent({ SB: [nbEvent, sbEvent] }) === false,
  );
}

// --- the direction invariant is ENFORCED where events are stored, not just checkable: addEventToBucket
// (what useDirectionSim's addScenarioEvent and the panel's preview both call) refuses an event that names
// the other carriageway, checked FIRST so an unrelated refusal cannot mask it, and refuses to build on a
// list that is already corrupted. Nothing is returned to store in either case.
{
  const nbSpec = collisionSpec("minor_collision", 1, 330, 0, manualMinutes(10), "NB");
  const sbSpec = collisionSpec("minor_collision", 1, 330, 0, manualMinutes(10), "SB");
  const okNB = addEventToBucket("NB", [], nbSpec, road600, 1, noClosure);
  const okSB = addEventToBucket("SB", [], sbSpec, road600, 1, noClosure);
  check(
    "addEventToBucket: an event naming the bucket's own carriageway is stored, exactly as addEvent would (both directions)",
    okNB.ok && okNB.events.length === 1 && okNB.event.direction === "NB" && okSB.ok && okSB.events.length === 1 && okSB.event.direction === "SB",
  );
  const wrongIntoNB = addEventToBucket("NB", [], sbSpec, road600, 1, noClosure);
  const wrongIntoSB = addEventToBucket("SB", [], nbSpec, road600, 1, noClosure);
  check(
    "addEventToBucket: an SB event offered to NB's list (and an NB event to SB's) is REFUSED with a reason naming both carriageways, and no events are returned to store",
    !wrongIntoNB.ok && wrongIntoNB.reason === wrongCarriagewayMessage("NB", "SB") && wrongIntoNB.reason.includes("NB") && wrongIntoNB.reason.includes("SB") && !("events" in wrongIntoNB) &&
      !wrongIntoSB.ok && wrongIntoSB.reason === wrongCarriagewayMessage("SB", "NB") && !("events" in wrongIntoSB),
  );
  const held = must([], collisionSpec("multi_vehicle_collision", 1, 330, 10, manualMinutes(40), "NB"), 1);
  const wouldAlsoConflict = collisionSpec("self_accident", 2, 200, 20, manualMinutes(30), "SB");
  check(
    "addEventToBucket: the wrong-carriageway refusal is reported even when the event would ALSO have been refused for another reason (a conflict) — it is checked first, never masked",
    refused(held.events, { ...wouldAlsoConflict, direction: "NB" }, 2) !== null && (() => {
      const r = addEventToBucket("NB", held.events, wouldAlsoConflict, road600, 2, noClosure);
      return !r.ok && r.reason === wrongCarriagewayMessage("NB", "SB");
    })(),
  );
  const strayInNB = must([], sbSpec, 1).event;
  const laterNB = collisionSpec("minor_collision", 2, 200, 100, manualMinutes(5), "NB");
  const onCorrupted = addEventToBucket("NB", [strayInNB], laterNB, road600, 2, noClosure);
  check(
    "addEventToBucket: a list that ALREADY holds an event naming the other carriageway stops taking events (the resulting list is checked with directionBucketsConsistent), rather than carrying the error on",
    addEvent([strayInNB], laterNB, road600, 2, noClosure).ok && !onCorrupted.ok && onCorrupted.reason === inconsistentBucketMessage("NB"),
  );
  check(
    "addEventToBucket: an ordinary refusal (a conflict inside the right list) passes through unchanged, so the panel keeps showing the reason it always did",
    (() => {
      const dup = addEventToBucket("NB", held.events, collisionSpec("self_accident", 2, 200, 20, manualMinutes(30), "NB"), road600, 2, noClosure);
      return !dup.ok && dup.reason.includes("Multi-vehicle collision #1") && dup.reason !== wrongCarriagewayMessage("NB", "NB");
    })(),
  );
}

// --- conflicts: an exclusive lever cannot be held twice, and nothing is merged
{
  const a = must([], collisionSpec("multi_vehicle_collision", 1, 330, 10, manualMinutes(40)), 1);
  const overlap = refused(a.events, collisionSpec("self_accident", 2, 200, 20, manualMinutes(30)), 2);
  check("conflict: two collisions with overlapping closures are refused, naming BOTH events", overlap !== null && overlap.includes("Self accident #2") && overlap.includes("Multi-vehicle collision #1") && overlap.includes("closure stretch") && overlap.includes("Nothing was changed"), overlap ?? "was accepted");
  const first = a.event;
  const blockingEnd = first.phases.filter((p) => !p.skipped && p.lanesBlocked > 0).reduce((m, p) => Math.max(m, first.startS + p.offsetS + p.durationS), 0);
  const touching = addEvent(a.events, collisionSpec("self_accident", 2, 200, blockingEnd / 60 + 1e-9, manualMinutes(30)), road600, 2, noClosure);
  check("conflict: an event starting as the other lets go of the stretch is accepted", touching.ok);
  // Exactly touching, with numbers that are exact in floating point: 5 min minor collision from +10 min blocks [600, 840) s.
  const exactA = must([], collisionSpec("minor_collision", 1, 330, 10, manualMinutes(5)), 1);
  const exactWindow = resourceWindows(exactA.event)[0];
  check("conflict: (fixture) that window is exactly [600, 840) seconds", exactWindow.fromS === 600 && exactWindow.toS === 840);
  check("conflict: an event starting at exactly the second the other's window ends is accepted; one a second earlier is refused", addEvent(exactA.events, collisionSpec("minor_collision", 2, 200, 14, manualMinutes(5)), road600, 2, noClosure).ok && refused(exactA.events, collisionSpec("minor_collision", 2, 200, 14 - 1 / 60, manualMinutes(5)), 2) !== null);
  const inClearing = addEvent(a.events, collisionSpec("minor_collision", 2, 200, blockingEnd / 60 + 0.5, manualMinutes(5)), road600, 3, noClosure);
  check("conflict: the clearing phase holds nothing, so another collision may start in it", inClearing.ok && first.endS > blockingEnd + 30);
  const during = refused(a.events, collisionSpec("minor_collision", 2, 200, blockingEnd / 60 - 0.5, manualMinutes(5)), 4);
  check("conflict: the same half a minute earlier, inside the blocking phases, is refused", during !== null);
  const shoulderAlong = addEvent(a.events, shoulderSpec(300, 12, manualMinutes(30)), road600, 5, noClosure);
  check("conflict: a shoulder breakdown may run alongside a collision (a different lever)", shoulderAlong.ok);
  const s1 = must([], shoulderSpec(330, 5, manualMinutes(20)), 1);
  const s2 = refused(s1.events, shoulderSpec(200, 10, manualMinutes(20)), 2);
  check("conflict: two shoulder breakdowns overlapping are refused, naming both and the speed zone", s2 !== null && s2.includes("Breakdown on the shoulder #1") && s2.includes("Breakdown on the shoulder #2") && s2.includes("speed zone"));
  check("conflict: a refusal returns no events (nothing to apply) and does not change the stored list", addEvent(a.events, collisionSpec("self_accident", 2, 200, 20, manualMinutes(30)), road600, 2, noClosure).ok === false && a.events.length === 1);
  check("event: a shoulder breakdown has no lane, whatever lane it was given", must([], { ...shoulderSpec(330, 0, manualMinutes(5)), lane: 2 }, 1).event.lane === null && must([], inLaneSpec("car", 3, 330, 0, manualMinutes(5)), 1).event.lane === 3);
  check("event: an id already in use is rejected (the caller's counter must not repeat)", throws(() => addEvent(a.events, collisionSpec("minor_collision", 2, 200, 100, manualMinutes(5)), road600, 1, noClosure)) && throws(() => addEvent([], inLaneSpec("car", 3, 330, 0, manualMinutes(5)), road600, 0, noClosure)));
  check("conflict: an event whose phases all round to nothing is refused", refused([], inLaneSpec("car", 3, 330, 0, manualMinutes(1e-9)), 1) !== null);
  check("conflict: bad input is refused with a reason, not thrown (negative start, zero duration, lane that does not exist)", refused([], inLaneSpec("car", 3, 330, -1, manualMinutes(5)), 1) !== null && refused([], inLaneSpec("car", 3, 330, 0, manualMinutes(0)), 1) !== null && refused([], inLaneSpec("car", 5, 330, 0, manualMinutes(5)), 1) !== null && refused([], inLaneSpec("car", 3, 9999, 0, manualMinutes(5)), 1) !== null);
  check("conflict: resource windows: a collision's is its blocking phases, a shoulder's the whole event, an in-lane breakdown holds none", resourceWindows(first).length === 1 && resourceWindows(first)[0].resource === "closure_stretch" && resourceWindows(first)[0].toS === blockingEnd && resourceWindows(s1.event)[0].resource === "speed_zone" && resourceWindows(must([], inLaneSpec("car", 3, 330, 0, manualMinutes(5)), 1).event).length === 0);
}

// --- zero-length phases are skipped, still listed, never applied
{
  const variant: ScenarioVariant = { family: "breakdown_in_lane", vehicle: "truck", cause: "engine" };
  const base = must([], inLaneSpec("truck", 3, 330, 0, manualMinutes(10)), 1).event;
  const withShare = (share: number): ScenarioEvent => {
    const resolved = { ...base.resolved, minutes: 10, responseShare: share };
    return { ...base, resolved, phases: schedulePhases(variant, resolved) };
  };
  const one = withShare(1);
  const zero = withShare(0);
  check("zero-length: share 1 skips the service phase and lists it as \"Service / tow — 0 min (skipped)\"", one.phases[1].skipped && one.phases[1].text === "Service / tow — 0 min (skipped)" && !one.phases[0].skipped && one.phases[0].text === "Waiting for responder — 10 min");
  check("zero-length: share 0 skips the waiting phase and lists it as \"Waiting for responder — 0 min (skipped)\"", zero.phases[0].skipped && zero.phases[0].text === "Waiting for responder — 0 min (skipped)" && !zero.phases[1].skipped && zero.phases[1].text === "Service / tow — 10 min");
  let neverCurrent = true;
  const ownerPhases = new Set<string>();
  for (const [ev, skippedId] of [[one, "service"], [zero, "waiting"]] as const) {
    for (let t = 0; t <= 600.5; t += 0.5) {
      const p = phaseAt(ev, t);
      if (p !== null && p.id === skippedId) neverCurrent = false;
      const c = composeInterventions({ ...idle, incidents: [] }, [ev], abs(0) + t, road600);
      for (const o of c.owners.incidents) ownerPhases.add(`${ev === one ? "one" : "zero"}:${o.phaseId}`);
    }
  }
  check("zero-length: a skipped phase is never the current phase and never the owner of anything", neverCurrent && [...ownerPhases].sort().join() === "one:waiting,zero:service");
  check("zero-length: it adds no boundary of its own (share 1 has start, waiting start, end; share 0 has start and service start, end)", boundaryTimes([one], road600).join() === "0,600" && boundaryTimes([zero], road600).join() === "0,600");
  check("zero-length: the obstacle is present the whole event either way, with no gap at the join", composeInterventions({ ...idle, incidents: [] }, [zero], abs(0), road600).owners.incidents.length === 3 && composeInterventions({ ...idle, incidents: [] }, [one], abs(0) + 599.9, road600).owners.incidents.length === 3);
  const collisionBase = must([], collisionSpec("multi_vehicle_collision", 1, 330, 0, manualMinutes(10)), 1).event;
  const collisionZeroTow: ScenarioEvent = { ...collisionBase, phases: collisionBase.phases.map((p) => (p.id === "tow" ? { ...p, durationS: 0, minutes: 0, skipped: true, text: `${p.label} — 0 min (skipped)` } : p)) };
  const tAtTow = abs(0) + collisionBase.phases[1].offsetS + collisionBase.phases[1].durationS / 2;
  check("zero-length: a skipped closure phase changes no lane and no stretch", composeInterventions({ ...idle, incidents: [] }, [collisionZeroTow], tAtTow, road600).owners.closure === null);
}

// --- a road that no longer suits an event flags it; it is never dropped
{
  const { events } = must(must(must([], collisionSpec("multi_vehicle_collision", 1, 330, 0, manualMinutes(30)), 1).events, inLaneSpec("car", 4, 200, 0, manualMinutes(30)), 2).events, shoulderSpec(300, 0, manualMinutes(30)), 3);
  const road3: Road = { ...road600, laneCount: 3 };
  const road2: Road = { ...road600, laneCount: 2 };
  const shortRoad: Road = { ...road600, segmentLengthM: 250 };
  const c3 = composeInterventions({ ...idle, closedLanes: [false, false, false], incidents: [] }, events, abs(1), road3);
  check("lane count: dropping to 3 lanes flags the lane-4 breakdown, keeps the other two", c3.owners.invalid.length === 1 && c3.owners.invalid[0].eventId === "ev2" && c3.owners.invalid[0].problems[0].includes("lane 4 does not exist on a 3-lane road") && c3.owners.incidents.length === 0 && c3.owners.closure !== null);
  const c2 = composeInterventions({ ...idle, closedLanes: [false, false], incidents: [] }, events, abs(1), road2);
  check("lane count: on 2 lanes the multi-vehicle collision (blocks 2) is flagged as blocking every lane", c2.owners.invalid.some((i) => i.eventId === "ev1" && i.problems[0].includes("every lane")) && c2.owners.closure === null && c2.interventions.closedLanes.every((x) => !x));
  check("lane count: a flagged event changes nothing and is not in the boundary list, but is still in the stored list", boundaryTimes(events, road2).length > 0 && events.length === 3 && !boundaryTimes([events[0]], road2).length);
  const back = composeInterventions({ ...idle, incidents: [] }, events, abs(1), road600);
  check("lane count: back on 4 lanes the same events are valid again, with the same stored durations", back.owners.invalid.length === 0 && back.owners.closure !== null && back.owners.incidents.length === 1 && back.owners.speedZone !== null);
  const cs = composeInterventions({ ...idle, incidents: [] }, events, abs(1), shortRoad);
  check("stretch: a route change that leaves an event off the stretch flags it (km, not metres, is stored)", cs.owners.invalid.some((i) => i.eventId === "ev1" && i.problems[0].includes("outside the simulated stretch")));
  check("stretch: eventProblems is empty for a valid event and lists reasons otherwise", eventProblems(events[0], road600).length === 0 && eventProblems(events[1], road3).length === 1);
}

// --- on the real engine: the loop, rebuild, removal, fast-forward
const engineIv = (len: number, lanes: number): Partial<Interventions> => ({ closedLanes: Array(lanes).fill(false), closurePoint: len * 0.55, closureEnd: len, incidents: [], speedLimitKmh: null, speedZone: [len * 0.3, len * 0.8] });
const newSim = (len = 600, lanes = 4): TrafficSim => new TrafficSim({ length: len, laneCount: lanes, inflowVehPerHour: 4500, seed: 12345, warmupS: 60 }, engineIv(len, lanes));
const incidentKeyOf = (l: readonly { lane: number; x: number }[]): string => l.map((i) => `${i.lane}:${i.x}`).sort().join("|");
function engineInSync(ts: TrafficSim, controls: ManualControls, events: readonly ScenarioEvent[], binding: EngineBinding): boolean {
  const want = composeInterventions({ ...controls, incidents: binding.operatorIncidents(ts) }, events, ts.time, roadOf(ts, frame), binding.previousOwners()).interventions;
  const iv = ts.interventions;
  return iv.closedLanes.join() === want.closedLanes.join() && iv.closurePoint === want.closurePoint && iv.closureEnd === want.closureEnd && iv.speedLimitKmh === want.speedLimitKmh && iv.speedZone[0] === want.speedZone[0] && iv.speedZone[1] === want.speedZone[1] && incidentKeyOf(iv.incidents) === incidentKeyOf(want.incidents);
}

{
  // the animation loop: apply when a boundary is crossed; the engine is never a step behind
  const events = must(must([], collisionSpec("minor_collision", 1, 330, 0.2, manualMinutes(5)), 1).events, inLaneSpec("bus", 3, 150, 4, manualMinutes(2)), 2).events;
  const ts = newSim();
  const binding = createEngineBinding();
  let due = -Infinity;
  let applied = 0;
  let inSync = true;
  const seen = new Set<string>();
  const end = Math.max(...events.map((e) => e.endS)) + 5;
  while (scenarioTimeS(ts.time, frame) < end) {
    ts.step(0.05);
    const r = applyAtBoundary(binding, ts, idle, events, frame, due);
    due = r.dueS;
    if (r.composition !== null) applied++;
    if (!engineInSync(ts, idle, events, binding)) inSync = false;
    seen.add(`${ts.interventions.closedLanes.filter(Boolean).length}/${ts.interventions.incidents.length}`);
  }
  check("loop: after every one of ~" + Math.round(ts.time / 0.05) + " steps the engine holds exactly what compose says for that moment", inSync);
  check("loop: it applies once at the start and once per boundary crossed, no more", applied === 1 + boundaryTimes(events, road600).length, `${applied} applies, ${boundaryTimes(events, road600).length} boundaries`);
  check("loop: the run passed through every state (lane closed alone, lane closed with the bus, the bus alone, nothing)", ["1/0", "1/2", "0/2", "0/0"].every((s) => seen.has(s)), [...seen].join(" "));
  check("loop: when everything has ended the engine is back to the operator's settings, with no scenario incident left", ts.interventions.incidents.length === 0 && ts.interventions.closedLanes.every((x) => !x) && ts.interventions.closurePoint === idle.closurePoint);
}

// --- binding isolation: NB and SB each get their OWN createEngineBinding() (see useDirectionSim);
// this proves two independently-created bindings really are independent, not just two different
// object references pointing at shared internal state. createEngineBinding()'s ownership tracking
// (owned incidents map, previous Ownership) lives inside the closure it returns — the only way this
// could break is a caller reusing one binding for two sims, which is exactly what this rules out.
{
  const bindingNB = createEngineBinding();
  const bindingSB = createEngineBinding();
  check("binding isolation: two fresh bindings are distinct objects", bindingNB !== bindingSB);

  const simNB = newSim();
  const simSB = newSim();
  const eventsNB = must([], collisionSpec("multi_vehicle_collision", 1, 330, 0, manualMinutes(10), "NB"), 1).events;
  simNB.time = abs(1);
  simSB.time = abs(1);

  // Drive NB's binding hard: apply, step, apply again — its own sim owns a closure and incidents.
  bindingNB.apply(simNB, idle, eventsNB, frame);
  check("binding isolation: NB's binding took ownership on NB's own sim", bindingNB.previousOwners().closure !== null);
  check("binding isolation: SB's binding, never applied to anything yet, still reports NO_OWNERS", ownershipKey(bindingSB.previousOwners()) === ownershipKey(NO_OWNERS));

  // SB has no events of its own; applying its binding to its own (otherwise idle) sim must show
  // nothing owned — NOT NB's closure, even though NB's binding just took one on a structurally
  // identical sim a moment ago.
  bindingSB.apply(simSB, idle, [], frame);
  check(
    "binding isolation: SB's binding, applied to SB's own sim with no SB events, owns nothing — NB's closure never leaks across",
    bindingSB.previousOwners().closure === null && simSB.interventions.closedLanes.every((x) => !x) && simSB.interventions.closurePoint === idle.closurePoint,
  );
  check("binding isolation: NB's ownership is unaffected by SB's binding having been created and applied afterwards", bindingNB.previousOwners().closure !== null && simNB.interventions.closedLanes.some(Boolean));

  // Incident ownership: NB's binding must never think an incident it never placed (SB's, if SB had
  // one) belongs to it, and vice versa. Give SB its own in-lane breakdown and cross-check.
  // "car", not "truck": a car uses exactly 1 incident slot, matching the incidents.length === 1
  // assertions below — a truck's 3 slots would make those checks assert the wrong number for a
  // reason that has nothing to do with what this block is actually testing.
  const eventsSB = must([], inLaneSpec("car", 2, 200, 0, manualMinutes(10), "SB"), 1).events;
  bindingSB.apply(simSB, idle, eventsSB, frame);
  const sbIncident = simSB.interventions.incidents[0];
  check(
    "binding isolation: an incident SB's binding placed on SB's sim is not recognised as NB's binding's own (different closures, no shared 'owned' map)",
    sbIncident !== undefined && !bindingNB.isScenarioIncident(sbIncident) && bindingSB.isScenarioIncident(sbIncident),
  );
  bindingNB.reset();
  check(
    "binding isolation: resetting NB's binding forgets NB's own ownership but leaves SB's untouched — SB's incident is still there and still recognised as SB's binding's own",
    bindingNB.previousOwners().closure === null && simSB.interventions.incidents.length === 1 && bindingSB.isScenarioIncident(sbIncident),
  );
}

{
  // operator incidents are never touched, even at the same spot; clearing spares a running scenario's
  const ts = newSim();
  for (let i = 0; i < 400; i++) ts.step(0.05);
  ts.time = abs(0);
  const binding = createEngineBinding();
  ts.addIncident(2, 330);
  const operatorObj = ts.interventions.incidents[0];
  const { events, event } = must([], inLaneSpec("car", 3, 330, 0, manualMinutes(3)), 1);
  binding.apply(ts, idle, events, frame);
  check("incidents: a scenario adds its own beside the operator's, even at the same lane and spot", ts.interventions.incidents.length === 2 && binding.operatorIncidents(ts).length === 1 && binding.operatorIncidents(ts)[0] === operatorObj);
  const scenarioObj = ts.interventions.incidents.find((i) => i !== operatorObj);
  const vehiclesBefore = ts.vehicles.length;
  binding.apply(ts, idle, events, frame);
  binding.apply(ts, idle, events, frame);
  check("incidents: applying again is idempotent (no duplicates, the same obstacle objects, no vehicles absorbed again)", ts.interventions.incidents.length === 2 && scenarioObj !== undefined && ts.interventions.incidents.includes(scenarioObj) && ts.interventions.incidents.includes(operatorObj) && ts.vehicles.length === vehiclesBefore);
  binding.clearOperatorIncidents(ts);
  check("incidents: clearing the operator's leaves the running scenario's obstacle in place", ts.interventions.incidents.length === 1 && binding.operatorIncidents(ts).length === 0);
  binding.apply(ts, idle, events, frame);
  check("incidents: and a later apply does not double it", ts.interventions.incidents.length === 1);
  ts.addIncident(0, 100);
  const later = removeEvent(events, event.id);
  binding.apply(ts, idle, later, frame);
  check("removal: removing the event takes exactly its obstacle out and leaves the operator's new one", ts.interventions.incidents.length === 1 && ts.interventions.incidents[0].lane === 0 && ts.interventions.incidents[0].x === 100);
  check("incidents: a vehicle standing on the obstacle's spot is absorbed on arrival, as when the operator places one", ts.vehicles.every((v) => v.lane !== 2 || v.x - v.length >= 331 || v.x <= 324));
  const shifted = createEngineBinding();
  const ts2 = newSim();
  ts2.time = abs(0);
  shifted.apply(ts2, idle, events, frame);
  ts2.interventions.incidents = [];
  shifted.apply(ts2, idle, events, frame);
  check("incidents: if something else empties the engine's list, the next apply puts the scenario's back", ts2.interventions.incidents.length === 1 && shifted.operatorIncidents(ts2).length === 0);
}

{
  // On the real engine: a closure the operator already has is never displaced; a lane closed while the event owns the stretch stays.
  const events = must([], collisionSpec("minor_collision", 1, 330, 0, manualMinutes(10)), 1).events;
  const ts = newSim();
  const b = createEngineBinding();
  const elsewhere: ManualControls = { ...idle, closedLanes: [false, false, true, false], closurePoint: 100, closureEnd: 200 };
  const rode: ManualControls = { ...idle, closedLanes: [false, false, true, false], closurePoint: 100, closureEnd: 200 };
  ts.time = abs(1);
  b.apply(ts, elsewhere, events, frame);
  b.apply(ts, elsewhere, events, frame);
  const iv = () => `${ts.interventions.closedLanes.join()}|${ts.interventions.closurePoint}|${ts.interventions.closureEnd}`;
  check("engine: an operator closure on another stretch is left exactly as it was, and the event yields (applied repeatedly)", iv() === "false,false,true,false|100|200" && b.previousOwners().yielded.length === 1 && b.previousOwners().closure === null);
  b.apply(ts, idle, events, frame);
  check("engine: the operator clears their closure and the event takes the stretch", iv() === "true,false,false,false|230|370" && b.previousOwners().yielded.length === 0);
  b.apply(ts, rode, events, frame);
  check("engine: a lane the operator closes WHILE the event owns the stretch stays, on the event's stretch (the event keeps it)", iv() === "true,false,true,false|230|370" && b.previousOwners().closure !== null);
  ts.time = abs(11);
  b.apply(ts, rode, events, frame);
  check("engine: when the event ends the operator's lane and stretch are back exactly", iv() === "false,false,true,false|100|200");
  b.reset();
  check("engine: a reset forgets who held what", b.previousOwners().closure === null && b.previousOwners().yielded.length === 0);
}

{
  const ts = newSim();
  ts.interventions.closureDraft = { from: 100, to: 200 };
  createEngineBinding().apply(ts, idle, [], frame);
  check("binding: the operator's click-to-place draft (closureDraft) survives an apply", ts.interventions.closureDraft !== null && ts.interventions.closureDraft !== undefined && ts.interventions.closureDraft.from === 100 && ts.interventions.closureDraft.to === 200);
}

{
  // removing an event restores exactly what it changed, for every family (including the four with no
  // calibration entry of their own — duration is overridden to manual(20) here regardless, as it already is
  // for every other entry, so that is not a special case for this test).
  let ok = true;
  const removalSpecs: readonly { name: string; spec: NewEventSpec }[] = [
    ...ALL_SPECS,
    { name: "overturn", spec: collisionSpec("overturned_vehicle", 1, 330, 5, manualMinutes(20)) },
    { name: "flood", spec: collisionSpec("flood", 1, 330, 5, manualMinutes(20)) },
    { name: "roadworks", spec: collisionSpec("scheduled_roadworks", 1, 330, 5, manualMinutes(20)) },
    { name: "rain", spec: rainSpec(330, 5, manualMinutes(20)) },
  ];
  for (const { spec } of removalSpecs) {
    const events = must([], { ...spec, startMinutes: 0, duration: manualMinutes(20) }, 1).events;
    const ts = newSim();
    const ref = newSim();
    const b = createEngineBinding();
    const bRef = createEngineBinding();
    // The operator has no closure when the event starts, and closes lane 3 while it runs (a lane closed while it owns the stretch stays).
    const controls: ManualControls = { closedLanes: [false, false, false, false], closurePoint: 100, closureEnd: 200, showClosurePreview: false, speedLimitKmh: null, speedZone: [180, 480] };
    const closedLater: ManualControls = { ...controls, closedLanes: [false, false, true, false] };
    ts.addIncident(0, 50);
    ref.addIncident(0, 50);
    ts.time = abs(2);
    ref.time = abs(2);
    b.apply(ts, controls, events, frame);
    const during = incidentKeyOf(ts.interventions.incidents) + ts.interventions.closedLanes.join() + ts.interventions.speedLimitKmh;
    b.apply(ts, closedLater, events, frame);
    b.apply(ts, closedLater, removeEvent(events, "ev1"), frame);
    bRef.apply(ref, closedLater, [], frame);
    const a = JSON.stringify([ts.interventions.closedLanes, ts.interventions.closurePoint, ts.interventions.closureEnd, ts.interventions.speedLimitKmh, ts.interventions.speedZone, incidentKeyOf(ts.interventions.incidents)]);
    const r = JSON.stringify([ref.interventions.closedLanes, ref.interventions.closurePoint, ref.interventions.closureEnd, ref.interventions.speedLimitKmh, ref.interventions.speedZone, incidentKeyOf(ref.interventions.incidents)]);
    if (a !== r) ok = false;
    const rest = incidentKeyOf(ref.interventions.incidents) + ref.interventions.closedLanes.join() + ref.interventions.speedLimitKmh;
    if (during === rest) ok = false; // the event really had changed something
  }
  check("removal: for every family, removing a running event leaves the engine exactly as if it had never been added", ok);
}

{
  // rebuild: sim time resets, the stored events replay from the new warm-up, nothing is re-sampled
  const spec = collisionSpec("multi_vehicle_collision", 1, 330, 0.5, { kind: "sampled", seed: 99 });
  const { events, event } = must([], spec, 1);
  const stored = JSON.stringify(events);
  const first = newSim();
  const binding = createEngineBinding();
  first.time = abs(1);
  binding.apply(first, idle, events, frame);
  const during = first.interventions.closedLanes.filter(Boolean).length;
  const second = newSim();
  binding.reset();
  binding.apply(second, idle, events, frame);
  check("rebuild: a fresh engine at time 0 starts with nothing applied, and the events are byte-for-byte the stored ones", during === 2 && second.interventions.closedLanes.every((x) => !x) && JSON.stringify(events) === stored);
  second.time = abs(1);
  binding.apply(second, idle, events, frame);
  check("rebuild: the same event runs again from the new warm-up with the same phases", second.interventions.closedLanes.filter(Boolean).length === 2 && second.interventions.closurePoint === first.interventions.closurePoint && event.resolved.mode === "sampled");
  const resized = newSim(600, 2);
  binding.reset();
  binding.apply(resized, { ...idle, closedLanes: [false, false] }, events, frame);
  resized.time = abs(1);
  const cr = binding.apply(resized, { ...idle, closedLanes: [false, false] }, events, frame);
  check("rebuild: a new lane count flags the event (owners.invalid) and keeps it in the list", cr.owners.invalid.length === 1 && events.length === 1 && resized.interventions.closedLanes.every((x) => !x));
}

{
  // fast-forward: stepping without rendering, in slices, lands on the boundary, and matches running normally
  const events = must([], collisionSpec("minor_collision", 1, 330, 0.5, manualMinutes(6)), 1).events;
  const target = nextBoundaryAfter(events, road600, 0);
  check("skip: the next boundary from time 0 is the event's start", target === 30);
  if (target !== null) {
    const a = newSim();
    const bA = createEngineBinding();
    let steps = 0;
    let calls = 0;
    let fake = 0;
    let done = false;
    while (!done) {
      const r = stepToScenarioTime(a, frame, target, 0.05, 5, () => (fake += 1)); // a fake clock: 5 ms of budget = 5 reads
      steps += r.steps;
      calls++;
      done = r.reached;
    }
    bA.apply(a, idle, events, frame);
    const b = newSim();
    const bB = createEngineBinding();
    let due = -Infinity;
    while (scenarioTimeS(b.time, frame) < target) {
      b.step(0.05);
      due = applyAtBoundary(bB, b, idle, events, frame, due).dueS;
    }
    bB.apply(b, idle, events, frame);
    check("skip: in budgeted slices it reaches the target within one step, and the run is identical to stepping normally", scenarioTimeS(a.time, frame) >= target && scenarioTimeS(a.time, frame) < target + 0.05 + 1e-9 && a.time === b.time && JSON.stringify(a.metrics()) === JSON.stringify(b.metrics()) && steps === Math.round(a.time / 0.05));
    check("skip: a small budget splits the work across calls (it yields), a zero budget does one step at most", calls > 5 && stepToScenarioTime(newSim(), frame, 10, 0.05, 0, () => 1).steps === 0);
    check("skip: after the skip the new phase is applied (lane closed on the scenario's stretch)", a.interventions.closedLanes[0] === true && a.interventions.closurePoint === 230);
    check("skip: rejects a non-positive step", throws(() => stepToScenarioTime(newSim(), frame, 10, 0, 100, () => 0)));
  }
  const bs = boundaryTimes(events, road600);
  check("skip: successive boundaries visit start, end of lane-blocked, end of event, then none", nextBoundaryAfter(events, road600, 0) === 30 && nextBoundaryAfter(events, road600, 30) === bs[1] && nextBoundaryAfter(events, road600, bs[1]) === bs[2] && nextBoundaryAfter(events, road600, bs[2]) === null && bs.length === 3);
}

{
  // progress, for the list the operator will read
  const { event } = must([], collisionSpec("multi_vehicle_collision", 1, 330, 2, manualMinutes(20)), 1);
  const before = eventProgress(event, 0);
  const mid = eventProgress(event, event.startS + 10);
  const past = eventProgress(event, event.endS + 1);
  check("progress: pending, active (with its phase and time left in it) and done", before.state === "pending" && before.startsInS === 120 && mid.state === "active" && mid.phase !== null && mid.phase.id === "blocked" && mid.phaseRemainingS !== null && near(mid.phaseRemainingS, event.phases[0].durationS - 10, 1e-9) && past.state === "done" && past.remainingS === 0 && eventState(event, event.endS) === "done");
}

{
  const c = composeInterventions({ ...idle, incidents: [] }, [must([], collisionSpec("minor_collision", 1, 330, 0, manualMinutes(10)), 1).event], abs(1), road600);
  check("ownership: NO_OWNERS is empty, and ownershipKey tells owned from unowned", NO_OWNERS.closure === null && NO_OWNERS.incidents.length === 0 && ownershipKey(NO_OWNERS) !== ownershipKey(c.owners) && ownershipKey(c.owners) === ownershipKey(c.owners));
}

{
  // the words the operator reads come from the stored resolution
  const capped = ALL_SPECS.map((s) => must([], s.spec, 1).event).concat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30].map((seed) => must([], { variant: { family: "breakdown_in_lane", vehicle: "truck", cause: "tire" }, direction: "NB", lane: 3, positionKm: kmOf(330), startMinutes: 0, duration: { kind: "sampled", seed } }, 1).event)).find((e) => e.resolved.capped);
  const tt = must([], { variant: { family: "breakdown_in_lane", vehicle: "truck", cause: "tire" }, direction: "NB", lane: 3, positionKm: kmOf(330), startMinutes: 0, duration: { kind: "p50" } }, 1).event;
  const hnr = must([], { variant: { family: "minor_collision", label: "hit_and_run" }, direction: "NB", lane: 1, positionKm: kmOf(330), startMinutes: 0, duration: { kind: "p50" } }, 1).event;
  const man = must([], inLaneSpec("car", 3, 330, 0, manualMinutes(12)), 1).event;
  const text = describeResolution(tt);
  check("describe: a p50 names the level and n from the stored resolution", text.includes("median") && text.includes("calibrated at cause × vehicle level") && text.includes(`n = ${tt.resolved.n.toLocaleString("en-US")}`) && !text.includes("capped") && !text.includes("low sample"));
  check("describe: hit-and-run carries the low-sample warning", describeResolution(hnr).includes("(low sample)"));
  check("describe: a manual duration claims no calibration", describeResolution(man) === "12 min entered by the operator");
  check(
    "describe: when the cap applied it says what was drawn, what it was cut to, and the level and n of the cap",
    capped !== undefined && capped.resolved.capLevel !== null && capped.resolved.capN !== null && capped.resolved.capMinutes !== null && describeResolution(capped).includes(`capped: drew ${Number(capped.resolved.uncappedMinutes.toFixed(1))} min`) && describeResolution(capped).includes(`(n = ${capped.resolved.capN.toLocaleString("en-US")})`),
    capped === undefined ? "no capped draw found in 30 seeds" : "",
  );
  check("format: clock shows m:ss and h:mm:ss", formatClock(0) === "0:00" && formatClock(75) === "1:15" && formatClock(3725) === "1:02:05" && formatClock(-5) === "0:00");
}

// --- the families still not built: empty now that rain, flood, scheduled roadworks and overturned vehicle are all built
check(
  "families still not built: none — every family the review asked for is built, and the disabled-badge machinery still compiles and renders nothing",
  UNSUPPORTED_FAMILIES.length === 0 && NOT_YET_BUILT === "Not yet built" && UNSUPPORTED_FAMILIES.every((u) => u.displayName.trim().length > 0 && u.needs.trim().length > 20 && !FAMILIES.some((f) => String(f) === u.id)),
);

// --- the resolved duration as the operator reads it
{
  const p50 = resolutionView(must([], inLaneSpec("truck", 3, 330, 0, { kind: "p50" }), 1).event.resolved);
  const engineTruck = cal.hierarchy[causeVehicleKey("breakdown_in_lane", "engine", "truck")];
  check("resolution view: a median names the level and n, and carries no badge", engineTruck !== undefined && p50.headline === `${Number(engineTruck.quantiles.p50.toFixed(1))} min · median` && p50.calibration === `Level: cause × vehicle · n = ${engineTruck.n.toLocaleString("en-US")}` && p50.noCalibration === null && p50.lowSample === null && p50.capped === null && p50.cappedDetail === null);
  const hnrView = resolutionView(must([], { variant: { family: "minor_collision", label: "hit_and_run" }, direction: "NB", lane: 1, positionKm: kmOf(330), startMinutes: 0, duration: { kind: "p50" } }, 1).event.resolved);
  check("resolution view: hit-and-run shows the badge \"Low sample (n = 129)\", and no no-calibration badge", hnrView.lowSample === "Low sample (n = 129)" && hnrView.calibration === "Level: collision type · n = 129" && hnrView.noCalibration === null);
  const manualHnr = resolutionView(must([], { variant: { family: "minor_collision", label: "hit_and_run" }, direction: "NB", lane: 1, positionKm: kmOf(330), startMinutes: 0, duration: manualMinutes(20) }, 1).event.resolved);
  check(
    "resolution view: a MANUAL draw on a CALIBRATED family claims no calibration line and no low/cap badge, but ALSO no no-calibration badge (that badge means the family has no entry at all, which is a different claim from 'this one draw happened to be manual')",
    manualHnr.headline === "20 min · entered by you" && manualHnr.calibration === null && manualHnr.noCalibration === null && manualHnr.lowSample === null && manualHnr.capped === null,
  );
  let cappedEvent: ScenarioEvent | undefined;
  for (let seed = 1; seed <= 400 && cappedEvent === undefined; seed++) {
    const e = must([], { variant: { family: "breakdown_in_lane", vehicle: "car", cause: "mechanical" }, direction: "NB", lane: 3, positionKm: kmOf(330), startMinutes: 0, duration: { kind: "sampled", seed } }, 1).event;
    if (e.resolved.capped) cappedEvent = e;
  }
  const cv = cappedEvent === undefined ? null : resolutionView(cappedEvent.resolved);
  check(
    "resolution view: a capped draw says \"Capped at X min (from <level>)\" and what it drew; in-lane car x mechanical caps from the vehicle level",
    cappedEvent !== undefined && cv !== null && cv.noCalibration === null && cv.capped === `Capped at ${Number(cappedEvent.resolved.capMinutes?.toFixed(1))} min (from vehicle)` && cv.cappedDetail !== null && cv.cappedDetail.startsWith("Drew ") && cv.cappedDetail.includes("(n = 2,047)") && cv.lowSample === "Low sample (n = 278)" === (278 < MIN_N),
    cv === null ? "no capped draw in 400 seeds" : cv.capped ?? "",
  );

  // --- the SAME view, but for every NO_CALIBRATION_FAMILIES member: the positive badge is present, not just an
  // absent Sampled/Median/90th choice, and it reads identically whether built from a fresh preview (the Add
  // panel's use) or a stored event's resolution (an event row's use) — resolutionView takes only ResolvedDuration
  // either way, so there is exactly one code path to get this right in both places.
  for (const f of ASSUMPTIONS.NO_CALIBRATION_FAMILIES.value) {
    const view = resolutionView(resolveDuration(defaultVariant(f), { kind: "manual", minutes: 12 }));
    check(
      `${f}: resolution view shows the no-calibration badge with the exact required text, distinct from low/cap`,
      view.noCalibration === NO_CALIBRATION_NOTE && view.noCalibration === "No NLEX calibration data — duration is operator-set." && view.calibration === null && view.lowSample === null && view.capped === null,
    );
  }
}

// --- what the readouts see: the operator's settings with the scenario laid over them
{
  const manual = { closedLanes: [false, false, true, false], speedLimitKmh: null };
  const truckEvent = must([], inLaneSpec("truck", 3, 330, 0, manualMinutes(10)), 1).event;
  const collisionEvent = must([truckEvent].length ? [truckEvent] : [], collisionSpec("multi_vehicle_collision", 1, 200, 20, manualMinutes(30)), 2);
  const events = collisionEvent.events;
  const at = (min: number) => {
    const c = composeInterventions({ ...idle, closedLanes: manual.closedLanes, incidents: [] }, events, abs(min), road600);
    return effectiveState(manual, c.owners, events, min * 60, 4);
  };
  const early = at(1);
  check("effective state: a truck stall is ONE scenario incident (three engine slots), the operator's own lane is kept, nothing else driven", early.scenarioIncidents === 1 && early.closedLanes.join() === "false,false,true,false" && early.speedLimitKmh === null && early.active.length === 1 && early.active[0].name === "Breakdown in a lane #1" && early.active[0].phaseLabel === "Waiting for responder");
  // With no closure of their own the operator's lane 3 closed WHILE the event owns the stretch would ride on it; here they have none, so it owns it.
  const cleanManual = { closedLanes: [false, false, false, false], speedLimitKmh: null };
  const runClosure = composeInterventions({ ...idle, incidents: [] }, events, abs(21), road600);
  const later = effectiveState(cleanManual, runClosure.owners, events, 21 * 60, 4);
  check("effective state: a running closure adds its lanes; only running events are listed, each with its phase", later.closedLanes.join() === "true,true,false,false" && later.scenarioIncidents === 0 && later.active.map((a) => a.name).join() === "Multi-vehicle collision #2" && describeActiveEvents(later.active)[0] === "Multi-vehicle collision #2 — Lanes blocked: awaiting response");
  // The operator has a closure elsewhere: the event stands aside, and the readout must not claim it is acting.
  const standingAside = at(21);
  check("effective state: an event that stands aside for the operator's closure is listed as suspended, and adds no lane", standingAside.closedLanes.join() === "false,false,true,false" && standingAside.active[0].suspended && describeActiveEvents(standingAside.active)[0] === "Multi-vehicle collision #2 — Lanes blocked: awaiting response (suspended)");
  const shoulderEvents = must([], shoulderSpec(330, 0, manualMinutes(10)), 1).events;
  const sc = composeInterventions({ ...idle, incidents: [] }, shoulderEvents, abs(1), road600);
  check("effective state: a shoulder breakdown's speed zone shows as the limit in force", effectiveState({ closedLanes: [false, false, false, false], speedLimitKmh: null }, sc.owners, shoulderEvents, 60, 4).speedLimitKmh === 70);
  const bad = composeInterventions({ ...idle, closedLanes: [false, false], incidents: [] }, events, abs(1), { ...road600, laneCount: 2 });
  check("effective state: an event the road no longer suits is not listed as running", effectiveState({ closedLanes: [false, false], speedLimitKmh: null }, bad.owners, events, 60, 2).active.every((a) => a.name !== "Multi-vehicle collision #2") && bad.owners.invalid.length >= 1);
}

// --- what a skip is skipping through
{
  const multi = must([], collisionSpec("multi_vehicle_collision", 1, 330, 2, manualMinutes(40)), 1);
  const e = multi.event;
  const first = describeBoundary(multi.events, road600, e.startS, 0);
  const tow = e.phases[1];
  const inBlocked = describeBoundary(multi.events, road600, e.startS + tow.offsetS, e.startS + 30);
  const atEnd = describeBoundary(multi.events, road600, e.endS, e.startS + e.phases[2].offsetS + 5);
  check("skip label: to an event's start it is the wait for it, from now", first !== null && first.label === "Waiting for Multi-vehicle collision #1 to start" && first.intervalStartS === 0);
  check("skip label: through a phase it names the phase and counts from its start (time already in it is done)", inBlocked !== null && inBlocked.label === "Multi-vehicle collision #1 — Lanes blocked: awaiting response" && inBlocked.intervalStartS === e.startS);
  check("skip label: to the event's end it is the last phase", atEnd !== null && atEnd.label === "Multi-vehicle collision #1 — Scene clearing: lanes reopened" && near(atEnd.intervalStartS, e.startS + e.phases[2].offsetS, 1e-9));
  check("skip label: a time that is no boundary has none", describeBoundary(multi.events, road600, 12345.678, 0) === null);
}

// --- what the canvas labels
{
  const { events } = must(must(must([], inLaneSpec("bus", 3, 150, 1, manualMinutes(10)), 1).events, shoulderSpec(450, 0, manualMinutes(10)), 2).events, collisionSpec("self_accident", 2, 300, 12, manualMinutes(30)), 3);
  const m0 = canvasMarks(events, road600, abs(0.5));
  check("canvas marks: before start an event is marked as pending with when it starts; a running one shows its phase and time left", m0.length === 3 && m0.find((m) => m.eventId === "ev1")?.state === "pending" && m0.find((m) => m.eventId === "ev1")?.text === "Starts in 0:30" && m0.find((m) => m.eventId === "ev2")?.state === "active" && (m0.find((m) => m.eventId === "ev2")?.text ?? "").startsWith("Waiting for responder · "));
  check("canvas marks: position, engine lane (shoulder: none) and kind", m0.find((m) => m.eventId === "ev1")?.xM === 150 && m0.find((m) => m.eventId === "ev1")?.lane === 2 && m0.find((m) => m.eventId === "ev1")?.kind === "incident" && m0.find((m) => m.eventId === "ev2")?.lane === null && m0.find((m) => m.eventId === "ev2")?.kind === "speed_zone" && m0.find((m) => m.eventId === "ev3")?.kind === "closure" && m0.find((m) => m.eventId === "ev3")?.lane === 1);
  check("canvas marks: finished events are not marked, and neither is an event the road no longer suits", canvasMarks(events, road600, abs(200)).length === 0 && canvasMarks(events, { ...road600, laneCount: 2 }, abs(0.5)).every((m) => m.eventId !== "ev1"));
}

// --- the live-apply effect re-applies on every render: the composition must settle, or the page loops
{
  let s = 20260922;
  const rnd = (): number => { s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x6d2b79f5) | 0; return ((s ^ (s >>> 14)) >>> 0) / 4294967296; };
  const pickOne = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const variants: readonly ScenarioVariant[] = [
    { family: "breakdown_in_lane", vehicle: "truck", cause: "engine" },
    { family: "breakdown_shoulder", vehicle: "car", cause: "engine" },
    { family: "minor_collision", label: "rear_end" },
    { family: "multi_vehicle_collision" },
    { family: "self_accident" },
    { family: "overturned_vehicle" },
    { family: "flood" },
    { family: "scheduled_roadworks" },
    { family: "rain", intensity: "heavy" },
  ];
  const noLaneFamily = (f: FamilyKey): boolean => f === "breakdown_shoulder" || f === "rain";
  let notSettled = 0;
  const trials = 1500;
  for (let trial = 0; trial < trials; trial++) {
    let evs: readonly ScenarioEvent[] = [];
    const n = 1 + Math.floor(rnd() * 4);
    for (let i = 1; i <= n; i++) {
      const v = pickOne(variants);
      const r = addEvent(evs, { variant: v, direction: "NB", lane: noLaneFamily(v.family) ? null : 1 + Math.floor(rnd() * 4), positionKm: kmOf(20 + rnd() * 560), startMinutes: Math.floor(rnd() * 10), duration: manualMinutes(2 + Math.floor(rnd() * 40)) }, road600, i, noClosure);
      if (r.ok) evs = r.events;
    }
    const cp = rnd() < 0.5 ? 330 : 100 + rnd() * 200;
    const manual: ManualInterventions = {
      closedLanes: [rnd() < 0.3, rnd() < 0.3, rnd() < 0.3, rnd() < 0.3],
      closurePoint: cp,
      closureEnd: cp + 50 + rnd() * 100,
      showClosurePreview: false,
      speedLimitKmh: rnd() < 0.3 ? 50 : null,
      speedZone: [180, 480],
      incidents: [],
    };
    const t = 60 + rnd() * 3000;
    let prev: Ownership = NO_OWNERS;
    const keys: string[] = [];
    for (let k = 0; k < 6; k++) {
      prev = composeInterventions(manual, evs, t, road600, prev).owners;
      keys.push(ownershipKey(prev));
    }
    // From the second apply on, every result is the same: a fixed point that holds.
    if (!keys.slice(1).every((x) => x === keys[1])) notSettled++;
  }
  check(`compose settles: re-applying the same inputs with the previous ownership fed back is a fixed point after one apply (${trials} random states: events, operator closures and limits)`, notSettled === 0, `${notSettled} did not settle`);
}

// --- the page uses the adapter and nothing else to write scenario state; the engine and replicate() are untouched
// Phase D2: per-direction state moved into useDirectionSim.ts (called once per direction — NB, SB —
// from page.tsx), so some of what these checks guard now lives in that file's source instead of (or
// as well as) page.tsx's. Each check says which it reads and why.
{
  const pageSource = readFileSync(new URL("../page.tsx", import.meta.url), "utf8");
  const hookSource = readFileSync(new URL("../useDirectionSim.ts", import.meta.url), "utf8");
  check(
    "page + hook: no direct write to the engine's closure, speed or lane state remains (the adapter is the only writer)",
    !/interventions\.(closedLanes|closurePoint|closureEnd|speedLimitKmh|speedZone|showClosurePreview)\s*=[^=]/.test(pageSource) &&
      !/interventions\.(closedLanes|closurePoint|closureEnd|speedLimitKmh|speedZone|showClosurePreview)\s*=[^=]/.test(hookSource),
  );
  check("page: the confidence run says why it is off while events exist", (pageSource.match(/Confidence runs don't yet support timed events\./g) ?? []).length === 1);
  check(
    "page: replicate() is still called exactly once (at its one call site), and the confidence run refuses while events exist",
    (pageSource.match(/= replicate\(/g) ?? []).length === 1 && /if \(focused\.scenarioEvents\.length > 0\) return;/.test(pageSource),
  );
  check("engine source does not mention the adapter or scenario events", !/adapter|ScenarioEvent|composeInterventions/.test(engineSource));
  // phase 3: the readouts read the EFFECTIVE state, and the assistant is told it through its existing fields only.
  // Ownership is now set inside useDirectionSim (called once per direction, so the SOURCE has the
  // guarded setOwners call written once, same discipline as when this lived directly in page.tsx).
  check(
    "hook: ownership state is set in ONE place, and only when its key changed (a setter called on every render of the live-apply effect raised React's maximum-update-depth warning)",
    (hookSource.match(/\bsetOwners\(/g) ?? []).length === 1 &&
      /const publishOwners = useCallback\(\(next: Ownership\) => \{\s*const key = ownershipKey\(next\);\s*if \(key === ownersKeyRef\.current\) return;/.test(hookSource) &&
      !/TEMP-DEBUG/.test(hookSource) && !/\bsetOwners\(/.test(pageSource),
  );
  check("page: the console hook is gone now that the panel exists (nothing is exposed on window)", !/sandboxScenarios/.test(pageSource) && !/Object\.defineProperty\(window/.test(pageSource));
  check(
    "page: each direction's recommendation reads that direction's OWN effective state (NB's from nb, SB's from sb — never one direction's numbers under the other's heading)",
    /NB: getRecommendation\(nb\.metrics, nb\.baseline, \[\.\.\.nb\.eff\.closedLanes\], nb\.effIncidentCount, nb\.eff\.speedLimitKmh\)/.test(pageSource) &&
      /SB: getRecommendation\(sb\.metrics, sb\.baseline, \[\.\.\.sb\.eff\.closedLanes\], sb\.effIncidentCount, sb\.eff\.speedLimitKmh\)/.test(pageSource),
  );
  check(
    "hook: anyIntervention and the folded before/after / event-list summaries are built from the effective state, per direction",
    /const anyIntervention = eff\.closedLanes\.some\(Boolean\) \|\| eff\.speedLimitKmh != null \|\| effIncidentCount > 0;/.test(hookSource) &&
      /\.\.\.activeScenarioText,\s*\]\s*\.filter\(Boolean\)\s*\.join\(" · "\) \|\| "a clear road"/.test(hookSource) &&
      /\.\.\.activeScenarioText,\s*\]\s*\.filter\(Boolean\)\s*\.join\(" · "\) \|\| "none applied"/.test(hookSource),
  );
  const ctxStart = pageSource.indexOf("context: {");
  const ctxEnd = pageSource.indexOf("exits: EXITS.map", ctxStart);
  const ctxSource = pageSource.slice(ctxStart, ctxEnd);
  const ctxKeys = [...ctxSource.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
  check(
    // No new "direction" field (Phase D1 §4 / no backend change): the context always names the
    // FOCUSED direction's effective state through the same 5 fields that existed before D2.
    "page: the assistant's context carries the carriageway the command was SENT for (the focused one, pinned at send time as sentTo): its effective closed lanes, speed limit and incident count, in the EXISTING fields only",
    ctxKeys.join() === "laneCount,segmentLengthM,closedLanes,speedLimitKmh,incidentCount" &&
      /const sentTo = byDirection\[focusDirection\];/.test(pageSource) &&
      /closedLanes: sentTo\.eff\.closedLanes\.map/.test(pageSource) &&
      /speedLimitKmh: sentTo\.eff\.speedLimitKmh,/.test(pageSource) &&
      /incidentCount: sentTo\.effIncidentCount,/.test(pageSource),
    ctxKeys.join(),
  );
  check("page: a scenario's obstacle is not drawn as the operator's red dot (the scene art draws it), and each event is labelled on the canvas", /overlay\.isScenarioIncident\(inc\)/.test(pageSource) && /drawScenarioLabels\(ctx, scenes,/.test(pageSource));
}

// --- Phase D3: Both mode draws two carriageways in one canvas, not one (the whole point of the
// phase), and lane 1 must still land against the median on BOTH sides even though only one of them
// (SB, drawn above the median) needs its internal draw order reversed to get there. page.tsx's
// render()/renderBoth() run real canvas code and are checked live in the browser (see the D3 report's
// screenshots and the geometry probe); what is checked here is the STRUCTURE regex can see reliably:
// which function calls which, with which literal flag, and that render() (single-direction) is
// byte-unchanged in the one respect that matters most — it never reverses.
{
  const pageSource = readFileSync(new URL("../page.tsx", import.meta.url), "utf8");
  check(
    "page: the dual-carriageway geometry and draw-order helpers exist, separate from single-direction roadLayout()",
    /function dualRoadLayout\(/.test(pageSource) &&
      /function laneSlotTop\(/.test(pageSource) &&
      /function drawCarriageway\(/.test(pageSource) &&
      /function renderBoth\(/.test(pageSource) &&
      /function drawMedian\(/.test(pageSource) &&
      /function drawSharedKmAxis\(/.test(pageSource),
  );
  const renderBothStart = pageSource.indexOf("function renderBoth(");
  const renderBothEnd = pageSource.indexOf("\nfunction drawMedian(", renderBothStart);
  const renderBothSource = pageSource.slice(renderBothStart, renderBothEnd);
  const nbCallStart = renderBothSource.indexOf("simNB, {");
  const sbCallStart = renderBothSource.indexOf("simSB, {");
  check(
    "renderBoth: SB (drawn ABOVE the median, running right to left) is drawn reversed — lane 1 ends up against the median, which is below its block — and NB (below the median, running left to right) is not (its lane 1 is already against the median above it)",
    nbCallStart > -1 && sbCallStart > nbCallStart &&
      /reverseLanes: false/.test(renderBothSource.slice(nbCallStart, sbCallStart)) &&
      /reverseLanes: true/.test(renderBothSource.slice(sbCallStart)),
  );
  check(
    "renderBoth: each carriageway keeps its ramps on its OUTER edge — SB (top) above, NB (bottom) below, both away from the median",
    /rampsAbove: false,[\s\S]{0,80}reverseLanes: false/.test(renderBothSource.slice(nbCallStart, sbCallStart)) &&
      /rampsAbove: true,[\s\S]{0,80}reverseLanes: true/.test(renderBothSource.slice(sbCallStart)),
  );
  check(
    // Exactly one reversed call (NB in Both mode) anywhere in the file; single-direction render()'s
    // own call to drawCarriageway must be among the non-reversed ones, or NB-only/SB-only would
    // silently start drawing lane 1 at the wrong edge — the one regression D3 must not cause.
    "exactly one reversed carriageway in the whole file (Both mode's SB), and render()'s own call is not it",
    (pageSource.match(/reverseLanes: true/g) ?? []).length === 1 &&
      (pageSource.match(/reverseLanes: false/g) ?? []).length === 2, // render()'s call + renderBoth's NB call
  );
  check(
    "renderBoth shares ONE km axis (drawSharedKmAxis, called once) rather than drawing it per carriageway (both drawCarriageway calls pass drawAxis: false)",
    (renderBothSource.match(/drawSharedKmAxis\(/g) ?? []).length === 1 &&
      (renderBothSource.match(/drawAxis: false/g) ?? []).length === 2 &&
      !/drawAxis: true/.test(renderBothSource),
  );
  check(
    "render() (single-direction) still draws its own axis, unreversed — NB-only/SB-only unchanged from before D3",
    /drawAxis: true/.test(pageSource.slice(pageSource.indexOf("function render("), pageSource.indexOf("function renderBoth("))),
  );
}

// --- Phase D4 -----------------------------------------------------------------------------------
// Corridor totals for Both mode (bothMetrics.ts) are pure, so every rule is pinned here directly,
// including the ones that are easy to get quietly wrong: flow-weighting must not degrade to a plain
// mean, a direction with no flow must not drag the corridor speed toward zero, and two queues must not add.
{
  const m = (o: Partial<Metrics>): Metrics => ({
    activeAgents: 0, avgSpeedKmh: 0, throughputPerMin: 0, densityPerKmLane: 0, stoppedCount: 0, longestQueueM: 0,
    co2RatePerMin: 0, avgTravelTimeS: 0, completed: 0, elapsedS: 100, warm: true, unmetVehPerHour: 0, ...o,
  });
  const nb = m({ activeAgents: 30, avgSpeedKmh: 100, throughputPerMin: 90, longestQueueM: 40, co2RatePerMin: 8, stoppedCount: 2, unmetVehPerHour: 10, densityPerKmLane: 12 });
  const sb = m({ activeAgents: 20, avgSpeedKmh: 40, throughputPerMin: 10, longestQueueM: 120, co2RatePerMin: 5, stoppedCount: 7, unmetVehPerHour: 0, densityPerKmLane: 30 });
  const c = combineMetrics(nb, sb);
  check("corridor: counts and rates add (agents, throughput, CO2, stopped, unmet demand)", c.activeAgents === 50 && c.throughputPerMin === 100 && c.co2RatePerMin === 13 && c.stoppedCount === 9 && c.unmetVehPerHour === 10);
  check("corridor: longest queue is the MAX of the two, never their sum", c.longestQueueM === Math.max(nb.longestQueueM, sb.longestQueueM) && c.longestQueueM !== nb.longestQueueM + sb.longestQueueM);
  const weighted = (100 * 90 + 40 * 10) / 100;
  check("corridor: average speed is flow-weighted by throughput", c.flowWeightedAvgSpeedKmh !== null && Math.abs(c.flowWeightedAvgSpeedKmh - weighted) < 1e-9, String(c.flowWeightedAvgSpeedKmh));
  check("corridor: with unequal flows the flow-weighted speed is NOT the plain mean of the two directions (94 vs 70)", c.flowWeightedAvgSpeedKmh !== null && Math.abs(c.flowWeightedAvgSpeedKmh - (100 + 40) / 2) > 20);
  const eq = flowWeightedSpeed({ avgSpeedKmh: 100, throughputPerMin: 50 }, { avgSpeedKmh: 40, throughputPerMin: 50 });
  check("corridor: with EQUAL flows the weighted speed equals the plain mean (the weights cancel — the two only differ when flows do)", eq !== null && Math.abs(eq - 70) < 1e-9);
  const oneDead = flowWeightedSpeed({ avgSpeedKmh: 100, throughputPerMin: 60 }, { avgSpeedKmh: 0, throughputPerMin: 0 });
  check("corridor: a direction with no flow carries no weight (its speed cannot drag the total)", oneDead === 100);
  check("corridor: with no flow in either direction there is no weight, so the speed is null — never a plain-mean fallback", flowWeightedSpeed({ avgSpeedKmh: 100, throughputPerMin: 0 }, { avgSpeedKmh: 40, throughputPerMin: 0 }) === null);
  check("corridor: a negative flow is not a weight either", flowWeightedSpeed({ avgSpeedKmh: 100, throughputPerMin: -5 }, { avgSpeedKmh: 40, throughputPerMin: 10 }) === 40);
  check("corridor: density and travel time are deliberately absent from the total (not additive across carriageways)", !("densityPerKmLane" in c) && !("avgTravelTimeS" in c));
  const swapped = combineMetrics(sb, nb);
  check("corridor: combining is symmetric (NB/SB order changes nothing)", swapped.flowWeightedAvgSpeedKmh === c.flowWeightedAvgSpeedKmh && swapped.longestQueueM === c.longestQueueM && swapped.throughputPerMin === c.throughputPerMin);
  const bb = combineBaselines(
    { avgSpeedKmh: 100, throughputPerMin: 90, longestQueueM: 40, co2RatePerMin: 8 },
    { avgSpeedKmh: 40, throughputPerMin: 10, longestQueueM: 120, co2RatePerMin: 5 },
  );
  check("corridor baseline: built by the same rules as the corridor now (sum, max, flow-weighted), so a delta compares like with like",
    bb.throughputPerMin === 100 && bb.co2RatePerMin === 13 && bb.longestQueueM === 120 && bb.flowWeightedAvgSpeedKmh !== null && Math.abs(bb.flowWeightedAvgSpeedKmh - weighted) < 1e-9);
}

// Structure of the Both-mode UI that regex can see reliably (rendered behaviour is checked live in the
// browser): which tile says what, that density has no total, that click routing picks the carriageway
// from the click and refuses what maps to nothing, that the command proposal is pinned to its carriageway.
{
  const pageSource = readFileSync(new URL("../page.tsx", import.meta.url), "utf8");
  const panelSource = readFileSync(new URL("../components/ScenarioPanel.tsx", import.meta.url), "utf8");
  const hookSrc = readFileSync(new URL("../useDirectionSim.ts", import.meta.url), "utf8");
  check(
    "runtime guard: useDirectionSim's addScenarioEvent stores events ONLY through addEventToBucket(direction, ...) — there is no bare addEvent call left in the hook to bypass it",
    /const r = addEventToBucket\(direction, scenarioEventsRef\.current,/.test(hookSrc) && !/\baddEvent\(/.test(hookSrc) && /\[direction, scenarioFrame, closedLanes, closureM, closureEndM\]/.test(hookSrc),
  );
  const tileTags = [...pageSource.matchAll(/<MetricTileBoth\s+label="([^"]+)"\s+tag="([^"]+)"/g)].map((x) => `${x[1]}=${x[2]}`).join(", ");
  check(
    "page: Both-mode tiles label what kind of headline each is (avg speed flow-weighted, queue max, density per direction) — the tag is in the tile, not only in a tooltip",
    tileTags === "Active agents=total, Avg speed=flow-weighted, Throughput=total, Longest queue=max, CO₂ rate=total, Density=per direction",
    tileTags,
  );
  check("page: the density tile has NO corridor total (total={null})", /label="Density"\s+tag="per direction"[\s\S]{0,260}total=\{null\}/.test(pageSource));
  check(
    "page: the corridor totals come from combineMetrics/combineBaselines (one rule set), never re-derived inline",
    /combineMetrics\(nb\.metrics, sb\.metrics\)/.test(pageSource) && /combineBaselines\(nb\.baseline, sb\.baseline\)/.test(pageSource) && !/nb\.metrics\.avgSpeedKmh \+ sb\.metrics\.avgSpeedKmh/.test(pageSource),
  );
  check(
    "page: NB-only/SB-only still render the plain MetricTile row (Both mode adds MetricTileBoth, it does not replace it)",
    (pageSource.match(/<MetricTile\s+label=/g) ?? []).length >= 5 && /both \? \(\s*<div className="sandbox-metric-row">/.test(pageSource),
  );

  const clickStart = pageSource.indexOf("const handleCanvasClick = ");
  const clickEnd = pageSource.indexOf("const previewClosureAt = ");
  const clickSource = pageSource.slice(clickStart, clickEnd);
  check(
    "click routing (Both): the carriageway is read off WHICH band was clicked (NB band, SB band), from dualRoadLayout — not from focus",
    /dualRoadLayout\(\{/.test(clickSource) && /const inNB = cy >= layout\.nbRoadTop/.test(clickSource) && /const inSB = cy >= layout\.sbRoadTop/.test(clickSource) && /target = drafting \? armed : inNB \? "NB" : "SB";/.test(clickSource),
  );
  check(
    "click routing (Both): a click on the median, the axis or the verge (neither band) is refused with a message, not snapped to the nearest lane",
    /if \(!inNB && !inSB\) \{\s*setPlaceNote\(/.test(clickSource),
  );
  check(
    "click routing: the action lands on the CLICKED carriageway's own state (td), and focus moves there",
    /const td = byDirection\[target\];/.test(clickSource) && /td\.placeIncident\(lane, x\);\s*disarmPlacing\(\);[^\n]*\n\s*if \(both && target !== focusDirection\) setFocusedDirection\(target\);/.test(clickSource) &&
      /td\.setPlacingClosure\(true\);\s*\}\s*if \(both && target !== focusDirection\) setFocusedDirection\(target\);/.test(clickSource) &&
      !/focused\./.test(clickSource),
  );
  check("click routing: SB's drawn slot is un-reversed back to the engine lane (SB is drawn with lane 1 at the bottom of its block)", /const lane = both && target === "SB" \? lanes - 1 - drawnSlot : drawnSlot;/.test(clickSource));
  check(
    "Both mode layout: Southbound (right to left) is the TOP carriageway and Northbound (left to right) the bottom one, with the median and shared km axis between them, and the tab opens on Both",
    /const sbRoadTop = CANVAS_PAD \+ rampGutter;\s*const medianTop = sbRoadTop \+ sbRoadH;\s*const nbRoadTop = medianTop \+ MEDIAN_GUTTER_PX;/.test(pageSource) &&
      /useState<Direction \| "Both">\("Both"\)/.test(pageSource) && !/useState<Direction \| "Both">\("NB"\)/.test(pageSource),
  );
  check(
    "click routing: arming anything disarms everything first, and changing focus drops an armed mode (no invisible armed state)",
    /const armPlacing = [\s\S]{0,400}disarmPlacing\(\);/.test(pageSource) && /const chooseFocus = \(d: Direction\) => \{\s*if \(d !== focusDirection\) disarmPlacing\(\);/.test(pageSource),
  );
  check("click routing: Esc disarms wherever the mode is armed", /if \(e\.key === "Escape"\) disarmPlacing\(\);/.test(pageSource));

  check(
    "confidence run: disabled in Both mode regardless of events, with the stated message; replicate() is still called exactly once and untouched",
    /disabled=\{both \|\| focused\.scenarioEvents\.length > 0\}/.test(pageSource) &&
      /Confidence runs support one carriageway at a time\./.test(pageSource) &&
      /if \(both\) return;\s*if \(focused\.scenarioEvents\.length > 0\) return;/.test(pageSource) &&
      (pageSource.match(/= replicate\(/g) ?? []).length === 1,
  );
  const applyStart = pageSource.indexOf("const applyPlan = ");
  const applySource = pageSource.slice(applyStart, pageSource.indexOf("// clearIncidents, toggleLane", applyStart));
  check(
    "command: the proposal is pinned to the carriageway it was made for (planDirection), and Apply lands there even if focus has moved since",
    /const \[planDirection, setPlanDirection\] = useState<Direction \| null>\(null\);/.test(pageSource) &&
      /setPlanDirection\(sentDirection\);/.test(pageSource) &&
      /const planTarget = byDirection\[planDirection \?\? focusDirection\];/.test(applySource) &&
      !/focused\./.test(applySource),
  );
  check(
    "scenario panel: Both mode has an explicit 'Add to' carriageway picker and the Add button names the carriageway; the event is stamped with the picked direction",
    /data-scn="direction-pick"/.test(panelSource) && /`Add to \$\{DIRECTION_NAME\[direction\]\}`/.test(panelSource) && /const specFor = \(d: Direction\): NewEventSpec => \(\{ variant, direction: d,/.test(panelSource),
  );
  check(
    "scenario panel: conflicts, locks and the next event number are taken from the TARGET carriageway's own events (scoped within a direction)",
    /const target = data\[direction\];/.test(panelSource) && /addEventToBucket\(d, data\[d\]\.events, specFor\(d\), data\[d\]\.road, data\[d\]\.nextSeq, data\[d\]\.manualClosure\)/.test(panelSource),
  );
  check(
    "scenario panel: the long-skip guard applies in EVERY view (the single-direction skip and each Both-mode group use the same SkipControl, no off switch) and the threshold is two minutes",
    /<SkipControl data=\{dd\} \/>/.test(panelSource) && /<SkipControl data=\{target\} \/>/.test(panelSource) && !/<SkipControl[^>]*warn/.test(panelSource) && /const heavy = plan !== null && estimateMs !== null && estimateMs > SKIP_WARN_MS;/.test(panelSource) && /export const SKIP_WARN_MS = 120_000;/.test(panelSource),
  );
}

// --- rain intensity: light, moderate, heavy each cap traffic to their own assumed speed
{
  const caps = ASSUMPTIONS.RAIN_SPEED_KMH.value;
  check("rain intensity: the caps never rise with intensity — light >= moderate > heavy — and every one is below the engine's free-flow speed (108) and above zero", caps.light >= caps.moderate && caps.moderate > caps.heavy && caps.light < 108 && caps.heavy > 0, JSON.stringify(caps));
  check(
    "rain intensity: the caps are the engine's 108 km/h free-flow speed scaled by the NLEx study's rain / clear free-flow ratios (Mejia & Sigua 2018, Table 2: 109.79, 102.12, 101.46, 97.658) — 100, 100, 96 — recomputed here from the paper's own figures",
    NLEX_RAIN_FREE_FLOW_KMH.clear === 109.79 && NLEX_RAIN_FREE_FLOW_KMH.light === 102.12 && NLEX_RAIN_FREE_FLOW_KMH.moderate === 101.46 && NLEX_RAIN_FREE_FLOW_KMH.heavy === 97.658 &&
      CLASS_META[1].v0 * 3.6 === 108 &&
      caps.light === Math.round((108 * 102.12) / 109.79) && caps.moderate === Math.round((108 * 101.46) / 109.79) && caps.heavy === Math.round((108 * 97.658) / 109.79) &&
      caps.light === 100 && caps.moderate === 100 && caps.heavy === 96,
    JSON.stringify(caps),
  );
  const rainAssumption = ASSUMPTIONS.RAIN_SPEED_KMH;
  check(
    "rain intensity: the assumption cites its source (author, year, journal, URL), the site, and says a speed cap is a proxy that understates capacity loss because the engine cannot vary following headways",
    /Mejia/.test(rainAssumption.evidence ?? "") && /Sigua/.test(rainAssumption.evidence ?? "") && /2018/.test(rainAssumption.evidence ?? "") && /Philippine Transportation Journal/.test(rainAssumption.evidence ?? "") &&
      /https:\/\/ncts\.upd\.edu\.ph\/tssp\/wp-content\/uploads\/2018\/08\/Mejia18\.pdf/.test(rainAssumption.evidence ?? "") && /Km 11\+150/.test(rainAssumption.evidence ?? "") &&
      /following headways/.test(rainAssumption.reason) && /cannot vary headway/.test(rainAssumption.reason) && /UNDERSTATES the capacity loss/.test(rainAssumption.reason) && /PROXY/.test(rainAssumption.reason),
  );
  check("rain intensity: the template offers exactly light, moderate, heavy, in that order, each with a label", (() => { const tpl = TEMPLATE_BY_FAMILY.rain; return tpl.intensities.map((i) => i.id).join() === "light,moderate,heavy" && tpl.intensities.every((i) => i.label.length > 0) && RAIN_INTENSITIES.join() === "light,moderate,heavy"; })());
  check("rain intensity: the family is named Rain and its default intensity is offered", TEMPLATE_BY_FAMILY.rain.displayName === "Rain" && TEMPLATE_BY_FAMILY.rain.intensities.some((i) => i.id === TEMPLATE_BY_FAMILY.rain.defaultIntensity));
  const dv = defaultVariant("rain");
  check("rain intensity: defaultVariant carries the template's default intensity", dv.family === "rain" && dv.intensity === TEMPLATE_BY_FAMILY.rain.defaultIntensity);
  let names = "";
  let appliedOk = true;
  for (const [i, intensity] of RAIN_INTENSITIES.entries()) {
    const ev = must([], rainSpec(330, 0, manualMinutes(30), "NB", intensity), i + 1).event;
    names += `${ev.name};`;
    const c = composeInterventions({ ...idle, incidents: [] }, [ev], abs(1), road600);
    if (c.interventions.speedLimitKmh !== caps[intensity] || c.interventions.speedZone[0] !== 0 || c.interventions.speedZone[1] !== 600 || c.owners.closure !== null) appliedOk = false;
  }
  check("rain intensity: each intensity is applied as ITS OWN cap over the whole segment and blocks no lane", appliedOk);
  check("rain intensity: the event name says how hard it rains (Light rain #1; Moderate rain #2; Heavy rain #3)", names === "Light rain #1;Moderate rain #2;Heavy rain #3;", names);
  check("rain intensity: the panel's phase says Raining, so a light event is not labelled heavy", TEMPLATE_BY_FAMILY.rain.phases[0].label === "Raining");
}

// --- scene marks: what the canvas draws for an event is a pure function of the event, the clock and what the engine owns
const roadMarks = (evs: readonly ScenarioEvent[], min: number, owners = NO_OWNERS): readonly SceneMark[] => sceneMarks(evs, road600, abs(min), owners);
{
  const ev = must([], collisionSpec("minor_collision", 1, 330, 5, manualMinutes(10), "NB"), 1).event;
  const owns = composeInterventions({ ...idle, incidents: [] }, [ev], abs(6), road600).owners;
  const [active] = roadMarks([ev], 6, owns);
  check("scene marks: an event that has not started is 'pending', has no phase, holds no lanes and no stretch", (() => { const [p] = roadMarks([ev], 1); return p.state === "pending" && p.phaseId === null && p.phaseFraction === 0 && p.closedLanes.length === 0 && p.stretch === null; })());
  check(
    "scene marks: a running collision reports its family, phase, and EXACTLY the lanes and stretch the engine's closure owner holds",
    active.state === "active" && active.family === "minor_collision" && active.phaseId === "blocked" && owns.closure !== null &&
      active.closedLanes.join() === owns.closure.lanes.join() && active.closedLanes.length > 0 &&
      active.stretch !== null && active.stretch.fromM === owns.closure.closurePointM && active.stretch.toM === owns.closure.closureEndM,
  );
  check("scene marks: the phase fraction is 0 at the start of a phase and rises toward 1 within it", roadMarks([ev], 5.02, owns)[0].phaseFraction < 0.05 && roadMarks([ev], 8, owns)[0].phaseFraction > roadMarks([ev], 6, owns)[0].phaseFraction);
  const yielded = composeInterventions({ ...idle, closedLanes: [true, false, false, false], closurePoint: 100, closureEnd: 200, incidents: [] }, [ev], abs(6), road600).owners;
  const [y] = roadMarks([ev], 6, yielded);
  check("scene marks: an event that yielded its closure to the operator's own is still active but holds NO lanes and NO stretch (so no wreck is drawn where traffic is not blocked)", y.state === "active" && y.closedLanes.length === 0 && y.stretch === null && yielded.closure === null && hasSceneArt(y) === false);
  check("scene marks: a finished event is gone", roadMarks([ev], 60, owns).length === 0);
  const rain = roadMarks([must([], rainSpec(330, 0, manualMinutes(30), "NB", "light"), 1).event], 1)[0];
  check("scene marks: rain carries its intensity and holds nothing on the road; other families carry none", rain.intensity === "light" && rain.closedLanes.length === 0 && rain.stretch === null && active.intensity === null);
  check(
    "scene marks: rain carries the cap its intensity applies (from RAIN_SPEED_KMH) for the speed sign; nothing else carries one",
    RAIN_INTENSITIES.every((i, n) => roadMarks([must([], rainSpec(330, 0, manualMinutes(30), "NB", i), n + 1).event], 1)[0].capKmh === ASSUMPTIONS.RAIN_SPEED_KMH.value[i]) && active.capKmh === null,
  );
  const ev2 = must([], collisionSpec("minor_collision", 1, 330, 5, manualMinutes(10), "NB"), 2).event;
  const owns2 = composeInterventions({ ...idle, incidents: [] }, [ev2], abs(6), road600).owners;
  const both = roadMarks([ev, ev2], 6, owns2);
  const markOf = (id: string): SceneMark | undefined => both.find((m) => m.eventId === id);
  check(
    "scene marks: with two events on one road, ONLY the one the engine's closure owner names holds lanes (the other draws no wreck, whatever its own dates say)",
    owns2.closure !== null && owns2.closure.eventId === ev2.id && (markOf(ev2.id)?.closedLanes.length ?? 0) > 0 && markOf(ev.id)?.closedLanes.length === 0 && markOf(ev.id)?.stretch === null,
  );
  const truck = roadMarks([must([], inLaneSpec("truck", 3, 330, 0, manualMinutes(10)), 1).event], 1)[0];
  check("scene marks: a breakdown carries its vehicle; a collision does not", truck.vehicle === "truck" && active.vehicle === null);
  check(
    "scene marks: hasSceneArt — rain and breakdowns always; flood, roadworks and collisions only while they hold lanes (a collision also in its clearing phase, when the cones and police remain)",
    hasSceneArt(rain) && hasSceneArt(truck) &&
      hasSceneArt(active) &&
      !hasSceneArt({ ...active, closedLanes: [], stretch: null }) &&
      hasSceneArt({ ...active, closedLanes: [], stretch: null, phaseId: "clearing" }) &&
      !hasSceneArt({ ...active, family: "flood", closedLanes: [], stretch: null }) && hasSceneArt({ ...active, family: "flood" }) &&
      !hasSceneArt({ ...active, family: "scheduled_roadworks", closedLanes: [], stretch: null }) && hasSceneArt({ ...active, family: "scheduled_roadworks" }) &&
      !hasSceneArt({ ...active, state: "pending" }),
  );
}

// --- scene art, run in Node against a recording context: how much is painted, what freezes, what draws nothing
{
  class Recorder implements SceneCtx {
    readonly calls: string[] = [];
    readonly texts: string[] = [];
    readonly strokeStyles: string[] = [];
    fillStyle: SceneCtx["fillStyle"] = "#000";
    strokeStyle: SceneCtx["strokeStyle"] = "#000";
    lineWidth = 1;
    lineJoin: CanvasLineJoin = "miter";
    font = "10px sans-serif";
    textAlign: CanvasTextAlign = "start";
    textBaseline: CanvasTextBaseline = "alphabetic";
    private log(name: string, ...nums: number[]): void {
      this.calls.push(`${name} ${nums.map((n) => n.toFixed(2)).join(" ")}`.trim());
    }
    save(): void { this.log("save"); }
    restore(): void { this.log("restore"); }
    translate(x: number, y: number): void { this.log("translate", x, y); }
    scale(x: number, y: number): void { this.log("scale", x, y); }
    rotate(a: number): void { this.log("rotate", a); }
    beginPath(): void { this.log("beginPath"); }
    closePath(): void { this.log("closePath"); }
    moveTo(x: number, y: number): void { this.log("moveTo", x, y); }
    lineTo(x: number, y: number): void { this.log("lineTo", x, y); }
    arc(x: number, y: number, r: number): void { this.log("arc", x, y, r); }
    arcTo(x1: number, y1: number, x2: number, y2: number): void { this.log("arcTo", x1, y1, x2, y2); }
    ellipse(x: number, y: number, rx: number, ry: number): void { this.log("ellipse", x, y, rx, ry); }
    rect(x: number, y: number, w: number, h: number): void { this.log("rect", x, y, w, h); }
    fill(): void { this.log("fill"); }
    stroke(): void { this.strokeStyles.push(String(this.strokeStyle)); this.log("stroke"); }
    clip(): void { this.log("clip"); }
    fillRect(x: number, y: number, w: number, h: number): void { this.log("fillRect", x, y, w, h); }
    strokeRect(x: number, y: number, w: number, h: number): void { this.log("strokeRect", x, y, w, h); }
    fillText(text: string, x: number, y: number): void { this.texts.push(text); this.log("fillText", x, y); }
    createLinearGradient(): CanvasGradient { this.log("gradient"); return { addColorStop: () => undefined }; }
    setLineDash(): void { this.log("setLineDash"); }
    count(prefix: string): number { return this.calls.filter((c) => c === prefix || c.startsWith(`${prefix} `)).length; }
  }
  const geom = (ctx: SceneCtx, t: number, fwd: 1 | -1 = 1): SceneGeometry => ({
    ctx, cssW: 800, roadTop: 20, roadH: 120, laneH: 30, xPx: (m) => (fwd === 1 ? m * 1.3 : 800 - m * 1.3), fwd,
    laneCenterY: (l) => 20 + l * 30 + 15, outerEdgeY: 140, outward: 1, carLen: 24, carWid: 13, t,
  });
  const base: SceneMark = {
    eventId: "e1", name: "x", kind: "speed_zone", state: "active", xM: 300, lane: null, text: "", family: "rain", phaseId: "active", phaseFraction: 0.5,
    closedLanes: [], stretch: null, intensity: "heavy", capKmh: 60, vehicle: null,
  };
  const paintWeather = (marks: readonly SceneMark[], t: number): Recorder => { const r = new Recorder(); drawWeather(geom(r, t), marks); return r; };
  const drops = (r: Recorder): number => r.count("lineTo");
  const light = paintWeather([{ ...base, intensity: "light" }], 1.0);
  const moderate = paintWeather([{ ...base, intensity: "moderate" }], 1.0);
  const heavy = paintWeather([{ ...base, intensity: "heavy" }], 1.0);
  check("rain art: the harder it rains, the more drops are drawn (light < moderate < heavy, heavy more than double light)", drops(light) < drops(moderate) && drops(moderate) < drops(heavy) && drops(heavy) > 2 * drops(light), `${drops(light)} < ${drops(moderate)} < ${drops(heavy)}`);
  check("rain art: the drops are clipped to the carriageway (a clip is applied before any drop is drawn)", heavy.calls.indexOf("clip") > -1 && heavy.calls.indexOf("clip") < heavy.calls.findIndex((c) => c.startsWith("lineTo")));
  check("rain art: the drops and the wet tint stay inside the carriageway (the clip is exactly the road's rectangle, not a margin around it)", heavy.calls.includes("rect 0.00 20.00 800.00 120.00") && heavy.calls.filter((c) => c.startsWith("rect ")).length === 1);
  check("rain art: a speed-limit sign shows the intensity's cap (96 heavy, 100 light as fixtures), and no sign is drawn for a mark with no cap", paintWeather([{ ...base, intensity: "heavy", capKmh: 96 }], 1).texts.join() === "96" && paintWeather([{ ...base, intensity: "light", capKmh: 100 }], 1).texts.join() === "100" && paintWeather([{ ...base, capKmh: null }], 1).texts.length === 0);
  check("rain art: it is deterministic — the same clock paints the same picture, exactly (which is what makes a paused run freeze)", paintWeather([base], 2.5).calls.join("|") === paintWeather([base], 2.5).calls.join("|"));
  check("rain art: a later clock moves the drops (the animation actually animates)", paintWeather([base], 2.5).calls.join("|") !== paintWeather([base], 2.6).calls.join("|"));
  const alphaOf = (style: string): number => Number(/,([0-9.]+)\)$/.exec(style)?.[1] ?? "0");
  // the first two strokes of a weather pass are the two layers of drops (far, then near); the ripples come after
  const layers = (r: Recorder): string[] => r.strokeStyles.slice(0, 2);
  check(
    "rain art: the drops are sky blue — the far layer #87CEFA (135,206,250), the near layer #9CDDEC (156,221,236) — and clearly opaque even in light rain (alpha at least 0.5, higher in heavy)",
    [light, moderate, heavy].every((r) => layers(r)[0]?.startsWith("rgba(135,206,250,") === true && layers(r)[1]?.startsWith("rgba(156,221,236,") === true) &&
      Math.min(...layers(light).map(alphaOf)) >= 0.5 && Math.min(...layers(light).map(alphaOf)) < Math.min(...layers(heavy).map(alphaOf)),
  );
  const dropPath = (r: Recorder): string => r.calls.filter((c) => c.startsWith("moveTo ") || c.startsWith("lineTo ")).join("|");
  check("rain art: the DROPS themselves fall — their positions change with the clock (not just the ripples)", dropPath(paintWeather([base], 2.5)) !== dropPath(paintWeather([base], 2.6)) && dropPath(paintWeather([base], 2.5)).length > 0);
  check("rain art: an event that has not started draws no rain, and neither does an empty list", paintWeather([{ ...base, state: "pending" }], 1).calls.length === 0 && paintWeather([], 1).calls.length === 0);
  check("rain art: two rain events at once draw the STRONGER one only (one sky, not two)", paintWeather([{ ...base, intensity: "light" }, { ...base, eventId: "e2", intensity: "heavy" }], 1).calls.join("|") === heavy.calls.join("|"));

  const floodMark: SceneMark = { ...base, family: "flood", kind: "closure", phaseId: "active", closedLanes: [2], stretch: { fromM: 250, toM: 400 }, intensity: null, lane: 2 };
  const paintWater = (marks: readonly SceneMark[], t: number): Recorder => { const r = new Recorder(); drawWater(geom(r, t), marks); return r; };
  const water = paintWater([floodMark], 1.0);
  check("flood art: water is drawn over the flooded lane (clipped to its shoreline, with a gradient body)", water.count("clip") >= 1 && water.count("gradient") >= 1 && water.count("stroke") > 3);
  check("flood art: the water FLOWS — the picture changes with the clock", paintWater([floodMark], 1.0).calls.join("|") !== paintWater([floodMark], 1.4).calls.join("|"));
  const streakPath = (r: Recorder): string => { const from = r.calls.indexOf("gradient"); const to = r.calls.findIndex((c, i) => i > from && c.startsWith("ellipse")); return r.calls.slice(from, to).join("|"); };
  check("flood art: the flowing streaks themselves move with the clock (not just the shoreline and glints), and there are several of them", streakPath(paintWater([floodMark], 1.0)) !== streakPath(paintWater([floodMark], 1.4)) && water.count("stroke") >= 5);
  check("flood art: a flood that holds no lane (yielded to the operator) draws no water, and a pending one draws none", paintWater([{ ...floodMark, closedLanes: [], stretch: null }], 1).calls.length === 0 && paintWater([{ ...floodMark, state: "pending" }], 1).calls.length === 0);
  check("flood art: the water spans the flooded stretch — it is drawn at the stretch's own x range and nowhere near a far-away lane position", (() => { const xs = water.calls.filter((c) => c.startsWith("lineTo ")).map((c) => Number(c.split(" ")[1])).filter((x) => Number.isFinite(x)); return Math.min(...xs) >= 250 * 1.3 - 12 && Math.max(...xs) <= 400 * 1.3 + 12; })());

  const collision: SceneMark = { ...base, family: "multi_vehicle_collision", kind: "closure", phaseId: "blocked", closedLanes: [1], stretch: { fromM: 250, toM: 350 }, intensity: null, lane: 1, phaseFraction: 0.9 };
  const paintScene = (marks: readonly SceneMark[], t = 1): Recorder => { const r = new Recorder(); drawScenes(geom(r, t), marks); return r; };
  const blocked = paintScene([collision]);
  const towing = paintScene([{ ...collision, phaseId: "tow", phaseFraction: 0.6 }]);
  const clearing = paintScene([{ ...collision, phaseId: "clearing", closedLanes: [], stretch: null }]);
  check("scene art: a wreck is painted while lanes are blocked, more is painted with the tow trucks in, and far less once only the cones remain", blocked.calls.length > 300 && towing.calls.length > blocked.calls.length * 0.9 && clearing.calls.length < blocked.calls.length / 2, `${blocked.calls.length} / ${towing.calls.length} / ${clearing.calls.length}`);
  check("scene art: an event holding no lane and not clearing paints nothing (no wreck the engine is not honouring)", paintScene([{ ...collision, closedLanes: [], stretch: null }]).calls.length === 0);
  check("scene art: a pending event paints nothing (it keeps the faint marker)", paintScene([{ ...collision, state: "pending" }]).calls.length === 0);
  check("scene art: hazard lights and beacons blink — the picture changes with the clock (and repeats exactly for the same clock)", paintScene([collision], 1.0).calls.join("|") !== paintScene([collision], 1.25).calls.join("|") && paintScene([collision], 1.0).calls.join("|") === paintScene([collision], 1.0).calls.join("|"));
  check("scene art: southbound is the mirror — traffic drawn right to left still paints a scene of the same size", Math.abs(paintScene([collision], 1).calls.length - (() => { const r = new Recorder(); drawScenes(geom(r, 1, -1), [collision]); return r.calls.length; })()) < 40);
  const allFamilies: readonly FamilyKey[] = ["breakdown_in_lane", "breakdown_shoulder", "minor_collision", "multi_vehicle_collision", "self_accident", "overturned_vehicle", "scheduled_roadworks"];
  check(
    "scene art: every family that draws a scene paints something when it holds what it needs, without throwing",
    allFamilies.every((f) => paintScene([{ ...collision, family: f, phaseId: f === "breakdown_in_lane" || f === "breakdown_shoulder" ? "waiting" : "blocked", vehicle: f.startsWith("breakdown") ? "truck" : null }]).calls.length > 20),
  );
  const roadworks = paintScene([{ ...collision, family: "scheduled_roadworks", phaseId: "active" }]);
  check("scene art: roadworks paint a work zone — cones, barrels, a truck and its lit arrow board (many arcs and filled rects)", roadworks.count("arc") > 15 && roadworks.count("fillRect") > 5);
  const barrierA = new Recorder();
  drawMovableBarrier(barrierA, 800, 200, 6, 1, 1);
  const barrierB = new Recorder();
  drawMovableBarrier(barrierB, 800, 200, 6, 3, 1);
  check("reallocation art: the movable barrier is a chain of segments with a transfer vehicle that MOVES along it", barrierA.count("arcTo") > 100 && barrierA.calls.join("|") !== barrierB.calls.join("|"));
  const lanesR = new Recorder();
  drawBorrowedLanes(geom(lanesR, 1), 1, "REALLOCATED");
  const noLanes = new Recorder();
  drawBorrowedLanes(geom(noLanes, 1), 0, "REALLOCATED");
  check("reallocation art: borrowed lanes are marked (wash, chevrons, an edge line and the scheme's name); none borrowed paints nothing", lanesR.count("fillRect") >= 1 && lanesR.count("fillText") === 1 && lanesR.count("stroke") > 5 && noLanes.calls.length === 0);
}

// --- lane reallocation (was zipper lane / counterflow): the lane-transfer rules, pure
{
  const b44 = { NB: 4, SB: 4 } as const;
  const okNB1 = planZipper(b44, "NB", 1);
  const okNB2 = planZipper(b44, "NB", 2);
  const okSB2 = planZipper(b44, "SB", 2);
  check("lane reallocation: from 4 + 4, one lane moves either way (5 + 3, 3 + 5) and the total stays 8", okNB1.ok && okNB1.counts.NB === 5 && okNB1.counts.SB === 3 && planZipper(b44, "SB", 1).ok && (() => { const p = planZipper(b44, "SB", 1); return p.ok && p.counts.SB === 5 && p.counts.NB === 3; })());
  check("lane reallocation: from 4 + 4, counterflow moves two lanes (6 + 2, 2 + 6), the most the limits allow, total kept", okNB2.ok && okNB2.counts.NB === 6 && okNB2.counts.SB === 2 && okSB2.ok && okSB2.counts.SB === 6 && okSB2.counts.NB === 2);
  const tooFew = planZipper({ NB: 3, SB: 3 }, "NB", 2);
  const tooMany = planZipper({ NB: 5, SB: 5 }, "NB", 2);
  const nonsense = [planZipper(b44, "NB", 0), planZipper(b44, "NB", 3), planZipper(b44, "NB", 1.5)];
  check("lane reallocation: a transfer that would leave the donor below 2 lanes is refused, saying which carriageway and how many lanes", !tooFew.ok && tooFew.reason.includes("SB") && tooFew.reason.includes("1 lane") && tooFew.reason.includes("at least 2"), tooFew.ok ? "" : tooFew.reason);
  check("lane reallocation: a transfer that would take the recipient past 6 lanes is refused, saying so", !tooMany.ok && tooMany.reason.includes("NB") && tooMany.reason.includes("7") && tooMany.reason.includes("6"), tooMany.ok ? "" : tooMany.reason);
  check("lane reallocation: 0, 3 or a fractional number of lanes is refused", nonsense.every((p) => !p.ok));
  check("lane reallocation: the limits are the recorded assumption (min 2, max 6, at most 2 moved), not numbers scattered in the code", ASSUMPTIONS.ZIPPER_LANES.value.minLanes === 2 && ASSUMPTIONS.ZIPPER_LANES.value.maxLanes === 6 && ASSUMPTIONS.ZIPPER_LANES.value.maxTransfer === 2);
  check("lane reallocation: the lane total is conserved by every accepted transfer, over every base 2..5 + 2..5, both directions, 1 and 2 lanes", (() => {
    for (let a = 2; a <= 5; a++) for (let b = 2; b <= 5; b++) for (const to of ["NB", "SB"] as const) for (const n of [1, 2]) {
      const p = planZipper({ NB: a, SB: b }, to, n);
      if (p.ok && (p.counts.NB + p.counts.SB !== a + b || p.counts.NB < 2 || p.counts.SB < 2 || p.counts.NB > 6 || p.counts.SB > 6)) return false;
    }
    return true;
  })());
  if (!okNB1.ok) throw new Error("fixture");
  const held = { NB: 5, SB: 3 };
  check("lane reallocation: zipperCounts reproduces what the plan set, and zipperHolds is true only while the lane counts are exactly those", zipperCounts(okNB1.state).NB === 5 && zipperCounts(okNB1.state).SB === 3 && zipperHolds(okNB1.state, held) && !zipperHolds(okNB1.state, { NB: 4, SB: 3 }) && !zipperHolds(okNB1.state, { NB: 5, SB: 4 }) && !zipperHolds(okNB1.state, b44));
  check("lane reallocation: only the carriageway that GAINED lanes has borrowed ones (the innermost n); the donor and 'no scheme' have none", borrowedLanes(okNB1.state, "NB") === 1 && borrowedLanes(okNB1.state, "SB") === 0 && borrowedLanes(okNB2.ok ? okNB2.state : null, "NB") === 2 && borrowedLanes(null, "NB") === 0);
  check("lane reallocation: the scheme is called 'Lane reallocation' — one name for one or two lanes", REALLOCATION_NAME === "Lane reallocation");
  // the engine really does run at the lane counts a scheme produces (2 and 6), fills them and stays finite
  let runs = "";
  for (const lanes of [2, 6]) {
    const e = new TrafficSim({ length: 600, laneCount: lanes, inflowVehPerHour: 4500, seed: 7, warmupS: 60 });
    for (let i = 0; i < 6000; i++) e.step(0.05);
    const m = e.metrics();
    const maxLane = Math.max(-1, ...e.vehicles.map((v) => v.lane));
    if (!(m.activeAgents > 0) || !Number.isFinite(m.avgSpeedKmh) || maxLane > lanes - 1) runs += `${lanes} lanes failed (agents ${m.activeAgents}, max lane ${maxLane}); `;
  }
  // per-lane capacity at 6 lanes is what it is at 4: same road, same seeds, saturating demand (2,600 veh/h/lane),
  // admitted flow per lane = (inflow - the engine's own unmet demand) / lanes at the end of 900 simulated seconds
  const admittedPerLane = (lanes: number): number => {
    const inflow = 2600 * lanes;
    const e = new TrafficSim({ length: 1000, laneCount: lanes, inflowVehPerHour: inflow, seed: 11, warmupS: 60 });
    for (let i = 0; i < 18000; i++) e.step(0.05);
    return (inflow - e.metrics().unmetVehPerHour) / lanes;
  };
  const cap4 = admittedPerLane(4);
  const cap6 = admittedPerLane(6);
  check("lane reallocation: 6 lanes carry the same flow per lane as 4 (within 5%) at saturating demand — the engine's capacity scales with lanes up to the largest carriageway a reallocation can make", cap4 > 1500 && Math.abs(cap6 - cap4) / cap4 < 0.05, `${cap4.toFixed(0)} vs ${cap6.toFixed(0)} veh/h/lane`);
  check("lane reallocation: the engine runs at 2 and at 6 lanes (the extremes a scheme can produce) — vehicles are present, speeds finite, none outside the lanes", runs === "", runs);
}

// --- Rain intensity / scene art / lane reallocation wiring in the page and panel (source checks: page.tsx cannot be imported by Node)
{
  const pageSource = readFileSync(new URL("../page.tsx", import.meta.url), "utf8");
  const panelSource = readFileSync(new URL("../components/ScenarioPanel.tsx", import.meta.url), "utf8");
  const artSource = readFileSync(new URL("../sceneArt.ts", import.meta.url), "utf8");
  const previewSource = readFileSync(new URL("../components/ScenePreview.tsx", import.meta.url), "utf8");
  const imports = artSource.match(/^import .*$/gm) ?? [];
  check("scene art is pure drawing: it imports only TYPES (no engine, no adapter logic), and never touches the engine's interventions or a TrafficSim", imports.length > 0 && imports.every((l) => l.startsWith("import type ")) && !/TrafficSim|\.interventions|simRef/.test(artSource));
  check("scene art: the animation clock advances only while the run is running (a paused road freezes its rain, water and beacons)", /if \(running\) animClockRef\.current \+= dtReal;/.test(pageSource));
  check("scene art: the road draws scenes from sceneMarks(events, road, sim.time, owners) — what the engine's binding owns, not a second reading of the events", /sceneMarks\(overlay\.events, roadOf\(sim, overlay\.frame\), sim\.time, overlay\.owners\)/.test(pageSource) && /owners: nb\.owners/.test(pageSource) && /owners: sb\.owners/.test(pageSource));
  check("scene art: the amber triangle marker is now only for an event with no scene to show (not started, or holding nothing)", /if \(!hasSceneArt\(m\)\) drawScenarioMarker\(ctx, x, laneY, g\.r, faint\);/.test(pageSource) && /if \(overlay && overlay\.isScenarioIncident\(inc\)\) continue;/.test(pageSource));
  check("scene art: water goes under the traffic and scenes, weather over both, labels last", pageSource.indexOf("drawWater(") > -1 && pageSource.indexOf("drawWater(") < pageSource.indexOf("drawScenes(sceneGeom") && pageSource.indexOf("drawScenes(sceneGeom") < pageSource.indexOf("drawWeather(sceneGeom") && pageSource.indexOf("drawWeather(sceneGeom") < pageSource.indexOf("drawScenarioLabels(ctx, scenes"));
  check("rain: the engine's orange speed-zone wash is skipped when the zone is a rain event's (the sign and the rain say it; the orange made the road look brown)", /const rainOwnsZone =/.test(pageSource) && /e\.variant\.family === "rain"/.test(pageSource) && /sim\.interventions\.speedLimitKmh != null && !rainOwnsZone/.test(pageSource));
  check("scene art: a label for a scene that holds lanes sits on the seam just past them (or before, at the road's edge), centred on the stretch — never on top of the water, works or wreck", /if \(hasSceneArt\(m\) && m\.closedLanes\.length > 0\) \{/.test(pageSource) && /const cx = heldStretch === null \? x : g\.xPx\(\(heldStretch\.fromM \+ heldStretch\.toM\) \/ 2\);/.test(pageSource));
  check("lane reallocation: while a scheme is on, both Lanes sliders reach the zipper limit (a 6-lane carriageway is not shown as 5), and they are the corridor's 5 otherwise", (pageSource.match(/max=\{laneSliderMax\}/g) ?? []).length === 2 && !/max=\{5\}/.test(pageSource) && /zipper === null \? 5 : Math\.max\(5, ASSUMPTIONS\.ZIPPER_LANES\.value\.maxLanes\)/.test(pageSource));
  check("lane reallocation: the shared km axis gets a dark chip behind its numbers while the striped barrier is drawn", /backdrop: zipper !== null/.test(pageSource));
  const resetHookSource = readFileSync(new URL("../useDirectionSim.ts", import.meta.url), "utf8");
  check(
    "reset: the button resets EVERYTHING, scenarios included — both carriageways (resetAll), a lane reallocation undone, a command proposal and old confidence result dropped, and the Add-event form remounted on its defaults",
    /onClick=\{resetEverything\}/.test(pageSource) && !/onClick=\{\(\) => \{ nb\.rebuild\(\); sb\.rebuild\(\); \}\}/.test(pageSource) &&
      /const resetEverything = \(\) => \{\s*if \(zipper !== null\) \{\s*nb\.setLaneCount\(zipper\.base\.NB\);\s*sb\.setLaneCount\(zipper\.base\.SB\);\s*setZipper\(null\);\s*\}\s*nb\.resetAll\(\);\s*sb\.resetAll\(\);\s*disarmPlacing\(\);\s*setPlan\(null\);\s*setCommandError\(null\);\s*setRepResult\(null\);\s*setScenarioFormKey\(\(k\) => k \+ 1\);\s*\};/.test(pageSource) &&
      /<ScenarioPanel\s+key=\{scenarioFormKey\}/.test(pageSource),
  );
  check(
    "reset: resetAll on each carriageway removes every scenario event and restarts the numbering, puts away the closure / zone stretch positions and any armed placing tool, then rebuilds the run",
    /const resetAll = useCallback\(\(\) => \{\s*scenarioEventsRef\.current = \[\];\s*setScenarioEvents\(\[\]\);\s*scenarioSeqRef\.current = 0;\s*setClosureKm\(null\);\s*setClosureEndKm\(null\);\s*setZoneFromKm\(null\);\s*setZoneToKm\(null\);\s*setPlacingIncident\(false\);\s*setPlacingClosure\(false\);\s*setClosureDraftKm\(null\);\s*rebuild\(\);\s*\}, \[rebuild\]\);/.test(resetHookSource) && /\n    resetAll,\n/.test(resetHookSource),
  );
  check(
    "focus: there is no separate Focus control in the toolbar — every one-road-at-a-time thing carries its own NB / SB choice (Add to, Commands apply to, Load forecast into, and the full-screen Acting on switch), all moving the same state",
    !/aria-label="Focused carriageway"/.test(pageSource) && !/>Focus<\/span>/.test(pageSource) && /data-forecast="direction"/.test(pageSource) && /Commands apply to/.test(pageSource) &&
      /aria-label="Carriageway the full-screen controls act on"/.test(pageSource) && /data-scn="direction-pick"/.test(panelSource) && (pageSource.match(/onClick=\{\(\) => chooseFocus\(dn\)\}/g) ?? []).length === 3,
  );
  check(
    "carriageway view buttons read Both, Northbound, Southbound (in that order), and the vehicle sprites have a 15 px legibility floor",
    /\{\(\["Both", "NB", "SB"\] as const\)\.map\(\(v\) => \(/.test(pageSource) && !/\{\(\["NB", "SB", "Both"\] as const\)\.map\(\(v\) => \(/.test(pageSource) && /const MIN_LEN_PX = 15;/.test(pageSource),
  );
  check(
    "traffic sprites: vehicles are painted from vehiclePaint.ts by the vehicle's id (trailer painted separately), classes are told apart by shape, and the legend shows the shapes rather than class colours",
    /import \{ PAINT_WHITE, paintFor, trailerPaintFor, type Paint \} from "\.\/vehiclePaint";/.test(pageSource) &&
      /drawVehicle\(ctx, xPx\(v\.x\), y, len, wid, v\.vClass, paintFor\(v\.id, v\.vClass\), braking, sb, trailerPaintFor\(v\.id\)\);/.test(pageSource) && !/v\.color/.test(pageSource) &&
      /<i className="veh veh-1" \/>/.test(pageSource) && /<i className="veh veh-3" \/>/.test(pageSource) && !/CLASS_META\[[123]\]\.color/.test(pageSource),
  );
  // ── the colours themselves: a realistic spread, stable per vehicle ─────────
  {
    const N = 20000;
    const share = (table: readonly (readonly [Paint, number])[], of: (id: number) => Paint): readonly number[] => {
      const counts = table.map(() => 0);
      for (let id = 0; id < N; id++) counts[table.findIndex(([p]) => p === of(id))]++;
      return counts.map((c) => (c / N) * 100);
    };
    const near = (table: readonly (readonly [Paint, number])[], got: readonly number[], tol: number): boolean => table.every(([, w], i) => Math.abs(got[i] - w) <= tol);
    const sum = (table: readonly (readonly [Paint, number])[]): number => table.reduce((a, [, w]) => a + w, 0);
    check("vehicle colours: every palette table's weights add to 100", [CAR_PAINTS, BUS_PAINTS, CAB_PAINTS, TRAILER_PAINTS].every((tb) => sum(tb) === 100));
    const cars = share(CAR_PAINTS, (id) => paintFor(id, 1));
    check("vehicle colours: cars come out in the stated mix over 20,000 vehicles (white, silver, grey and black lead; blues, reds and the rest follow), every share within 2 points", near(CAR_PAINTS, cars, 2), cars.map((c) => c.toFixed(1)).join(" "));
    check("vehicle colours: a realistic spread — cars use at least 12 different paints, and the four neutrals (white, silver, grey, black) are about two thirds, not all of them", CAR_PAINTS.length >= 12 && new Set(Array.from({ length: N }, (_, id) => paintFor(id, 1))).size >= 12 && cars[0] + cars[1] + cars[2] + cars[3] > 55 && cars[0] + cars[1] + cars[2] + cars[3] < 75);
    check("vehicle colours: buses wear liveries (white, blue, red, green, yellow, orange) in their stated mix, and truck cabs and trailers are drawn from their own tables", near(BUS_PAINTS, share(BUS_PAINTS, (id) => paintFor(id, 2)), 2) && near(CAB_PAINTS, share(CAB_PAINTS, (id) => paintFor(id, 3)), 2) && near(TRAILER_PAINTS, share(TRAILER_PAINTS, (id) => trailerPaintFor(id)), 2));
    check("vehicle colours: a vehicle keeps its colour — the same id always gets the same paint, and a truck's trailer is chosen independently of its cab (they differ for a good share of trucks)", Array.from({ length: 500 }, (_, id) => paintFor(id, 1) === paintFor(id, 1) && paintFor(id, 3) === paintFor(id, 3) && trailerPaintFor(id) === trailerPaintFor(id)).every(Boolean) && Array.from({ length: 2000 }, (_, id) => paintFor(id, 3) !== trailerPaintFor(id)).filter(Boolean).length > 900 && (() => { const both = Array.from({ length: N }, (_, id) => paintFor(id, 3) === PAINT_WHITE && trailerPaintFor(id) === PAINT_WHITE).filter(Boolean).length / N; return Math.abs(both - 0.3 * 0.45) < 0.025; })());
    check("vehicle colours: every paint is a light-to-dark pair, and dark paints carry a lighter rim and glass so they do not vanish into the asphalt", [...CAR_PAINTS, ...BUS_PAINTS, ...CAB_PAINTS, ...TRAILER_PAINTS].every(([p]) => /^#[0-9a-f]{6}$/i.test(p.hi) && /^#[0-9a-f]{6}$/i.test(p.lo)) && CAR_PAINTS.filter(([p]) => p.lo === "#171d29" || p.lo === "#1b2a5e" || p.lo === "#5a1822" || p.lo === "#2a323f").every(([p]) => p.edge !== undefined && p.glass !== undefined));
  }
  check(
    "panel: the scenario's description is behind an 'i' at the top right of its picture (a button that toggles it, closes on Escape and when another scenario is picked), not a paragraph in the panel",
    /<div\s+className="sandbox-scn-scene"\s+onKeyDown=\{\(e\) => \{\s*if \(e\.key === "Escape"\) setInfoOpen\(false\);\s*\}\}\s*>\s*<ScenePreview /s.test(panelSource) &&
      /className="sandbox-scn-info"[\s\S]{0,450}onClick=\{\(\) => setInfoOpen\(\(o\) => !o\)\}/.test(panelSource) && /\{infoOpen && \(\s*<div className="sandbox-scn-info-pop"/.test(panelSource) &&
      /setFamily\(f\);\s*setInfoOpen\(false\);/.test(panelSource) && !/<p className="sandbox-scn-desc">\{template\.description\}<\/p>/.test(panelSource) &&
      /\.sandbox-scn-info \{[^}]*top: 6px; right: 6px;/.test(readFileSync(new URL("../../../globals.css", import.meta.url), "utf8")),
  );
  const operatorText = [pageSource, artSource, panelSource, previewSource, readFileSync(new URL("./assumptions.ts", import.meta.url), "utf8"), readFileSync(new URL("./catalogue.ts", import.meta.url), "utf8"), readFileSync(new URL("../../../globals.css", import.meta.url), "utf8")].join("\n");
  check("lane reallocation: nothing the operator can read still calls it a zipper lane or counterflow (UI strings, canvas labels, assumption text)", !/Zipper lane|ZIPPER LANE|Counterflow|COUNTERFLOW|zipper lane|counterflow/.test(operatorText));
  check(
    "lane reallocation: the control is titled with the name, states the model in one line — 'Lanes are reassigned between carriageways; vehicles do not cross the median.' — and warns what a change restarts",
    /<span className="sandbox-slider-label">\{REALLOCATION_NAME\}<\/span>/.test(pageSource) && /Lanes are reassigned between carriageways; vehicles do not cross the median\./.test(pageSource) &&
      /Changing it restarts BOTH carriageways: clocks, baselines, and hand-set closures, speed limits and incidents are cleared\. Scenario events stay and replay from their start\./.test(pageSource) &&
      /\$\{REALLOCATION_NAME\.toUpperCase\(\)\} · /.test(pageSource),
  );
  check(
    "panel: the 'Add to' picker sits UNDER the family chips (it appears once a scenario is chosen), offers Both only for a family that reaches both, and is Both-mode only",
    panelSource.indexOf('data-scn="direction-pick"') > panelSource.indexOf('className="sandbox-scn-families"') && panelSource.indexOf('className="sandbox-scn-families"') > -1 &&
      /\{template\.carriageways === "one_or_both" && \(\s*<button role="tab" aria-selected=\{onBoth\}/.test(panelSource) && /\{both && \(\s*<div className="sandbox-dir-pick"/.test(panelSource) &&
      /setWantBoth\(t\.carriageways === "one_or_both"\)/.test(panelSource) && /const targets = addTargets\(template\.carriageways, directions, direction, wantBoth\);/.test(panelSource),
  );
  check(
    "panel: a Both add is all or nothing — the refusal is worked out for EVERY target (one refusal disables Add for both, and names its carriageway), and Add stores one event per target",
    /for \(const d of targets\) \{\s*const v = addEventToBucket\(d, data\[d\]\.events, specFor\(d\), data\[d\]\.road, data\[d\]\.nextSeq, data\[d\]\.manualClosure\);/.test(panelSource) &&
      /for \(const d of targets\) \{\s*const r = data\[d\]\.onAdd\(specFor\(d\)\);/.test(panelSource) && /disabled=\{refusalNow !== null\}/.test(panelSource) && /Add to both carriageways/.test(panelSource),
  );
  check(
    "panel: with two targets both events get the same km and the same lane number (the shorter road's lane list), so a Both flood is one place on the corridor",
    /const laneCap = Math\.min\(\.\.\.targets\.map\(\(d\) => data\[d\]\.laneCount\)\);/.test(panelSource) && /data\[targets\[0\]\]\.kmAtPct\(template\.defaultPlacement\.pct\)/.test(panelSource),
  );
  check(
    "panel: once an event is stored the form's answers are cleared back to the family's defaults (start, minutes, position, lane, vehicle, cause, label, intensity, duration choice, draw); a REFUSED add keeps them so they can be fixed",
    /if \(failure === null\) clearAnswers\(family\);\s*else setRefusal\(failure\);/.test(panelSource) &&
      /const clearAnswers = \(f: FamilyKey\) => \{\s*pickFamily\(f\);\s*setStartMin\(DEFAULT_START_MIN\);\s*setManualMin\(DEFAULT_MANUAL_MIN\);\s*setSeed\(1\);\s*if \(getTemplate\(f\)\.durationSource !== "manual_only"\) setChoice\("sampled"\);\s*\};/.test(panelSource) &&
      /useState\(DEFAULT_START_MIN\)/.test(panelSource) && /useState\(DEFAULT_MANUAL_MIN\)/.test(panelSource),
  );
  // ── where an Add goes: one carriageway, or both for weather and flooding ────
  const reach = (f: FamilyKey): string => TEMPLATE_BY_FAMILY[f].carriageways;
  check(
    "add to which carriageway: rain and flooding can go on both; every other family is one carriageway's business",
    reach("rain") === "one_or_both" && reach("flood") === "one_or_both" &&
      (["breakdown_in_lane", "breakdown_shoulder", "minor_collision", "multi_vehicle_collision", "self_accident", "overturned_vehicle", "scheduled_roadworks"] as const).every((f) => reach(f) === "one"),
  );
  const both2: readonly Direction[] = ["NB", "SB"];
  check(
    "add to which carriageway: with both on screen, a both-capable family the operator sent to Both goes to NB and SB — in that order, one event each",
    addTargets("one_or_both", both2, "NB", true).join() === "NB,SB" && addTargets("one_or_both", both2, "SB", true).join() === "NB,SB",
  );
  check(
    "add to which carriageway: choosing one carriageway (Both off) goes to the focused one only, for either kind of family",
    addTargets("one_or_both", both2, "SB", false).join() === "SB" && addTargets("one_or_both", both2, "NB", false).join() === "NB" && addTargets("one", both2, "SB", false).join() === "SB",
  );
  check(
    "add to which carriageway: a one-carriageway family never goes to both, even if 'both' was left set from a previous choice",
    addTargets("one", both2, "NB", true).join() === "NB" && addTargets("one", both2, "SB", true).join() === "SB",
  );
  check(
    "add to which carriageway: with one carriageway on screen it is that carriageway, whatever the family or the flag",
    addTargets("one_or_both", ["NB"], "NB", true).join() === "NB" && addTargets("one_or_both", ["SB"], "SB", true).join() === "SB" && addTargets("one", ["SB"], "SB", false).join() === "SB",
  );
  // the two events a Both add makes are each valid on their own carriageway, and are stored one per bucket
  const rainBoth = both2.map((d) => addEventToBucket(d, [], { ...rainSpec(330, 0, manualMinutes(30), d, "moderate") }, road600, 1, { closedLanes: [], closurePoint: 0, closureEnd: 0 }));
  check(
    "add to which carriageway: a Both add stores one rain event per carriageway, each stamped with its own direction",
    rainBoth.length === 2 && rainBoth.every((r) => r.ok) && rainBoth.map((r) => (r.ok ? r.event.direction : "")).join() === "NB,SB",
  );
  check("rain intensity: the panel offers a Light / Moderate / Heavy radio group for rain only, each choice titled with its cap, and passes the choice into the variant", /template\.family === "rain" && \(/.test(panelSource) && /data-scn-intensity=\{o\.id\}/.test(panelSource) && /variantFor\(family, vehicle, cause, label, intensity\)/.test(panelSource) && /case "rain":\s*return \{ family, intensity \};/.test(panelSource));
  check("panel: every family chip carries its pictogram, and the preview is the SAME scene art the road uses", /<FamilyIcon family=\{t\.family\} \/>/.test(panelSource) && /<ScenePreview family=\{family\}/.test(panelSource) && /from "\.\.\/sceneArt"/.test(previewSource) && /reduce/.test(previewSource));
  check(
    "lane reallocation: the control is Both-mode only, plans every change through planZipper, and a scheme is dropped the moment the lane counts stop matching it",
    /\{both && <ZipperControl /.test(pageSource) && /const plan = planZipper\(zipper === null \? laneCounts : zipper\.base, toward, lanes\);/.test(pageSource) && /if \(zipper !== null && !zipperHolds\(zipper, \{ NB: nb\.laneCount, SB: sb\.laneCount \}\)\) setZipper\(null\);/.test(pageSource),
  );
  check("lane reallocation: 'Off' restores the lane counts the road had before the scheme", /nb\.setLaneCount\(zipper\.base\.NB\);\s*sb\.setLaneCount\(zipper\.base\.SB\);/.test(pageSource));
  check("lane reallocation: the canvas draws the movable barrier and the borrowed lanes only when a scheme is on (borrowedLanes(zipper, ...) feeds each carriageway)", /borrowed: borrowedLanes\(zipper, "NB"\)/.test(pageSource) && /borrowed: borrowedLanes\(zipper, "SB"\)/.test(pageSource) && /if \(zipper === null\) \{\s*drawMedian/.test(pageSource));
}

/* ───────────────────────────── report ───────────────────────────── */
console.log(`verify: ${checks} checks, ${failures.length} failed  (${listed.length} assumptions, ${allEntries.length} calibration entries [${CALIBRATION_KEYS.length} base + ${allEntries.length - CALIBRATION_KEYS.length} hierarchy], ${SCENARIO_TEMPLATES.length} templates, ${N.toLocaleString("en-US")} draws per entry)`);
for (const f of failures) console.log(`  FAIL ${f}`);
if (failures.length > 0) process.exit(1);
console.log("OK");
