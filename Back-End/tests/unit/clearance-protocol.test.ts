/* TC-UT-15  Incidents / Kaplan-Meier with censoring at 1440 min
 * TC-UT-16  Incidents / Clearance scenarios
 * TC-UT-17  Incidents / Clearance escalation rule
 *
 * src/services/clearance-protocol.service.ts exports the pure pipeline
 * toObservations -> kaplanMeier -> quantileFromCurve / buildScenarios ->
 * conditionalSurvival / escalationRule / checkpointAt. Run without a database:
 * the runner clears POSTGRES_URL so the module's db is null.
 * TC-UT-17 changed 2 Nov 2026 (the "no assumptions" redesign): it used to
 * check the two-stage MILP's dispatch count and EVPI/VSS, which rested on an
 * assumed unit effect, costs, capacity and demand. The MILP is gone; TC-UT-17
 * now checks the data-only escalation rule read off the curve. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toObservations,
  kaplanMeier,
  survivalAt,
  quantileFromCurve,
  buildScenarios,
  conditionalSurvival,
  medianRemaining,
  escalationRule,
  checkpointAt,
} from "../../src/services/clearance-protocol.service.js";

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
test("TC-UT-17a: sheet curve: open at P50 = 30 -> 50% run past P80 = 40 (95% 12.5-100%), 2 still open, 10 min median left", () => {
  const obs = toObservations(RAW);
  const curve = kaplanMeier(obs);
  const p50 = quantileFromCurve(curve, 0.5);
  const p80 = quantileFromCurve(curve, 0.8);
  const r = escalationRule(curve, obs, p50, p80);
  console.log(`  rule=${JSON.stringify(r)}`);
  assert.deepEqual([r.checkAtMinute, r.pastMinute, r.openAtCheck], [30, 40, 2]);
  // S(40) / S(30) = 0.2 / 0.4. Greenwood at t = 40 (n = 2, d = 1): var(log) = 1 / (2 x 1) = 0.5.
  assert.ok(Math.abs(r.chance.p - 0.5) < 1e-12);
  assert.ok(Math.abs(r.chance.lo - 0.5 * Math.exp(-1.96 * Math.sqrt(0.5))) < 1e-12);
  assert.equal(r.chance.hi, 1);
  assert.equal(medianRemaining(curve, 30), 10);
});

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

test("TC-UT-17b: synthetic n=300: the chance is exactly S(P80) / S(P50), inside its own interval, interval within 0-1", () => {
  const obs = toObservations(syntheticSample(300));
  const curve = kaplanMeier(obs);
  const p50 = quantileFromCurve(curve, 0.5), p80 = quantileFromCurve(curve, 0.8), p95 = quantileFromCurve(curve, 0.95);
  const r = escalationRule(curve, obs, p50, p80);
  const direct = survivalAt(curve, p80) / survivalAt(curve, p50);
  console.log(`  P50=${p50} P80=${p80} P95=${p95} chance=${r.chance.p.toFixed(4)} (${r.chance.lo.toFixed(4)}-${r.chance.hi.toFixed(4)}) direct=${direct.toFixed(4)} open=${r.openAtCheck}`);
  assert.ok(Math.abs(r.chance.p - direct) < 1e-12, "conditional survival equals the curve ratio");
  assert.ok(r.chance.lo <= r.chance.p && r.chance.p <= r.chance.hi);
  assert.ok(r.chance.lo >= 0 && r.chance.hi <= 1);
  assert.equal(r.openAtCheck, obs.filter((o) => o.duration > p50).length);
  // Checkpoints later in the clearance carry a higher chance of running past the P95, and rest on fewer events.
  const cps = [0.25, 0.5, 0.8].map((q, i) => checkpointAt(curve, obs, (["P25", "P50", "P80"] as const)[i], quantileFromCurve(curve, q), p95));
  console.log(`  checkpoints=${cps.map((c) => `${c.label}@${c.minute}: open ${(c.stillOpen * 100).toFixed(0)}% n=${c.openCount} left ${c.medianRemainingMin} pastP95 ${(c.pastP95.p * 100).toFixed(1)}%`).join(" | ")}`);
  for (let i = 1; i < cps.length; i++) {
    assert.ok(cps[i].pastP95.p >= cps[i - 1].pastP95.p);
    assert.ok(cps[i].openCount <= cps[i - 1].openCount);
  }
});

test("TC-UT-17c: an interval that starts after every clearance gives 0, and an empty interval gives certainty 1", () => {
  const curve = kaplanMeier(toObservations([10, 20, 30]));
  assert.deepEqual(conditionalSurvival(curve, 5, 30), { p: 0, lo: 0, hi: 0 });
  const same = conditionalSurvival(curve, 20, 20);
  assert.deepEqual(same, { p: 1, lo: 1, hi: 1 });
});
