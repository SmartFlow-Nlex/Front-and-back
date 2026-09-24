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

