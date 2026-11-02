/* TC-UT-14  Incidents / Clearance protocol input validation
 * src/validators/incident.validator.ts: ClearanceProtocolQuerySchema
 * (the query schema for GET /api/incident/clearance-protocol).
 * Changed 2 Nov 2026 (the "no assumptions" redesign): 14a-c and 14e checked
 * the bounds and defaults of maxUnits, unitEffect, unitCostPerHour and
 * deltaResponseMin, the MILP's assumed inputs. Those are gone; the schema now
 * takes only the data filters, and an old link still sending them is not
 * rejected (zod drops unknown keys). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClearanceProtocolQuerySchema } from "../../src/validators/incident.validator.js";

test("TC-UT-14a: the old what-if parameters are accepted and dropped, not used", () => {
  const r = ClearanceProtocolQuerySchema.safeParse({ maxUnits: "7", unitEffect: "1.2", demandLevel: "peak", deltaResponseMin: "15" });
  assert.equal(r.success, true);
  assert.deepEqual(Object.keys(r.success ? r.data : {}).sort(), ["months", "severity", "type", "weather"]);
});

test("TC-UT-14b: an unknown incident type is rejected", () => {
  assert.equal(ClearanceProtocolQuerySchema.safeParse({ type: "fire" }).success, false);
});

test("TC-UT-14c: an unknown severity is rejected", () => {
  assert.equal(ClearanceProtocolQuerySchema.safeParse({ severity: "minor" }).success, false);
});

test("TC-UT-14d: no severity given defaults to injury", () => {
  const r = ClearanceProtocolQuerySchema.parse({});
  assert.equal(r.severity, "injury");
});

test("TC-UT-14e: no filters given defaults to accident / all weather / 12 months", () => {
  const r = ClearanceProtocolQuerySchema.parse({});
  assert.equal(r.type, "accident");
  assert.equal(r.weather, "all");
  assert.equal(r.months, "12");
});
