import type { Direction } from "../scenarios/adapter";

export const DIRECTION_NAME: Readonly<Record<Direction, string>> = { NB: "Northbound", SB: "Southbound" };

/**
 * The one way a carriageway is named in Both mode. Every control, event row, readout and banner that
 * belongs to a single direction carries this, so which road a control touches is read off the control
 * itself rather than inferred from what happens to be focused. The colour is a second cue, never the
 * only one: the letters are always there.
 */
export default function DirectionPill({ direction, long }: { direction: Direction; long?: boolean }) {
  return (
    <span className={`sandbox-dir-pill dir-${direction}`} data-dir={direction}>
      {long ? DIRECTION_NAME[direction] : direction}
    </span>
  );
}
