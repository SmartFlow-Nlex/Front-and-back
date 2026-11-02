/* TC-UT-08  Incidents / Crash Rate in Rain
 * app/dashboard/incident/page.tsx: the `derived` useMemo turns wet/dry crash
 * counts and hours of exposure into crashes per day (count / hours * 24) and
 * the wet/dry multiplier. That block is extracted; `source` (the Incident type
 * filter) is injected as "all". Days are given as hours: 10 days = 240 h. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource, between, evaluate } from "../../../Back-End/tests/support/source-extract.ts";

const src = readSource("Front-End-Dashboard/app/dashboard/incident/page.tsx");
const block = between(src, "const wetCrashes =", "return { deltaPct", "const derived = useMemo(");
const tileFmt = /derived\?\.rainMultiplier != null \? `\$\{derived\.rainMultiplier\.toFixed\((\d)\)\}×`/.exec(src);

const { rain } = evaluate<any>(
  [`const rain = (wx: any, source: string) => { ${block} return { wetRate, dryRate, rainMultiplier, rainEmptyReason }; };`],
  ["rain"],
);

test("TC-UT-08: wet 30 incidents over 10 days, dry 100 over 100 days -> 3.0/day, 1.0/day, 3.0x", () => {
  const wx = { wetHours: 10 * 24, dryHours: 100 * 24, incidents: { wet: { accident: 30 }, dry: { accident: 100 } } };
  const r = rain(wx, "all");
  assert.ok(tileFmt, "multiplier tile format not found");
  const shown = `${r.rainMultiplier.toFixed(Number(tileFmt[1]))}×`;
  console.log(`  wetRate=${r.wetRate} dryRate=${r.dryRate} multiplier=${r.rainMultiplier} tile="${shown}"`);
  assert.equal(r.wetRate, 3.0);
  assert.equal(r.dryRate, 1.0);
  assert.equal(r.rainMultiplier, 3.0);
  assert.equal(r.rainEmptyReason, null);
});

test("TC-UT-08b: rain only in the busy hour -> the same-hour comparison reads 1.0x where the plain ratio read 5.3x", () => {
  // 03:00 is dry and quiet (9 crashes in 900 h); 15:00 crashes at 0.1/h wet or dry, and all the rain falls then.
  const cells = [
    { dow: 1, hour: 3, wetHours: 0, dryHours: 900, wetAccident: 0, wetBreakdown: 0, dryAccident: 9, dryBreakdown: 0 },
    { dow: 1, hour: 15, wetHours: 100, dryHours: 100, wetAccident: 10, wetBreakdown: 0, dryAccident: 10, dryBreakdown: 0 },
  ];
  const wx = { wetHours: 100, dryHours: 1000, incidents: { wet: { accident: 10 }, dry: { accident: 19 } }, cells };
  const r = rain(wx, "all");
  console.log(`  plain ${(r.wetRate / r.dryRate).toFixed(2)}x, same hour ${r.rainMultiplier.toFixed(2)}x`);
  assert.ok(Math.abs(r.wetRate / r.dryRate - 5.263) < 0.01);
  assert.equal(r.rainMultiplier, 1.0);
});
