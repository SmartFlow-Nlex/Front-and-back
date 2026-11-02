/* TC-UT-18  Traffic / Event intervention ranking
 * components/dashboard/prescriptiveTraffic.shared.ts: rankByLowerBound(), with exitsFromEvents() and
 * exitsFromUpcoming() building its rows. Redesigned 2 Nov 2026: TOPSIS and its hand-set weights
 * (0.40 / 0.25 / 0.20 / 0.15) were removed. Exits are ranked by the extra vehicles at the LOWER end of the
 * uplift's 95% interval, and only exits whose lower end is above 1 (a material effect) are ranked. The file
 * keeps its name so the test-case sheet's reference still finds it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rankByLowerBound, exitsFromEvents, exitsFromUpcoming, type EventRow, type UpcomingEvent,
} from "../../components/dashboard/prescriptiveTraffic.shared.ts";

const row = (exit: string, baseline: number, uplift: number, lo: number, hi: number): EventRow => ({
  exit, event: "test", baseline, surge: Math.round(baseline * uplift), uplift, upliftLo: lo, upliftHi: hi,
  nEvents: 118, material: lo > 1, anchorExit: "Z",
});

test("TC-UT-18a: X (at least 500, est. 900), Y (at least 700, est. 800), Z (interval reaches 1) -> rank Y, X; Z left out", () => {
  const ranked = rankByLowerBound(exitsFromEvents([
    row("X", 1000, 1.9, 1.5, 2.3),
    row("Y", 1000, 1.8, 1.7, 1.9),
    row("Z", 5000, 1.3, 0.95, 1.6),
  ]));
  console.log(`  ${ranked.map((r) => `${r.rank}. ${r.exit} >=${r.extraLo} est ${r.extra}`).join(" | ")}`);
  assert.deepEqual(ranked.map((r) => r.exit), ["Y", "X"]);
  assert.deepEqual(ranked.map((r) => r.extraLo), [700, 500]);
  assert.deepEqual(ranked.map((r) => r.rank), [1, 2]);
});

test("TC-UT-18b: an upcoming event ranks on its own date's baseline; an exit whose low end is under baseline is left out", () => {
  const ev: UpcomingEvent = {
    date: "2026-11-14", title: "Test concert", isDerived: false, capacity: null, venue: null,
    exits: [
      { exit: "A", baseline: 2000, surge: 2600, surgeLo: 2300, surgeHi: 2900, uplift: 1.3, nEvents: 118 },
      { exit: "B", baseline: 4000, surge: 4400, surgeLo: 3900, surgeHi: 4900, uplift: 1.1, nEvents: 118 },
      { exit: "C", baseline: 1000, surge: 1500, surgeLo: 1400, surgeHi: 1600, uplift: 1.5, nEvents: 118 },
    ],
  };
  const ranked = rankByLowerBound(exitsFromUpcoming(ev));
  console.log(`  ${ranked.map((r) => `${r.rank}. ${r.exit} >=${r.extraLo}`).join(" | ")}`);
  assert.deepEqual(ranked.map((r) => r.exit), ["C", "A"]);
  assert.deepEqual(ranked.map((r) => r.extraLo), [400, 300]);
});
