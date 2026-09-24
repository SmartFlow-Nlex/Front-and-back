import { ASSUMPTIONS } from "./scenarios/assumptions";
import type { Direction } from "./scenarios/adapter";

/**
 * Lane reallocation, as far as this sandbox can honestly model it. (The file and its identifiers keep the
 * name "zipper" from when the feature was first built as a zipper lane / counterflow; the operator-facing
 * name is REALLOCATION_NAME, and the engine's own "zipper merge" is an unrelated thing.)
 *
 * Reallocation moves 1 or 2 lanes from one carriageway to the other, as a movable barrier would: one
 * carriageway gains lanes and the other loses the same number. The engine has no cross-carriageway traffic
 * and cannot change a carriageway's lane count mid-run, so this is modelled as what it does to capacity: the
 * two carriageways' lane counts are changed together, the total kept, and both runs restart (a lane count
 * change always does, see the Lanes slider). Lanes are reassigned; vehicles do not cross the median, and the
 * carriageways still never interact (see the README's limitation).
 *
 * Pure, so verify.ts pins the limits and the refusal wording.
 */

/** What the scheme is called wherever the operator sees it. */
export const REALLOCATION_NAME = "Lane reallocation";

export type ZipperState = {
  /** The carriageway that GAINED lanes. */
  readonly toward: Direction;
  /** How many lanes moved (1 or 2). */
  readonly lanes: number;
  /** Each carriageway's lane count before the transfer — what "Off" restores. */
  readonly base: Readonly<Record<Direction, number>>;
};

export type ZipperPlan =
  | { readonly ok: true; readonly counts: Readonly<Record<Direction, number>>; readonly state: ZipperState }
  | { readonly ok: false; readonly reason: string };

const other = (d: Direction): Direction => (d === "NB" ? "SB" : "NB");

/** Move `lanes` from the other carriageway to `toward`, or say exactly why not. */
export function planZipper(base: Readonly<Record<Direction, number>>, toward: Direction, lanes: number): ZipperPlan {
  const { minLanes, maxLanes, maxTransfer } = ASSUMPTIONS.ZIPPER_LANES.value;
  const donor = other(toward);
  if (!Number.isInteger(lanes) || lanes < 1 || lanes > maxTransfer) {
    return { ok: false, reason: `Move 1 lane (zipper) or ${maxTransfer} (counterflow); got ${lanes}.` };
  }
  if (base[donor] - lanes < minLanes) {
    return { ok: false, reason: `${donor} would drop to ${base[donor] - lanes} lane${base[donor] - lanes === 1 ? "" : "s"}; a carriageway keeps at least ${minLanes}.` };
  }
  if (base[toward] + lanes > maxLanes) {
    return { ok: false, reason: `${toward} would rise to ${base[toward] + lanes} lanes; the most a carriageway takes here is ${maxLanes}.` };
  }
  const counts: Record<Direction, number> = { NB: base.NB, SB: base.SB };
  counts[toward] = base[toward] + lanes;
  counts[donor] = base[donor] - lanes;
  return { ok: true, counts, state: { toward, lanes, base } };
}

/** The lane counts a state put in place. */
export function zipperCounts(state: ZipperState): Readonly<Record<Direction, number>> {
  const counts: Record<Direction, number> = { NB: state.base.NB, SB: state.base.SB };
  counts[state.toward] = state.base[state.toward] + state.lanes;
  counts[other(state.toward)] = state.base[other(state.toward)] - state.lanes;
  return counts;
}

/**
 * True while the carriageways still have the lane counts the zipper set. When something else changed one
 * (the Lanes slider, a new route or segment resetting to the corridor's own count), the scheme no longer
 * describes the road, so the caller drops it rather than keep drawing a barrier that is not there.
 */
export function zipperHolds(state: ZipperState, current: Readonly<Record<Direction, number>>): boolean {
  const want = zipperCounts(state);
  return current.NB === want.NB && current.SB === want.SB;
}

/** How many of `direction`'s innermost lanes it has borrowed (0 for the donor and when no scheme is on). */
export function borrowedLanes(state: ZipperState | null, direction: Direction): number {
  return state !== null && state.toward === direction ? state.lanes : 0;
}

/* ── Which stretch ─────────────────────────────────────────────────────────────
 *
 * A reallocation covers a stretch of road, usually about a kilometre, not the whole corridor. The engine cannot
 * change a carriageway's lane count along its length, so the stretch the operator gives becomes the road the
 * sandbox simulates: both carriageways run it with the reallocated lane counts from end to end, and the road
 * either side is not simulated. These two pure functions decide what stretch is allowed and what to suggest.
 */

export type StretchLimits = {
  /** The route the operator has chosen; the stretch must lie inside it. */
  readonly routeFromKm: number;
  readonly routeToKm: number;
  /** The shortest and longest road the sandbox will simulate at once. */
  readonly minKm: number;
  readonly maxKm: number;
};

export type StretchPlan =
  | { readonly ok: true; readonly fromKm: number; readonly toKm: number }
  | { readonly ok: false; readonly reason: string };

const EPS = 1e-9;
const km2 = (km: number): string => km.toFixed(2);

/** The stretch between two km posts (either order), or why it cannot be simulated. Rounded to the metre. */
export function planStretch(aKm: number, bKm: number, limits: StretchLimits): StretchPlan {
  if (!Number.isFinite(aKm) || !Number.isFinite(bKm)) return { ok: false, reason: "Enter a km post for both ends of the stretch." };
  const lo = Math.min(aKm, bKm);
  const hi = Math.max(aKm, bKm);
  if (lo < limits.routeFromKm - EPS || hi > limits.routeToKm + EPS) {
    return { ok: false, reason: `The stretch must lie inside the route, Km ${km2(limits.routeFromKm)} to Km ${km2(limits.routeToKm)}.` };
  }
  const len = hi - lo;
  if (len < limits.minKm - EPS) return { ok: false, reason: `The stretch must be at least ${km2(limits.minKm)} km (it is ${km2(len)} km).` };
  if (len > limits.maxKm + EPS) return { ok: false, reason: `The sandbox simulates at most ${km2(limits.maxKm)} km at once; ${km2(len)} km is too long.` };
  return { ok: true, fromKm: Number(lo.toFixed(3)), toKm: Number(hi.toFixed(3)) };
}

/**
 * The stretch to suggest: `lengthKm` long. A window already at least that long gets the middle of it; a shorter
 * one keeps its start and runs on downstream (as far as the route goes).
 */
export function defaultStretch(windowFromKm: number, windowToKm: number, routeToKm: number, lengthKm: number): { readonly fromKm: number; readonly toKm: number } {
  const windowLen = windowToKm - windowFromKm;
  if (windowLen >= lengthKm - EPS) {
    const from = windowFromKm + (windowLen - lengthKm) / 2;
    return { fromKm: Number(from.toFixed(3)), toKm: Number((from + lengthKm).toFixed(3)) };
  }
  return { fromKm: Number(windowFromKm.toFixed(3)), toKm: Number(Math.min(routeToKm, windowFromKm + lengthKm).toFixed(3)) };
}
