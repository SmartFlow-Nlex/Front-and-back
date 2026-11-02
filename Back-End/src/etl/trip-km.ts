/**
 * How far each toll trip drove on NLEX: the distance emissions are charged on.
 *
 * Emissions were vehicles x segment_km, half the gap to each neighbouring exit (3.79 km on average), so a trip
 * from Balintawak to San Fernando was charged the same few km as one from Balintawak to Harbor Link. The client's
 * transactions name both ends of a trip, so the distance is read from them instead (1 Nov 2026):
 *
 *   both ends known       |km(entry) - km(exit)|, by the measured km posts in lib/km-post.ts
 *   ends on another road  the end counts from where that road meets NLEX (JUNCTION_KM), so only NLEX km are charged
 *   open-section payment  no exit is recorded (the toll is paid on entry), so the distance is the mean of the exits
 *                         ahead up to the closed system: the rule the ADB's NLEX evaluation used for the same gap
 *                         (Performance Evaluation Report PHI 2011, Table A6.2 note a). The nearest and farthest
 *                         of those exits are the trip's hard bounds, reported as the range
 *   no usable entry       entry 0, No Ticket, or a trip whose two ends are the same place: nothing says how far it
 *                         went, so it takes the mean of the known trips at the same plaza and class (fillUnknownKm)
 *
 * A barrier-to-closed-exit row is NOT the same car as that barrier's same-plaza row. Counting them apart reproduces
 * the operator's open-system entries by class at 89 / 97 / 90%, against 67 / 69 / 64% if the same-plaza row already
 * held them (2025 trips against PhilRatings, NLEX Corporation, Nov 2024, Table 3), so both rows are charged.
 */
import { exitMeasuredKm } from "../lib/km-post.js";
import type { ResolvedPlaza } from "./canonical-exit.js";

/** Plazas on SCTEX, SFEX and the NLEX Connector (the client's reference, plaza_code_ref.csv "exprway", 23 Oct 2026).
    A trip PAID at one of them is not an NLEX exit transaction and is held back from the traffic record, as it was
    while these codes had no name: naming them must not move trips into the warehouse (Mabiga 248/256 would otherwise
    resolve to the NLEX SCTEX exit, and Tipo/Concepcion/Tarlac to connecting roads). As an ENTRY they still name the
    trip's origin, and the part of such a trip that is on NLEX is still NLEX emissions. */
export const OTHER_EXPRESSWAY_PLAZAS: ReadonlySet<number> = new Set([
  192, 193, 195, 202, 203, 213, 214, 231, 232, 245, 246, 247, 248, 250, 251, 253, 254, 256, 257, 259, 260, 262, 263, 270, 271, 273, 274, 286, 287, 289, 290, 292, 293, 302, 306, 308,
]);

const CONNECTOR_PLAZAS: ReadonlySet<number> = new Set([302, 306, 308]);

/** Where the other expressways meet NLEX, measured km: the Connector at Harbor Link, SCTEX and SFEX at the SCTEX exit. */
const JUNCTION_KM = { connector: exitMeasuredKm("NLEX Harbor Link")!, sctex: exitMeasuredKm("SCTEX")! };

/** The exits of the open section, south to north, ending at the barrier where the closed system starts. */
const OPEN_EXITS: readonly number[] = ["Balintawak", "NLEX Harbor Link", "Paso de Blas Valenzuela", "Meycauayan", "Marilao", "CDV/PH Arena", "Bocaue Barrier"]
  .map((n) => exitMeasuredKm(n)!);

export type OpenKm = { low: number; central: number; high: number };

/** Hard bounds and central distance of a trip paid on entry at an open-section plaza, by travel direction. A plaza
    the record does not split by direction (Mindanao, Karuhatan) can reach the exits either side of it. */
export function openTripKm(km: number, direction: string | null): OpenKm {
  const ahead = OPEN_EXITS.filter((x) => (direction === "NB" ? x > km : direction === "SB" ? x < km : x !== km)).map((x) => Math.abs(x - km));
  if (ahead.length === 0) return { low: 0, central: 0, high: 0 };
  return { low: Math.min(...ahead), central: ahead.reduce((s, x) => s + x, 0) / ahead.length, high: Math.max(...ahead) };
}

const measuredKm = (p: ResolvedPlaza): number | undefined => (p.canonical ? exitMeasuredKm(p.canonical) : undefined);

/** A plaza's position on NLEX: its own km post, or the junction its expressway meets NLEX at. */
function positionKm(code: number, plaza: ResolvedPlaza): number | undefined {
  if (CONNECTOR_PLAZAS.has(code)) return JUNCTION_KM.connector;
  if (OTHER_EXPRESSWAY_PLAZAS.has(code)) return JUNCTION_KM.sctex;
  return plaza.status === "nlex" ? measuredKm(plaza) : undefined;
}

export type TripKm =
  | { kind: "known"; km: number }
  /** Paid on entry at an open-section plaza. */
  | { kind: "open"; km: number }
  /** Nothing says how far it went: see fillUnknownKm. */
  | { kind: "unknown" };

/** The km of a trip on NLEX. `kind: "known"` with km 0 is a trip that never touched NLEX (both ends off it). */
export function tripKm(entryCode: number, exitCode: number, entry: ResolvedPlaza, exit: ResolvedPlaza): TripKm {
  const x = positionKm(exitCode, exit);
  if (entryCode === exitCode && exit.system === "OS" && exit.role === "Entry" && x !== undefined) return { kind: "open", km: openTripKm(x, exit.direction ?? null).central };
  const e = positionKm(entryCode, entry);
  if (e === undefined || x === undefined) return { kind: "unknown" };
  // Both ends off NLEX and joining it at the same junction: the trip never drove on NLEX. Connector to SCTEX joins at
  // two different junctions, so it crossed the mainline and is charged the km between them.
  const offNlex = OTHER_EXPRESSWAY_PLAZAS.has(entryCode) && OTHER_EXPRESSWAY_PLAZAS.has(exitCode) && e === x;
  if (offNlex) return { kind: "known", km: 0 };
  return e === x ? { kind: "unknown" } : { kind: "known", km: Math.abs(e - x) };
}
