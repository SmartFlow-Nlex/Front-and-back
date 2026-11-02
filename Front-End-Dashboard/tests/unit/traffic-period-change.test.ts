/* TC-UT-05  Traffic / Change vs previous period
 * app/dashboard/traffic/page.tsx: the `derived` useMemo computes
 * volumeDeltaPct from average daily volume (totalVolume/days vs
 * prevTotalVolume/prevDays); fmtPct formats it; the Total Volume tile renders
 * `derived ? fmtPct(derived.volumeDeltaPct) : "—"`. Those exact lines are
 * extracted. Both periods are given the same day count (90), so the ADT ratio
 * equals the totals ratio the sheet uses. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource, declaration, between, evaluate } from "../../../Back-End/tests/support/source-extract.ts";

const src = readSource("Front-End-Dashboard/app/dashboard/traffic/page.tsx");
const deltaLines = between(src, "const curAdt =", "const weekdayByHour", "const derived = useMemo(");
// The tile: {derived ? (<span ...>{fmtPct(derived.volumeDeltaPct)}</span>) : "—"} vs previous period
const tile = between(src, "{derived ? (", "vs previous period", "<h3>Total Volume");
assert.match(tile, /\{fmtPct\(derived\.volumeDeltaPct\)\}/);
assert.match(tile, /\) : "—"\}/);

const { delta, fmtPct } = evaluate<any>(
  [
    declaration(src, "fmtPct"),
    `const delta = (kpis: { totalVolume: number; days: number; prevTotalVolume: number; prevDays: number }) => { ${deltaLines} return volumeDeltaPct; };`,
  ],
  ["delta", "fmtPct"],
);

/** What the tile shows, following the extracted render branch (derived is non-null once data loads). */
const tileText = (cur: number, prev: number) => {
  let pct: number;
  try {
    pct = delta({ totalVolume: cur, days: 90, prevTotalVolume: prev, prevDays: 90 });
  } catch (e) {
    return { error: e as Error, text: "" };
  }
  return { error: null, text: `${fmtPct(pct)} vs previous period`, pct };
};

test("TC-UT-05a: current 1,100,000 vs previous 1,000,000 -> +10.0%", () => {
  const r = tileText(1_100_000, 1_000_000);
  console.log(`  tile="${r.text}"`);
  assert.equal(r.text, "+10.0% vs previous period");
});

test("TC-UT-05b: current 900,000 vs previous 1,000,000 -> -10.0%", () => {
  const r = tileText(900_000, 1_000_000);
  console.log(`  tile="${r.text}"`);
  assert.equal(r.text, "-10.0% vs previous period");
});

test("TC-UT-05c: previous 0 -> no error (no division by zero)", () => {
  const r = tileText(500_000, 0);
  console.log(`  tile="${r.text}" pct=${r.pct}`);
  assert.equal(r.error, null);
  // No division by zero: no Infinity or NaN. null means "nothing to compare", which the next test checks is shown so.
  assert.ok(r.pct === null || Number.isFinite(r.pct));
});

test("TC-UT-05c: previous 0 -> no percentage shown", () => {
  const r = tileText(500_000, 0);
  assert.doesNotMatch(r.text, /%/, `tile shows "${r.text}"`);
});
