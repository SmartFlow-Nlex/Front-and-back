/**
 * How the traffic is painted on the canvas: a light-to-dark pair each body is shaded between, chosen from the
 * vehicle's id so a vehicle keeps its colour for its whole life (never re-rolled per frame).
 *
 * The mix follows what is actually on a road: mostly white, silver, grey and black cars, then blues and
 * reds, and a few greens, beiges, yellows and oranges. Buses and truck cabs wear liveries (white, blue,
 * red, green, yellow, orange), and trailers are mostly white or silver. Pure, so verify.ts checks the
 * spread; decoration only, nothing here touches the simulation.
 */

export type Paint = {
  /** Highlight side of the body gradient. */
  readonly hi: string;
  /** Shadow side of the body gradient. */
  readonly lo: string;
  /** A lighter rim, for dark paint that would otherwise vanish into the asphalt. */
  readonly edge?: string;
  /** Glass tint, for the same reason. */
  readonly glass?: string;
};

const RIM = "rgba(210,220,235,0.5)";
const PALE_GLASS = "rgba(140,158,186,0.85)";

export const PAINT_WHITE: Paint = { hi: "#ffffff", lo: "#c9d1dc" };
export const PAINT_SILVER: Paint = { hi: "#f1f5f9", lo: "#a7b2c1" };
export const PAINT_GREY: Paint = { hi: "#d3dae4", lo: "#7d8999" };
export const PAINT_CHARCOAL: Paint = { hi: "#7a8595", lo: "#2a323f", edge: RIM, glass: PALE_GLASS };
export const PAINT_BLACK: Paint = { hi: "#5e6877", lo: "#171d29", edge: RIM, glass: PALE_GLASS };
export const PAINT_NAVY: Paint = { hi: "#4c6db8", lo: "#1b2a5e", edge: RIM, glass: PALE_GLASS };
export const PAINT_BLUE: Paint = { hi: "#7db2ff", lo: "#1d4fd8" };
export const PAINT_RED: Paint = { hi: "#ff8a8a", lo: "#b91c1c" };
export const PAINT_MAROON: Paint = { hi: "#c1616b", lo: "#5a1822", edge: RIM, glass: PALE_GLASS };
export const PAINT_GREEN: Paint = { hi: "#7ee2a8", lo: "#15803d" };
export const PAINT_TEAL: Paint = { hi: "#69e5d3", lo: "#0f766e" };
export const PAINT_BEIGE: Paint = { hi: "#f7ead0", lo: "#bfa77a" };
export const PAINT_YELLOW: Paint = { hi: "#fff08a", lo: "#d19a06" };
export const PAINT_ORANGE: Paint = { hi: "#ffc08a", lo: "#c2410c" };

/** A paint and its weight out of 100. */
type Weighted = readonly (readonly [Paint, number])[];

export const CAR_PAINTS: Weighted = [
  [PAINT_WHITE, 24],
  [PAINT_SILVER, 15],
  [PAINT_GREY, 12],
  [PAINT_BLACK, 14],
  [PAINT_NAVY, 4],
  [PAINT_BLUE, 8],
  [PAINT_RED, 7],
  [PAINT_MAROON, 3],
  [PAINT_GREEN, 3],
  [PAINT_TEAL, 1],
  [PAINT_BEIGE, 4],
  [PAINT_YELLOW, 2],
  [PAINT_ORANGE, 2],
  [PAINT_CHARCOAL, 1],
];
export const BUS_PAINTS: Weighted = [
  [PAINT_WHITE, 30],
  [PAINT_BLUE, 20],
  [PAINT_RED, 15],
  [PAINT_GREEN, 15],
  [PAINT_YELLOW, 10],
  [PAINT_ORANGE, 10],
];
export const CAB_PAINTS: Weighted = [
  [PAINT_WHITE, 30],
  [PAINT_BLUE, 20],
  [PAINT_RED, 15],
  [PAINT_ORANGE, 10],
  [PAINT_GREEN, 10],
  [PAINT_YELLOW, 5],
  [PAINT_GREY, 10],
];
export const TRAILER_PAINTS: Weighted = [
  [PAINT_WHITE, 45],
  [PAINT_SILVER, 20],
  [PAINT_BLUE, 15],
  [PAINT_RED, 5],
  [PAINT_BEIGE, 10],
  [PAINT_GREEN, 5],
];

const mixed = (id: number, salt: number): number => {
  let h = Math.imul(id + 1, 2654435761) ^ Math.imul(salt + 1, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return h >>> 0;
};

/** A stable pseudo-random 0..99 for a vehicle id and a purpose (`salt`), so body and trailer colours are independent. */
export const rollFor = (id: number, salt: number): number => mixed(id, salt) % 100;

/** The same, in 0..9999, for rare things (a motorcycle is about one Class 1 vehicle in eighty). */
export const fineRollFor = (id: number, salt: number): number => mixed(id, salt) % 10000;

function pick(roll: number, table: Weighted): Paint {
  let upTo = 0;
  for (const [paint, weight] of table) {
    upTo += weight;
    if (roll < upTo) return paint;
  }
  return table[table.length - 1][0];
}

/** The body colour of a vehicle: a car's paint, a bus's livery, or a truck cab's. */
export function paintFor(id: number, vClass: 1 | 2 | 3): Paint {
  return pick(rollFor(id, 1), vClass === 1 ? CAR_PAINTS : vClass === 2 ? BUS_PAINTS : CAB_PAINTS);
}

/** A truck's trailer, painted independently of its cab. */
export function trailerPaintFor(id: number): Paint {
  return pick(rollFor(id, 2), TRAILER_PAINTS);
}

/** Bikes are kept to paints that show up on dark asphalt (no black), since a rider is a small thing to see. */
export const MOTORCYCLE_PAINTS: Weighted = [
  [PAINT_RED, 25],
  [PAINT_BLUE, 20],
  [PAINT_WHITE, 15],
  [PAINT_ORANGE, 10],
  [PAINT_YELLOW, 10],
  [PAINT_GREEN, 10],
  [PAINT_GREY, 10],
]; 

/**
 * Is this vehicle DRAWN as a motorcycle? Only a Class 1 vehicle can be, and `share` (0..1) of them are — the
 * share comes from the data (ASSUMPTIONS.MOTORCYCLE_SHARE_OF_CLASS_1). Picture only: the engine still sees a car.
 */
export function isMotorcycle(id: number, vClass: 1 | 2 | 3, share: number): boolean {
  return vClass === 1 && fineRollFor(id, 3) < Math.round(share * 10000);
}

export function motorcyclePaintFor(id: number): Paint {
  return pick(rollFor(id, 4), MOTORCYCLE_PAINTS);
}
