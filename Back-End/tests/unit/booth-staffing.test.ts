/* TC-UT-06  Traffic / Staffing priority and the congestion Act line
 * (redesigned 2 Nov 2026: the booth plan, its throughput slider and booth caps were removed because none of
 * them were measured; the pre-redesign version of this test is in
 * SmartFlow_backups/prescriptive_before_redesign_2026-11-02).
 *
 * src/services/traffic-prescriptive.service.ts:
 *   staffingCell(hour, forecast, usual, q) rates one plaza-hour against the plaza's usual peak, where q is the
 *     plaza's measured held-out ratio (actual / forecast) at quantiles 0.01..0.99. Near-certain ("above") when
 *     the chance of passing the usual peak is 90% or more, i.e. the 80% band's low end passes it; "likely" at
 *     50% or more; not rated under MIN_CELL vehicles.
 *   sweep + pickThreshold choose the congestion Act line: the p_high cut-off with the highest F1.
 * src/controllers/traffic.controller.ts: PrescriptiveTrafficQuerySchema takes no operator dials any more. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { readSource, declaration, evaluate } from "../support/source-extract.js";

const service = readSource("Back-End/src/services/traffic-prescriptive.service.ts");
const controller = readSource("Back-End/src/controllers/traffic.controller.ts");

const { staffingCell } = evaluate<any>(
  ["MIN_CELL", "CERTAIN", "LIKELY", "quantileAt", "exceedChance", "staffingCell"].map((n) => declaration(service, n)),
  ["staffingCell"],
);
const { sweep, pickThreshold, f1Of } = evaluate<any>(
  ["sweep", "f1Of", "pickThreshold"].map((n) => declaration(service, n)),
  ["sweep", "pickThreshold", "f1Of"],
);

/** A plaza whose held-out ratio is spread evenly from 0.8 to 1.2: q10 = 0.84, q90 = 1.16. */
const even = Array.from({ length: 99 }, (_, i) => 0.8 + (0.4 * (i + 1)) / 100);

test("TC-UT-06a: forecast 5,000 vehicles, usual peak 4,100, band low end 4,200 -> near-certain (staff above normal)", () => {
  const c = staffingCell(8, 5000, { median: 4000, peak: 4100 }, even);
  console.log(`  ${JSON.stringify(c)}`);
  assert.equal(c.low, 4200);
  assert.equal(c.high, 5800);
  assert.equal(c.load, 1.25);
  assert.ok(c.chance >= 0.9, `chance ${c.chance}`);
  assert.equal(c.level, "above");
});

test("TC-UT-06b: forecast 4,300 just over a usual peak of 4,200 -> likely, not near-certain", () => {
  const c = staffingCell(8, 4300, { median: 4000, peak: 4200 }, even);
  console.log(`  ${JSON.stringify(c)}`);
  assert.ok(c.chance >= 0.5 && c.chance < 0.9, `chance ${c.chance}`);
  assert.equal(c.level, "likely");
});

test("TC-UT-06c: a plaza-hour under 200 vehicles is outside the measured range -> not rated", () => {
  const c = staffingCell(3, 150, { median: 100, peak: 120 }, even);
  console.log(`  ${JSON.stringify(c)}`);
  assert.equal(c.chance, null);
  assert.equal(c.low, null);
  assert.equal(c.level, "normal");
});

test("TC-UT-06d: Act line = the p_high cut-off with the highest F1 (ties to the more precise one)", () => {
  // 10 High hours forecast at 0.30; 50 non-High at 0.10 and 5 at 0.35.
  const bins = [
    { test: false, b: 30, pos: true, n: 10 },
    { test: false, b: 10, pos: false, n: 50 },
    { test: false, b: 35, pos: false, n: 5 },
  ];
  const best = pickThreshold(sweep(bins));
  console.log(`  threshold=${best.t} tp=${best.tp} fp=${best.fp} fn=${best.fn} f1=${f1Of(best).toFixed(3)}`);
  assert.equal(best.t, 0.3);
  assert.deepEqual([best.tp, best.fp, best.fn], [10, 5, 0]);
  assert.equal(Math.round(f1Of(best) * 1000) / 1000, 0.8);
});

test("TC-UT-06e (API): the prescriptive query takes no throughput or pool; an old ?throughput= is ignored", () => {
  const { PrescriptiveTrafficQuerySchema } = evaluate<any>(
    [declaration(controller, "PrescriptiveTrafficQuerySchema")],
    ["PrescriptiveTrafficQuerySchema"],
    { z },
  );
  const r = PrescriptiveTrafficQuerySchema.safeParse({ throughput: "100", pool: "5", split: "80_20" });
  console.log(`  success=${r.success} data=${JSON.stringify(r.success ? r.data : null)}`);
  assert.ok(r.success);
  assert.deepEqual(r.data, { split: "80_20" });
});
