/**
 * Phase 1 verification for the scenario catalogue, calibration, assumptions and sampler.
 *
 *   cd Back-End && ./node_modules/.bin/tsx ../Front-End-Dashboard/app/dashboard/ai-sandbox/scenarios/verify.ts
 *
 * Read-only. Exits 1 on any failure. It guards three things:
 *   1. the sampler really reproduces the calibrated quantiles, and is reproducible per seed;
 *   2. the catalogue and assumptions are internally consistent (phases, shares, lanes, lengths);
 *   3. values MIRRORED from elsewhere have not drifted (engine constants, chainage table).
 */
import { readFileSync } from "node:fs";
import calibrationJson from "./calibration.json";
import { TrafficSim } from "../simulation";
import {
  ASSUMPTIONS,
  CHAINAGE_DERIVATION,
  CHAINAGE_OFFSET_KM,
  appKmToChainageKm,
  chainageKmToAppKm,
  engineIndexToOperatorLane,
  incidentSlotsFor,
  listAssumptions,
  operatorLaneToEngineIndex,
} from "./assumptions";
import {
  CALIBRATION_KEYS,
  RESOURCE_SHARING,
  SCENARIO_TEMPLATES,
  TEMPLATE_BY_FAMILY,
  calibrationKeyFor,
  defaultOperatorLane,
  defaultVariant,
  type CollisionLabel,
  type EngineResource,
  type FamilyKey,
  type ScenarioVariant,
} from "./catalogue";
import {
  getCalibration,
  getCalibrationEntry,
  inverseCdf,
  isLowSample,
  makeRng,
  parseCalibration,
  resolveDurationMinutes,
  sampleDurationMinutes,
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

/* ───────────────────────────── 1. calibration file + sampler ───────────────────────────── */
const cal = getCalibration();
check("calibration parses", CALIBRATION_KEYS.every((k) => cal.entries[k].n > 0));
check("parseCalibration rejects a non-object", throws(() => parseCalibration(42)));
check("parseCalibration rejects a missing family", throws(() => parseCalibration({ provenance: {}, families: {} })));

const N = 200_000;
for (const key of CALIBRATION_KEYS) {
  const e = getCalibrationEntry(key);
  const q = e.quantiles;
  const knots = [q.min, q.p10, q.p25, q.p50, q.p75, q.p90, q.p99, q.max];

  // exact at the knots
  for (let i = 0; i < KNOT_P.length; i++) check(`${key}: inverseCdf(${KNOT_P[i]}) is the knot`, near(inverseCdf(q, KNOT_P[i]), knots[i], 1e-9));
  // monotone on a fine grid
  let prev = -Infinity;
  let monotone = true;
  for (let i = 0; i <= 10_000; i++) {
    const v = inverseCdf(q, i / 10_000);
    if (v < prev) monotone = false;
    prev = v;
  }
  check(`${key}: inverseCdf is non-decreasing`, monotone);
  check(`${key}: p50 / p90 modes are the quantiles`, resolveDurationMinutes(e, { kind: "p50" }) === q.p50 && resolveDurationMinutes(e, { kind: "p90" }) === q.p90);

  // distribution: the empirical CDF at each interior knot matches its probability. Compared on probabilities, not values,
  // because the p99 value is poorly determined by a finite sample (the tail is 1% of the mass spread over up to a day).
  const draws: number[] = [];
  for (let s = 1; s <= N; s++) draws.push(sampleDurationMinutes(key, s));
  for (let i = 1; i < KNOT_P.length - 1; i++) {
    const v = knots[i];
    let expected: number = KNOT_P[i];
    for (let j = 0; j < knots.length; j++) if (knots[j] === v) expected = Math.max(expected, KNOT_P[j]);
    const emp = draws.filter((d) => d <= v).length / N;
    const tol = 5 * Math.sqrt((expected * (1 - expected)) / N) + 1e-3;
    check(`${key}: empirical CDF at p${Math.round(KNOT_P[i] * 100)} knot`, near(emp, expected, tol), `got ${emp.toFixed(4)}, want ${expected}`);
  }
  check(`${key}: every draw within [min, max]`, draws.every((d) => d >= q.min && d <= q.max));
}

// reproducible per seed; different seeds differ; decorrelated across consecutive seeds
const a1 = sampleDurationMinutes("self_accident", 12345);
const a2 = sampleDurationMinutes("self_accident", 12345);
check("same seed gives the same duration", a1 === a2);
check("different seeds give different durations", new Set(Array.from({ length: 50 }, (_, i) => sampleDurationMinutes("self_accident", i + 1))).size > 40);
const us = Array.from({ length: 20_000 }, (_, i) => makeRng(i + 1)());
const meanU = us.reduce((s, v) => s + v, 0) / us.length;
let cov = 0;
let varU = 0;
for (let i = 0; i < us.length - 1; i++) cov += (us[i] - meanU) * (us[i + 1] - meanU);
for (const v of us) varU += (v - meanU) ** 2;
check("consecutive seeds: first draw is uniform (mean ~ 0.5)", near(meanU, 0.5, 0.01), `mean ${meanU.toFixed(4)}`);
check("consecutive seeds: lag-1 correlation is negligible", Math.abs(cov / varU) < 0.03, `corr ${(cov / varU).toFixed(4)}`);

// modes and validation
const ee = getCalibrationEntry("breakdown_in_lane");
check("manual returns the operator's figure", resolveDurationMinutes(ee, { kind: "manual", minutes: 42.5 }) === 42.5);
check("manual rejects 0, negative and NaN", throws(() => resolveDurationMinutes(ee, { kind: "manual", minutes: 0 })) && throws(() => resolveDurationMinutes(ee, { kind: "manual", minutes: -3 })) && throws(() => resolveDurationMinutes(ee, { kind: "manual", minutes: Number.NaN })));
check("cap clamps a sampled draw", Array.from({ length: 2000 }, (_, i) => resolveDurationMinutes(ee, { kind: "sampled", seed: i + 1 }, { capMinutes: 120 })).every((v) => v <= 120));
check("cap is not applied to manual", resolveDurationMinutes(ee, { kind: "manual", minutes: 500 }, { capMinutes: 120 }) === 500);
check("cap rejects a non-positive value", throws(() => resolveDurationMinutes(ee, { kind: "sampled", seed: 1 }, { capMinutes: 0 })));
check("inverseCdf rejects u outside [0,1]", throws(() => inverseCdf(ee.quantiles, -0.1)) && throws(() => inverseCdf(ee.quantiles, 1.1)));
check("makeRng rejects a non-integer seed", throws(() => makeRng(1.5)));
check("low-sample flag: hit-and-run yes, self accident no", isLowSample(getCalibrationEntry("minor_collision_hit_and_run")) && !isLowSample(getCalibrationEntry("self_accident")));

/* ───────────────────────────── 2. catalogue + assumptions ───────────────────────────── */
const EXPECTED_RESOURCES: Record<FamilyKey, readonly EngineResource[]> = {
  breakdown_in_lane: ["incident_slot"],
  breakdown_shoulder: ["speed_zone"],
  minor_collision: ["closure_stretch"],
  multi_vehicle_collision: ["closure_stretch"],
  self_accident: ["closure_stretch"],
};
check("one template per family, in the catalogue", SCENARIO_TEMPLATES.length === FAMILIES.length && FAMILIES.every((f) => SCENARIO_TEMPLATES.some((t) => t.family === f)));
check("display names are unique", new Set(SCENARIO_TEMPLATES.map((t) => t.displayName)).size === SCENARIO_TEMPLATES.length);

const splitSum = (f: FamilyKey): number => ASSUMPTIONS.PHASE_SPLIT.value[f].reduce((s, p) => s + p.share, 0);
for (const t of SCENARIO_TEMPLATES) {
  const f = t.family;
  const offsets = t.phases.map((p) => p.offsetFraction);
  check(`${f}: first phase starts at 0`, offsets[0] === 0);
  check(`${f}: offsets strictly increase and stay below 1`, offsets.every((o, i) => o < 1 && (i === 0 || o > offsets[i - 1])));
  check(`${f}: phase shares sum to 1`, near(splitSum(f), 1, 1e-9), `sum ${splitSum(f)}`);
  check(`${f}: phases match the split (count and order)`, t.phases.length === ASSUMPTIONS.PHASE_SPLIT.value[f].length && t.phases.every((p, i) => p.id === ASSUMPTIONS.PHASE_SPLIT.value[f][i].id));
  check(`${f}: every phase has a label`, t.phases.every((p) => p.label.trim().length > 0));
  check(`${f}: resources are ${EXPECTED_RESOURCES[f].join("+")}`, [...t.resources].sort().join() === [...EXPECTED_RESOURCES[f]].sort().join());
  check(`${f}: default placement is a valid percentage`, t.defaultPlacement.pct > 0 && t.defaultPlacement.pct < 100);
  check(`${f}: calibration key exists`, CALIBRATION_KEYS.some((k) => k === t.calibrationKey));
  check(`${f}: default lane is valid on a 2..6 lane road`, [2, 3, 4, 5, 6].every((lc) => { const l = defaultOperatorLane(t, lc); return l >= 1 && l <= lc; }));
  check(`${f}: lanes-blocked table covers exactly the phase ids`, Object.keys(ASSUMPTIONS.LANES_BLOCKED.value[f]).sort().join() === t.phases.map((p) => p.id).sort().join());
}
check("TEMPLATE_BY_FAMILY agrees with the list", FAMILIES.every((f) => TEMPLATE_BY_FAMILY[f].family === f));

// default lanes must equal the modal numbered lane in the data
const lane = (d: Record<string, number>): string => {
  const numbered: [string, number][] = [["Lane1", d.Lane1], ["Lane2", d.Lane2], ["Lane3", d.Lane3], ["Lane4", d.Lane4]];
  return numbered.reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
};
const modal: Record<"breakdown_in_lane" | "minor_collision" | "multi_vehicle_collision" | "self_accident", string> = {
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

// variants all resolve to a real calibration entry
const variants: ScenarioVariant[] = [];
for (const vehicle of TEMPLATE_BY_FAMILY.breakdown_in_lane.vehicles) for (const cause of TEMPLATE_BY_FAMILY.breakdown_in_lane.causes) variants.push({ family: "breakdown_in_lane", vehicle: vehicle.id, cause: cause.id });
for (const label of TEMPLATE_BY_FAMILY.minor_collision.labels) variants.push({ family: "minor_collision", label: label.id });
for (const f of ["breakdown_shoulder", "multi_vehicle_collision", "self_accident"] as const) variants.push({ family: f });
check(`${variants.length} variants (3 vehicles x 5 causes + 3 labels + 3 single) all resolve to a calibration key`, variants.length === 21 && variants.every((v) => CALIBRATION_KEYS.some((k) => k === calibrationKeyFor(v))));
check("every family default variant resolves", FAMILIES.every((f) => CALIBRATION_KEYS.some((k) => k === calibrationKeyFor(defaultVariant(f)))));
const labels: readonly CollisionLabel[] = ["rear_end", "sideswipe", "hit_and_run"];
check("each collision label maps to its own entry", labels.every((l) => calibrationKeyFor({ family: "minor_collision", label: l }) === `minor_collision_${l}`));

// lanes-blocked / closure-length consistency for the closure families
for (const f of ["minor_collision", "multi_vehicle_collision", "self_accident"] as const) {
  const lanes: Record<string, number> = ASSUMPTIONS.LANES_BLOCKED.value[f];
  const lengths: Record<string, number> = ASSUMPTIONS.CLOSURE_LENGTH_M.value[f];
  check(`${f}: closure length is >0 exactly when lanes are blocked`, Object.keys(lanes).every((id) => (lanes[id] > 0) === (lengths[id] > 0)));
  check(`${f}: last phase blocks no lane (lanes reopen before the scene is cleared)`, lanes[TEMPLATE_BY_FAMILY[f].phases[TEMPLATE_BY_FAMILY[f].phases.length - 1].id] === 0);
}
check("incident slots: car 1, bus 2, truck 3", incidentSlotsFor("car") === 1 && incidentSlotsFor("bus") === 2 && incidentSlotsFor("truck") === 3);

// lane mapping
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

/* ───────────────────────────── 3. drift guards ───────────────────────────── */
// chainage: the table in assumptions.ts must equal the one the generator wrote into calibration.json
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

// engine constants mirrored from simulation.ts
const engineSource = readFileSync(new URL("../simulation.ts", import.meta.url), "utf8");
const incidentLength = /const INCIDENT_LENGTH = (\d+(?:\.\d+)?)/.exec(engineSource);
check("engine INCIDENT_LENGTH equals ENGINE_INCIDENT_SLOT_M", incidentLength !== null && Number(incidentLength[1]) === ASSUMPTIONS.ENGINE_INCIDENT_SLOT_M.value, incidentLength ? `engine says ${incidentLength[1]}` : "constant not found");
const closureDefault = /closurePoint:\s*cfg\.length\s*\*\s*(\d+(?:\.\d+)?)/.exec(engineSource);
check("engine default closure position equals DEFAULT_PLACEMENT_PCT", closureDefault !== null && near(Number(closureDefault[1]) * 100, ASSUMPTIONS.DEFAULT_PLACEMENT_PCT.value, 1e-9), closureDefault ? `engine says ${closureDefault[1]}` : "not found");

// resource sharing: one closure pair and one speed zone in the engine's Interventions
const sim = new TrafficSim({ length: 600, laneCount: 4, inflowVehPerHour: 1000, seed: 1 });
const iv = sim.interventions;
check("engine: exactly one closurePoint/closureEnd pair", typeof iv.closurePoint === "number" && typeof iv.closureEnd === "number" && RESOURCE_SHARING.closure_stretch === "exclusive");
check("engine: exactly one speed zone", Array.isArray(iv.speedZone) && iv.speedZone.length === 2 && (iv.speedLimitKmh === null || typeof iv.speedLimitKmh === "number") && RESOURCE_SHARING.speed_zone === "exclusive");
check("engine: incidents are a list (shared)", Array.isArray(iv.incidents) && RESOURCE_SHARING.incident_slot === "shared");

// assumptions are all marked and reasoned
const listed = listAssumptions();
check("every assumption is marked ASSUMPTION with a reason", listed.length > 0 && listed.every((a) => a.assumption.status === "ASSUMPTION" && a.assumption.reason.trim().length > 20));
check("LANE1_IS_INNERMOST is recorded as pending confirmation", (ASSUMPTIONS.LANE1_IS_INNERMOST.settledBy ?? "").includes("PENDING"));

/* ───────────────────────────── report ───────────────────────────── */
console.log(`verify: ${checks} checks, ${failures.length} failed  (${listed.length} assumptions, ${CALIBRATION_KEYS.length} calibration entries, ${SCENARIO_TEMPLATES.length} templates, ${N.toLocaleString("en-US")} draws per entry)`);
for (const f of failures) console.log(`  FAIL ${f}`);
if (failures.length > 0) process.exit(1);
console.log("OK");
