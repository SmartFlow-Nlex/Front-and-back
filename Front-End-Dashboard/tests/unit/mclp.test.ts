/* TC-UT-13  Incidents / Patrol and tow placement order
 * components/dashboard/PrescriptiveDeploymentPanel.tsx: placementOrder(rows)
 * (module-private) ranks sites busiest first and gives, after each unit, the
 * share of all forecast incidents at the sites staffed so far.
 * Changed 2 Nov 2026 (the "no assumptions" redesign): this used to test the
 * Maximal Covering solve (solveMclp), whose answer depended on a fleet size
 * and coverage radius the operator had to make up. That solve is gone; the
 * same sheet weights 10, 20, 25, 5 now give the placement order and its
 * cumulative coverage. The file keeps its name so the test ID stays put. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource, declaration, evaluate } from "../../../Back-End/tests/support/source-extract.ts";

const src = readSource("Front-End-Dashboard/components/dashboard/PrescriptiveDeploymentPanel.tsx");
const { placementOrder } = evaluate<any>([declaration(src, "placementOrder")], ["placementOrder"]);

const row = (key: string, predictedIncidents: number) => ({ key, label: key, km: 0, lo: 0, hi: 0, predictedIncidents });
const rows = [row("A", 10), row("B", 20), row("C", 25), row("D", 5)];

test("TC-UT-13a: weights 10, 20, 25, 5 -> order C, B, A, D", () => {
  const r = placementOrder(rows);
  console.log(`  ${r.map((p: any) => `${p.order}.${p.key} ${(p.cumShare * 100).toFixed(1)}%`).join("  ")}`);
  assert.deepEqual(r.map((p: any) => p.key), ["C", "B", "A", "D"]);
  assert.deepEqual(r.map((p: any) => p.order), [1, 2, 3, 4]);
});

test("TC-UT-13b: cumulative coverage 41.7%, 75%, 91.7%, 100% of 60", () => {
  const r = placementOrder(rows);
  const expected = [25 / 60, 45 / 60, 55 / 60, 1];
  r.forEach((p: any, i: number) => assert.ok(Math.abs(p.cumShare - expected[i]) < 1e-12, `unit ${i + 1}`));
});

test("TC-UT-13c: the input is not reordered, and an all-zero forecast covers 0%", () => {
  placementOrder(rows);
  assert.deepEqual(rows.map((r) => r.key), ["A", "B", "C", "D"]);
  const z = placementOrder([row("X", 0), row("Y", 0)]);
  assert.deepEqual(z.map((p: any) => p.cumShare), [0, 0]);
});
