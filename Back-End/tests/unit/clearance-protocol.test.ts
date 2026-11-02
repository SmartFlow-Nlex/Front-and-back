/* TC-UT-15  Incidents / Kaplan-Meier with censoring at 1440 min
 * TC-UT-16  Incidents / Clearance scenarios
 * TC-UT-17  Incidents / Clearance recommendation sanity
 *
 * src/services/clearance-protocol.service.ts exports the pure pipeline
 * toObservations -> kaplanMeier -> quantileFromCurve / buildScenarios ->
 * solveClearanceProtocol (two-stage MILP on YALPS). Run without a database:
 * the runner clears POSTGRES_URL so the module's db is null. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toObservations,
  kaplanMeier,
  survivalAt,
  quantileFromCurve,
  buildScenarios,
  solveClearanceProtocol,
  CAPACITY_VEH_HR,
  REDUCED_CAPACITY_VEH_HR,
} from "../../src/services/clearance-protocol.service.js";
import { ClearanceProtocolQuerySchema } from "../../src/validators/incident.validator.js";
import { readSource, declaration, evaluate } from "../support/source-extract.js";

const RAW = [10, 20, 30, 40, 2000];

test("TC-UT-15: 2000 is censored at 1440 (kept), 5 at risk, S = 80/60/40/20%, flat 20% to 1440, P50 = 30", () => {
  const obs = toObservations(RAW);
  const curve = kaplanMeier(obs);
  console.log(`  obs=${JSON.stringify(obs)}`);
  console.log(`  curve=${JSON.stringify(curve)}`);
  assert.equal(obs.length, 5);
  assert.deepEqual(obs[4], { duration: 1440, censored: true });
  assert.equal(curve[0].atRisk, 5);
  const at = (t: number) => Math.round(survivalAt(curve, t) * 1000) / 1000;
  assert.deepEqual([at(10), at(20), at(30), at(40)], [0.8, 0.6, 0.4, 0.2]);
  assert.equal(at(1439), 0.2);
  assert.equal(at(1440), 0.2);
  assert.equal(quantileFromCurve(curve, 0.5), 30);
});

test("TC-UT-16: four scenarios cut at the curve's own P50/P80/P95, each band's probability read off the curve (sum 1.00)", () => {
  const obs = toObservations(RAW);
  const curve = kaplanMeier(obs);
  const rawEvents = obs.filter((o) => !o.censored).map((o) => o.duration); // as getClearanceProtocolFromDb does
  const { scenarios, p50, p80, p95 } = buildScenarios(curve, rawEvents);
  const probs = scenarios.map((s) => Math.round(s.probability * 1000) / 1000);
  const sum = scenarios.reduce((s, x) => s + x.probability, 0);
  console.log(`  p50=${p50} p80=${p80} p95=${p95} scenarios=${JSON.stringify(scenarios)} sum=${sum}`);
  assert.deepEqual(scenarios.map((s) => s.label), ["fast", "typical", "slow", "extreme"]);
  assert.ok(Math.abs(sum - 1) < 1e-9, "probabilities sum to 1");
  assert.deepEqual([p50, p80, p95], [quantileFromCurve(curve, 0.5), quantileFromCurve(curve, 0.8), quantileFromCurve(curve, 0.95)]);
  // The probabilities are the curve's own mass in each band, S(lower) - S(upper), as buildScenarios documents. On this
  // five-point sheet the curve is a step with ties (P80 = P95 = 40), so the masses are 0.6 / 0.2 / 0 / 0.2; the nominal
  // 0.50 / 0.30 / 0.15 / 0.05 holds only for a smooth curve, which the next test checks (2 Nov 2026).
  const S = (t: number) => survivalAt(curve, t);
  assert.deepEqual(probs, [1 - S(p50), S(p50) - S(p80), S(p80) - S(p95), S(p95)].map((x) => Math.round(x * 1000) / 1000));
  assert.deepEqual(probs, [0.6, 0.2, 0, 0.2]);
});

test("TC-UT-16b: on a large smooth sample the bands come out at about 0.50 / 0.30 / 0.15 / 0.05", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const raw = Array.from({ length: 20000 }, () => {
    const u1 = Math.max(rand(), 1e-9), u2 = rand();
    return Math.exp(Math.log(40) + 0.9 * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
  });
  const obs = toObservations(raw);
  const { scenarios } = buildScenarios(kaplanMeier(obs), obs.filter((o) => !o.censored).map((o) => o.duration));
  const probs = scenarios.map((s) => s.probability);
  console.log(`  smooth sample: ${probs.map((p) => p.toFixed(3)).join(" / ")}`);
  [0.5, 0.3, 0.15, 0.05].forEach((want, i) => assert.ok(Math.abs(probs[i] - want) < 0.01, `band ${i}: ${probs[i]}`));
});

// ---- TC-UT-17 -------------------------------------------------------------
const defaults = ClearanceProtocolQuerySchema.parse({});
const service = readSource("Back-End/src/services/clearance-protocol.service.ts");
const { DEMAND_VC_RATIO } = evaluate<any>([declaration(service, "DEMAND_VC_RATIO")], ["DEMAND_VC_RATIO"]);
const cap = { q: CAPACITY_VEH_HR * DEMAND_VC_RATIO[defaults.demandLevel], c: CAPACITY_VEH_HR, cr: REDUCED_CAPACITY_VEH_HR };

/** Deterministic right-skewed clearance sample (minutes), a few beyond 1440. */
function syntheticSample(n: number): number[] {
  let seed = 20261024;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  return Array.from({ length: n }, () => {
    const u1 = Math.max(rand(), 1e-9), u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.round(Math.exp(Math.log(40) + 0.9 * z)); // median ~40 min
  });
}

const SAMPLES: Record<string, number[]> = { "sheet curve (TC-UT-15)": RAW, "synthetic n=300": syntheticSample(300) };

for (const [name, raw] of Object.entries(SAMPLES)) {
  for (const maxUnits of [defaults.maxUnits, 1, 2, 4, 6]) {
    test(`TC-UT-17: ${name}, maxUnits=${maxUnits}: units <= maxUnits, EVPI >= 0, VSS >= 0`, () => {
      const obs = toObservations(raw);
      const curve = kaplanMeier(obs);
      const { scenarios, p50 } = buildScenarios(curve, obs.filter((o) => !o.censored).map((o) => o.duration));
      const sol = solveClearanceProtocol(scenarios, p50, maxUnits, defaults.unitEffect, defaults.unitCostPerHour, defaults.delayCostPerVehHour, cap);
      const maxEsc = Math.max(0, ...Object.values(sol.escalationByScenario));
      console.log(`  ${name} maxUnits=${maxUnits}: dispatch=${sol.unitsAtDispatch} maxEscalation=${maxEsc} rp=${sol.rp.toFixed(2)} evpi=${sol.evpi.toFixed(4)} vss=${sol.vss.toFixed(4)}`);
      assert.ok(sol.unitsAtDispatch >= 1 && sol.unitsAtDispatch <= maxUnits);
      assert.ok(sol.unitsAtDispatch + maxEsc <= maxUnits, "dispatch + escalation within maxUnits");
      assert.ok(Number.isFinite(sol.rp), "solver returned an optimal solution");
      // RP comes from the LP solver and EEV/WS from direct evaluation; at
      // objective values ~1e5 they agree only to ~1e-14 relative, so "zero"
      // can print as -3e-9. Compare relative to the objective's magnitude.
      const tol = 1e-12 * Math.max(1, Math.abs(sol.rp));
      console.log(`    raw evpi=${sol.evpi} raw vss=${sol.vss} tolerance=${tol.toExponential(1)}`);
      assert.ok(sol.evpi >= -tol, `EVPI = ${sol.evpi}`);
      assert.ok(sol.vss >= -tol, `VSS = ${sol.vss}`);
    });
  }
}
