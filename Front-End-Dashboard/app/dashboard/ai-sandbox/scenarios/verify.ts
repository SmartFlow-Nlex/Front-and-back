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
import { TrafficSim } from "../simulation";
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
  operatorLaneToEngineIndex,
} from "./assumptions";
import {
  BREAKDOWN_CAUSES,
  BREAKDOWN_FAMILIES,
  BREAKDOWN_VEHICLES,
  CALIBRATION_KEYS,
  RESOURCE_SHARING,
  SCENARIO_TEMPLATES,
  TEMPLATE_BY_FAMILY,
  calibrationKeyFor,
  causeKey,
  causeVehicleKey,
  defaultOperatorLane,
  defaultVariant,
  phaseOffsetFractions,
  vehicleKey,
  type BreakdownCause,
  type BreakdownFamilyKey,
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

const FAMILIES: readonly FamilyKey[] = ["breakdown_in_lane", "breakdown_shoulder", "minor_collision", "multi_vehicle_collision", "self_accident"];
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
/** Expected cap source for a breakdown variant, from the raw file. */
function expectedBreakdownCap(family: BreakdownFamilyKey, cause: BreakdownCause, vehicle: VehicleKind): Expected | null {
  const order = [
    { level: "cause_vehicle", key: causeVehicleKey(family, cause, vehicle), n: rawN(family, cause, vehicle) },
    { level: "cause", key: causeKey(family, cause), n: rawN(family, cause, null) },
    { level: "vehicle", key: vehicleKey(family, vehicle), n: rawN(family, null, vehicle) },
    { level: "family", key: family, n: rawN(family, null, null) },
  ];
  const entryExists = order.map((o) => o.level === "family" || o.n >= MIN_N);
  const resolvedAt = entryExists.indexOf(true);
  for (let i = resolvedAt; i < order.length; i++) {
    if (!entryExists[i] || order[i].n < CAP_MIN_N) continue;
    const s = rawStats.get(order[i].key);
    if (s === undefined) throw new Error(`no raw entry for ${order[i].key}`);
    return { key: order[i].key, level: order[i].level, n: s.n, p99: s.p99 };
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
      const variant: ScenarioVariant = { family, vehicle, cause };
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
check("cap: all 30 breakdown variants take their cap from the first chain level with n >= CAP_MIN_N (independent walk of the raw counts)", capWalkOk);
check("cap: every breakdown chain runs from the chosen entry to the family, over existing entries only", chainShapeOk);
check("cap: the real file has variants capped by their own level AND by an ancestor", capFromSelf > 0 && capFromAncestor > 0, `self ${capFromSelf}, ancestor ${capFromAncestor}`);

// The named case: tire x truck (in-lane) has 456 events, so it is capped from its ancestor, not from its own p99.
const ttOwn = cal.hierarchy[causeVehicleKey("breakdown_in_lane", "tire", "truck")];
const tireCause = cal.hierarchy[causeKey("breakdown_in_lane", "tire")];
const tt = resolveDuration(tireTruck, { kind: "sampled", seed: 1 });
check("tire x truck (in-lane): quantiles from cause x vehicle (n < CAP_MIN_N)", ttOwn !== undefined && ttOwn.n < CAP_MIN_N && tt.level === "cause_vehicle" && tt.n === ttOwn.n);
check(
  "tire x truck (in-lane): the cap comes from the tire cause level, not its own p99",
  ttOwn !== undefined && tireCause !== undefined && tireCause.n >= CAP_MIN_N &&
    tt.capLevel === "cause" && tt.capKey === causeKey("breakdown_in_lane", "tire") && tt.capN === tireCause.n &&
    tt.capMinutes === tireCause.quantiles.p99 && tt.capMinutes !== ttOwn.quantiles.p99,
);
if (ttOwn !== undefined && tireCause !== undefined) {
  // Every sampled draw is min(raw draw from the tire x truck quantiles, the tire-cause p99); capped iff raw exceeded it.
  // Some raw draws fall between the two p99s: capped here, and NOT capped under the old own-p99 rule when the own p99 is the higher.
  let perSeedOk = true;
  let cappedBetween = 0;
  let cappedAll = 0;
  const seeds = 20_000;
  for (let s = 1; s <= seeds; s++) {
    const raw = inverseCdf(ttOwn.quantiles, makeRng(s)());
    const d = resolveDuration(tireTruck, { kind: "sampled", seed: s });
    if (d.minutes !== Math.min(raw, tireCause.quantiles.p99) || d.capped !== raw > tireCause.quantiles.p99) perSeedOk = false;
    if (d.capped) cappedAll++;
    if (d.capped && raw <= ttOwn.quantiles.p99) cappedBetween++;
  }
  check("tire x truck (in-lane): every sampled draw is min(its own draw, the tire-cause p99), capped exactly above it", perSeedOk);
  check(
    "tire x truck (in-lane): the ancestor cap really differs from the own-p99 rule (draws below its own p99 are capped when the cause p99 is lower)",
    tireCause.quantiles.p99 < ttOwn.quantiles.p99 ? cappedBetween > 0 : cappedBetween === 0,
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
const accidentVariants: readonly { v: ScenarioVariant; key: string; level: string }[] = [
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
check("capMinN exactly equal to a level's n includes that level (>=), one more excludes it", atExact !== null && atExact.cap !== null && atExact.cap.level === "cause_vehicle" && atExactPlus1 !== null && atExactPlus1.cap !== null && atExactPlus1.cap.level === "cause");
check("capMinN 1: the chosen entry is always its own cap source", at1.cap !== null && at1.cap.key === at1.entry.key);
check("capMinN above every level: no cap source, so a sampled draw is uncapped", at1e6.cap === null);
const famOnly = selectFromCalibration(asCal({}), tireTruck);
check("with no hierarchy entries the chain is the family alone, and it caps (n >= CAP_MIN_N)", famOnly.chain.length === 1 && famOnly.cap !== null && famOnly.cap.key === "breakdown_in_lane");
check("every shipped variant has a cap source (so 'no level qualifies' is not reachable)", [...BREAKDOWN_FAMILIES.flatMap((family) => BREAKDOWN_CAUSES.flatMap((cause) => BREAKDOWN_VEHICLES.map((vehicle): ScenarioVariant => ({ family, cause, vehicle })))), ...accidentVariants.map((a) => a.v)].every((v) => selectCalibration(v).cap !== null));

/* ───────────────────────────── 4. catalogue + assumptions ───────────────────────────── */
const EXPECTED_RESOURCES: Record<FamilyKey, readonly EngineResource[]> = {
  breakdown_in_lane: ["incident_slot"],
  breakdown_shoulder: ["speed_zone"],
  minor_collision: ["closure_stretch"],
  multi_vehicle_collision: ["closure_stretch"],
  self_accident: ["closure_stretch"],
};
check("one template per family, in the catalogue", SCENARIO_TEMPLATES.length === FAMILIES.length && FAMILIES.every((f) => SCENARIO_TEMPLATES.some((t) => t.family === f)));
check("display names are unique", new Set(SCENARIO_TEMPLATES.map((t) => t.displayName)).size === SCENARIO_TEMPLATES.length);
check("PHASE_SPLIT has entries for the three accident families only (breakdown splits come from data)", Object.keys(ASSUMPTIONS.PHASE_SPLIT.value).sort().join() === "minor_collision,multi_vehicle_collision,self_accident");

for (const t of SCENARIO_TEMPLATES) {
  const f = t.family;
  check(`${f}: first phase is fixed at 0`, t.phases[0].offset.kind === "fixed" && phaseOffsetFractions(t.phases, 0.5)[0] === 0);
  check(`${f}: every phase has a label`, t.phases.every((p) => p.label.trim().length > 0));
  check(`${f}: resources are ${EXPECTED_RESOURCES[f].join("+")}`, [...t.resources].sort().join() === [...EXPECTED_RESOURCES[f]].sort().join());
  check(`${f}: default placement is a valid percentage`, t.defaultPlacement.pct > 0 && t.defaultPlacement.pct < 100);
  check(`${f}: calibration key exists`, CALIBRATION_KEYS.some((k) => k === t.calibrationKey));
  check(`${f}: default lane is valid on a 2..6 lane road`, [2, 3, 4, 5, 6].every((lc) => { const l = defaultOperatorLane(t, lc); return l >= 1 && l <= lc; }));
  check(`${f}: lanes-blocked table covers exactly the phase ids`, Object.keys(ASSUMPTIONS.LANES_BLOCKED.value[f]).sort().join() === t.phases.map((p) => p.id).sort().join());
}
for (const f of ["minor_collision", "multi_vehicle_collision", "self_accident"] as const) {
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
const variants: ScenarioVariant[] = [];
for (const f of BREAKDOWN_FAMILIES) for (const vehicle of TEMPLATE_BY_FAMILY[f].vehicles) for (const cause of TEMPLATE_BY_FAMILY[f].causes) variants.push({ family: f, vehicle: vehicle.id, cause: cause.id });
for (const label of TEMPLATE_BY_FAMILY.minor_collision.labels) variants.push({ family: "minor_collision", label: label.id });
variants.push({ family: "multi_vehicle_collision" }, { family: "self_accident" });
check(`${variants.length} variants (2 x 3 vehicles x 5 causes + 3 labels + 2 single) all resolve to a base entry`, variants.length === 35 && variants.every((v) => CALIBRATION_KEYS.some((k) => k === calibrationKeyFor(v))));
check("every family default variant resolves", FAMILIES.every((f) => CALIBRATION_KEYS.some((k) => k === calibrationKeyFor(defaultVariant(f)))));
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

/* ───────────────────────────── report ───────────────────────────── */
console.log(`verify: ${checks} checks, ${failures.length} failed  (${listed.length} assumptions, ${allEntries.length} calibration entries [${CALIBRATION_KEYS.length} base + ${allEntries.length - CALIBRATION_KEYS.length} hierarchy], ${SCENARIO_TEMPLATES.length} templates, ${N.toLocaleString("en-US")} draws per entry)`);
for (const f of failures) console.log(`  FAIL ${f}`);
if (failures.length > 0) process.exit(1);
console.log("OK");
