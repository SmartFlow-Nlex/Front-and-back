/* TC-UT-12  Incidents / Patrol alert hours statistically above normal
 * components/dashboard/PatrolAlertWindowPanel.tsx: buildProfile(counts, days)
 * (module-private) gives each hour's rate (count / days) with its exact
 * Poisson 95% interval, and marks an hour as an alert hour only when the
 * interval's LOWER bound is above the day's mean hourly rate. The component's
 * inline `primary` expression picks the longest run of alert hours. All are
 * extracted.
 * Changed 2 Nov 2026 (the "no assumptions" redesign): the rule used to be
 * "average above the day's mean", which flagged an hour on any excess however
 * few incidents it rested on. The same 1,1,2,6,7,3,1,3 shape is now tested at
 * one day (too few incidents: nothing qualifies) and at ten days (hours 4-5
 * clear the mean at 95%). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource, declaration, between, evaluate } from "../../../Back-End/tests/support/source-extract.ts";

const src = readSource("Front-End-Dashboard/components/dashboard/PatrolAlertWindowPanel.tsx");
const primaryExpr = between(src, "const primary =", "return { label:", "const profile = buildProfile(hourly, days);")
  .replace("const primary =", "")
  .trim()
  .replace(/;$/, "");

const { buildProfile, poissonCi, primaryOf, windowSpanHours } = evaluate<any>(
  [
    declaration(src, "poissonCdf"),
    declaration(src, "ciCache"),
    declaration(src, "poissonCi"),
    declaration(src, "buildProfile"),
    declaration(src, "windowSpanHours"),
    `const primaryOf = (profile: any) => (${primaryExpr});`,
  ],
  ["buildProfile", "poissonCi", "primaryOf", "windowSpanHours"],
);

const SHAPE = [1, 1, 2, 6, 7, 3, 1, 3];

test("TC-UT-12a: exact Poisson 95% intervals match the published table (k=0, 1, 6, 60)", () => {
  // Garwood intervals: 0 -> 0-3.689, 1 -> 0.0253-5.572, 6 -> 2.202-13.06, 60 -> 45.79-77.23.
  for (const [k, lo, hi] of [[0, 0, 3.689], [1, 0.0253, 5.572], [6, 2.202, 13.06], [60, 45.79, 77.23]] as const) {
    const [l, u] = poissonCi(k);
    console.log(`  k=${k}: ${l.toFixed(4)}-${u.toFixed(3)}`);
    assert.ok(Math.abs(l - lo) < 0.01, `lower for ${k}`);
    assert.ok(Math.abs(u - hi) < 0.01, `upper for ${k}`);
  }
});

test("TC-UT-12b: counts 1,1,2,6,7,3,1,3 over ONE day -> mean 3.0, no hour clears it at 95%", () => {
  const p = buildProfile(SHAPE, 1);
  console.log(`  mean=${p.mean} lo=${p.lo.map((v: number) => v.toFixed(2)).join(",")} windows=${JSON.stringify(p.windows)}`);
  assert.equal(p.mean, 3.0);
  assert.deepEqual(p.windows, []);
  assert.equal(primaryOf(p), null);
});

test("TC-UT-12c: the same shape over TEN days -> hours 4-5 are alert hours, longest window 2 h", () => {
  const p = buildProfile(SHAPE.map((v) => v * 10), 10);
  const alert1Based = p.alert.map((a: boolean, h: number) => (a ? h + 1 : null)).filter((h: number | null) => h != null);
  console.log(`  mean=${p.mean} alert=${JSON.stringify(alert1Based)} windows=${JSON.stringify(p.windows)}`);
  assert.equal(p.mean, 3.0);
  assert.deepEqual(alert1Based, [4, 5]);
  assert.equal(windowSpanHours(primaryOf(p)), 2);
});

test("TC-UT-12d: no days observed -> no alert hours", () => {
  const p = buildProfile(Array(24).fill(0), 0);
  assert.deepEqual(p.windows, []);
});
