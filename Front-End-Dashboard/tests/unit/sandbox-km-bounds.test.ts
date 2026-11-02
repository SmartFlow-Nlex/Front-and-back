/* TC-UT-23  Scenario Sandbox / Km placement bounds
 * There is no single 12–88.25 validator in the sandbox; a typed km goes down
 * one of two paths, both tested on the full-corridor route (origin and
 * destination = the first and last exits, measured Km 12 to 88.25):
 *  1. the simulated window's "From km" box: KmInput's commit (typed official
 *     km post -> kmMeasured) then page.tsx's
 *     `fromKm = min(max(segFromKm, routeFromKm), routeToKm)` — extracted;
 *  2. the lane-reallocation stretch: planStretch(aKm, bKm, limits) in
 *     zipper.ts (exported), which returns ok:false with a reason. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planStretch } from "../../app/dashboard/scenario-sandbox/zipper.ts";
import { kmMeasured, kmPost } from "../../lib/km-post.ts";
import { FALLBACK_EXITS } from "../../lib/nlex-exits.ts";
import { readSource, declaration, between, evaluate } from "../../../Back-End/tests/support/source-extract.ts";

const src = readSource("Front-End-Dashboard/app/dashboard/scenario-sandbox/page.tsx");
const commitBody = between(src, "const n = Number.parseFloat(draft);", "};", "function KmInput(");
const { typedWindowFrom, MIN_SEG_M, MAX_SEG_M } = evaluate<any>(
  [
    declaration(src, "MIN_SEG_M"),
    declaration(src, "MAX_SEG_M"),
    `const typedWindowFrom = (draft: string, routeFromKm: number, routeToKm: number, defaultFrom: number) => {
       let segFromKm: number | null = null;
       const min = routeFromKm, max = routeToKm; // the From box's own range props on the full-corridor route
       const onCommit = (km: number) => { segFromKm = km; };
       const setDraft = (_: unknown) => {};
       ${commitBody}
       ${declaration(src, "fromKm")}
       return { committed: segFromKm, fromKm };
     };`,
  ],
  ["typedWindowFrom", "MIN_SEG_M", "MAX_SEG_M"],
  { kmMeasured },
);

const kms = FALLBACK_EXITS.map((e) => e.km);
const routeFromKm = Math.min(...kms);
const routeToKm = Math.max(...kms);
const limits = { routeFromKm, routeToKm, minKm: MIN_SEG_M / 1000, maxKm: MAX_SEG_M / 1000 };

test("TC-UT-23: route is the whole corridor, measured Km 12 to 88.25", () => {
  console.log(`  route measured ${routeFromKm}..${routeToKm} = posts ${kmPost(routeFromKm)}..${kmPost(routeToKm)}`);
  assert.equal(routeFromKm, 12);
  assert.equal(routeToKm, 88.25);
});

for (const [id, typed, accepted] of [["a", 11.9, false], ["b", 88.3, false], ["c", 25.5, true]] as const) {
  test(`TC-UT-23${id} (stretch, planStretch): typed Km ${typed} -> ${accepted ? "accepted" : "rejected"}`, () => {
    const a = kmMeasured(typed);
    const b = typed < 50 ? a + 1 : a - 1; // the other end 1 km away, inside the 0.1-3 km length limits
    const plan = planStretch(a, b, limits);
    console.log(`  typed ${typed} (measured ${a.toFixed(3)}) -> ${JSON.stringify(plan)}`);
    assert.equal(plan.ok, accepted);
  });

  test(`TC-UT-23${id} (window From km box): typed Km ${typed} -> ${accepted ? "accepted" : "rejected"}`, () => {
    const r = typedWindowFrom(String(typed), routeFromKm, routeToKm, 30);
    console.log(`  typed ${typed} -> committed ${r.committed?.toFixed(3)} measured, window starts at ${r.fromKm.toFixed(3)}`);
    if (accepted) assert.ok(Math.abs(r.fromKm - kmMeasured(typed)) < 1e-9);
    // Rejected = the typed value is not taken. Here it is committed, and the
    // window is then clamped to the route edge.
    else assert.equal(r.committed, null, `typed value committed (${r.committed?.toFixed(3)}); window clamped to ${r.fromKm.toFixed(3)}`);
  });
}
