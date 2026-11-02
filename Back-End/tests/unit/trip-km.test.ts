import test from "node:test";
import assert from "node:assert/strict";
import { resolvePlaza } from "../../src/etl/canonical-exit.js";
import { openTripKm, tripKm } from "../../src/etl/trip-km.js";
import { PLAZA_CODES } from "../../src/etl/toll-tir.js";

const km = (entry: number, exit: number) => tripKm(entry, exit, resolvePlaza(PLAZA_CODES[entry] ?? ""), resolvePlaza(PLAZA_CODES[exit] ?? ""));
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("a trip with both ends on NLEX is the distance between their km posts", () => {
  const t = km(104, 156); // Balintawak NB to San Fernando NB
  assert.equal(t.kind, "known");
  near((t as { km: number }).km, 65.78 - 12);
});

test("an end on SCTEX counts from where SCTEX meets NLEX", () => {
  const t = km(293, 123); // Tarlac entry to Bocaue Barrier
  assert.equal(t.kind, "known");
  near((t as { km: number }).km, 85.23 - 27.2);
});

test("a trip that never touched NLEX is charged nothing", () => {
  assert.deepEqual(km(293, 202), { kind: "known", km: 0 }); // Tarlac to Tipo
  assert.deepEqual(km(306, 302), { kind: "known", km: 0 }); // España to R10, both on the Connector
});

test("a Connector to SCTEX trip crossed the whole mainline between the two junctions", () => {
  const t = km(302, 292); // R10 Interchange to Tarlac exit
  assert.equal(t.kind, "known");
  near((t as { km: number }).km, 85.23 - 13.63);
});

test("an open-section payment takes the mean of the exits ahead, bounded by the nearest and farthest", () => {
  const b = openTripKm(12, "NB");
  near(b.low, 1.63);
  near(b.high, 15.2);
  near(b.central, (1.63 + 3.44 + 8.21 + 11.73 + 14.05 + 15.2) / 6);
  const t = km(104, 104);
  assert.equal(t.kind, "open");
  near((t as { km: number }).km, b.central);
});

test("the last open exit before Balintawak southbound has one exit ahead, so its bounds meet", () => {
  const s = openTripKm(13.63, "SB");
  near(s.low, 1.63);
  near(s.high, 1.63);
});

test("no usable entry, or two ends at one place, says nothing about distance", () => {
  assert.equal(km(0, 156).kind, "unknown");
  assert.equal(km(197, 156).kind, "unknown"); // No Ticket
  assert.equal(km(124, 114).kind, "unknown"); // CDV entry to CDV exit
});
