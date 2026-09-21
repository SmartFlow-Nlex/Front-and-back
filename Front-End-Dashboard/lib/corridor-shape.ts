/**
 * Builds the real shape of the NLEX corridor, and cuts it into the segments the
 * live feed reports on.
 *
 * The backend knows what each exit-to-exit segment is doing but can only draw it
 * as a straight chord, because straight chords are all silver.dim_location
 * stores. The true alignment is in components/maps/nlex-geometry.json. Joining
 * the two is what makes the map read as a road: the feed says WHAT, this says
 * WHERE.
 *
 * The catch is that the JSON is not a path. It is 2,559 points of raw OSM
 * motorway geometry — both carriageways plus ramps, concatenated in whatever
 * order the ways came back, with 47 gaps over 400 m and 65 changes of direction.
 * Walking it end to end covers 196.6 km of a 76.25 km road, so slicing it
 * directly draws the corridor as a doubling-back tangle.
 *
 * So it is resampled rather than sliced. Every point is projected onto the chain
 * of exits to get a distance along the corridor; anything more than
 * CORRIDOR_HALF_WIDTH_M off to the side is a ramp or a frontage road and is
 * dropped; the survivors are binned by that distance and each bin collapses to
 * its median position. Order along the corridor then comes from the bin index,
 * not from the file, which is what makes the result monotonic. Two smoothing
 * passes take out the bin-to-bin jitter.
 *
 * Measured against the km-posts: the rebuilt centreline runs 77.4 km against the
 * corridor's 76.25, and all nineteen segments land within tolerance of their
 * expected length. The residual ~1.5% is the resampling, and is invisible at any
 * zoom the map is read at.
 */

export type LngLat = [number, number];

/* How the centreline is resampled, one pass at a time.

   Each pass projects every OSM point onto a reference line, drops what is too
   far to the side, bins the rest by distance along that line and takes the
   median of each bin. The result becomes the reference for the next pass.

   Refining matters because the first reference is the chain of exits: straight
   chords that cut across every curve, leaving the tarmac by up to a few hundred
   metres. Points that are nowhere near each other then land in the same bin and
   the median lands between them, so the line cuts the corner too. Once the
   reference is roughly road-shaped, the bins hold points that really are
   neighbours and the tolerance can close in.

   The passes were settled by measuring against Mapbox's own motorway geometry
   — the tarmac the reader sees under our ribbons — rather than against the OSM
   file we build from, which cannot say whether the two agree. Sampling 14,860
   basemap segments along the corridor, the line sits a median of 2.9 m from the
   road, 15.9 m at the 95th percentile.

   The last pass bins at 40 m with two smoothing passes rather than 25 m with
   one. The finer version landed just as close but shivered: its heading changed
   an average of 10.1 degrees per vertex against a motorway that turns
   gradually, which read as a zigzag over smooth tarmac. Coarser bins and a
   second pass halve that, and, unusually, fit slightly better too — the jitter
   was noise, not detail. Smoothing harder keeps flattening the wobble but
   starts cutting real curves.

   `step` is what the pass emits, as opposed to `bin`, which is what it
   measures. They were the same thing until the road at Dau came out as a
   staircase: only occupied bins produced a vertex, and since consecutive OSM
   points on one carriageway are about 78 m apart, a 40 m bin is empty more
   often than not. Sampling the offsets at a fixed 40 m instead of taking
   whatever bins happened to be occupied halves the average heading change,
   6.12 degrees to 3.10, drops the turns over 50 degrees from eleven to three,
   and brings the worst corner on the corridor down from 97 degrees to 60.
   Against Mapbox's own tarmac the line also moved closer, from a typical 4.4 m
   to 2.2 m, and at Dau itself from 6.1 m to 3.3 m.

   The one figure that went the other way is the tail at Bocaue, worst case
   61 m to 105 m. That is the centreline running up the middle of an
   interchange where the carriageways fan apart, which is what it is supposed to
   do and is only measurable now because the line carries 2.7 times as many
   vertices through it. Checked on the map: the road there draws clean. */
const PASSES = [
  { halfWidth: 250, bin: 60, smooth: 2, step: 40 },  // reference: the chain of exits
  { halfWidth: 120, bin: 30, smooth: 1, step: 40 },
  { halfWidth: 80, bin: 25, smooth: 1, step: 40 },
  { halfWidth: 60, bin: 40, smooth: 2, step: 40 },
];

// Metres per degree near 15°N. The corridor spans half a degree, so a fixed
// scale here is accurate to well under the width of the road.
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos((15 * Math.PI) / 180);

type XY = [number, number];
const toXY = (p: LngLat): XY => [p[0] * M_PER_DEG_LON, p[1] * M_PER_DEG_LAT];
const fromXY = (p: XY): LngLat => [p[0] / M_PER_DEG_LON, p[1] / M_PER_DEG_LAT];

/** A polyline with its cumulative lengths, ready to be projected onto. */
function measured(line: LngLat[]) {
  const xy = line.map(toXY);
  const cum: number[] = [0];
  for (let i = 1; i < xy.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  }
  return { xy, cum };
}

type Measured = ReturnType<typeof measured>;

/**
 * Distance along the reference of the closest point to `p`, how far off it is,
 * and which SIDE it is on -- signed positive to the left of travel.
 *
 * The sign is what lets a bin be reduced to one number. Without it the only
 * way to summarise a bin is to average its coordinates, and a coordinate
 * average has no idea that the points came from two separate carriageways.
 */
function projectOn(ref: Measured, p: LngLat): { s: number; off: number; side: number } {
  const [qx, qy] = toXY(p);
  let best = { s: 0, off: Infinity, side: 0 };
  for (let i = 1; i < ref.xy.length; i++) {
    const [ax, ay] = ref.xy[i - 1];
    const vx = ref.xy[i][0] - ax;
    const vy = ref.xy[i][1] - ay;
    const len2 = vx * vx + vy * vy;
    if (len2 === 0) continue;
    let t = ((qx - ax) * vx + (qy - ay) * vy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const off = Math.hypot(qx - (ax + t * vx), qy - (ay + t * vy));
    if (off < best.off) {
      const len = Math.sqrt(len2);
      best = {
        off,
        s: ref.cum[i - 1] + t * len,
        side: ((qx - ax) * -vy + (qy - ay) * vx) / len,
      };
    }
  }
  return best;
}

/** The point `lateral` metres to the left of the reference, `s` metres along. */
function pointOnRef(ref: Measured, s: number, lateral: number): LngLat {
  let i = 1;
  while (i < ref.cum.length - 1 && ref.cum[i] < s) i++;
  const [ax, ay] = ref.xy[i - 1];
  const vx = ref.xy[i][0] - ax;
  const vy = ref.xy[i][1] - ay;
  const len = Math.hypot(vx, vy) || 1;
  const t = (s - ref.cum[i - 1]) / len;
  return fromXY([ax + t * vx + (lateral * -vy) / len, ay + t * vy + (lateral * vx) / len]);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/**
 * The mean of the middle 60% of a bin's offsets.
 *
 * Trimmed rather than a plain mean because a ramp inside the half-width would
 * drag it; averaged rather than a median because with both carriageways in the
 * bin a median picks whichever has more points that time, and the centreline is
 * meant to run BETWEEN them -- the ribbons are drawn with line-offset and put
 * themselves back on the tarmac from there.
 */
function trimmedMean(values: number[]): number {
  if (values.length < 5) return median(values);
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * 0.2);
  const keep = sorted.slice(cut, sorted.length - cut);
  return keep.reduce((a, b) => a + b, 0) / keep.length;
}

/**
 * Pulls single-vertex spikes back onto the line.
 *
 * The binning leaves occasional vertices well off the run of the road -- at an
 * interchange the ramp geometry sits inside the last pass's half-width, and a
 * curving ramp carries far more OSM vertices than the straight mainline beside
 * it, so that bin's median lands on the ramp. The result is a near right-angle
 * turn over two short legs: the sharpest were 97 degrees over 31 and 29 metres
 * at Pulilan, and 90 degrees over 36 and 17 at Dau.
 *
 * Those are invisible as geometry but not as drawing. The carriageways are
 * rendered with line-offset, and an offset ribbon splays wide on the outside of
 * a sharp turn and crosses itself on the inside, so a 30 m spike becomes a V
 * tens of pixels across with the two directions pulling apart.
 *
 * A motorway does not turn like that. With vertices about 105 m apart, even a
 * 700 m-radius curve lifts only 8 m off the chord between its neighbours, while
 * a right angle over 30 m legs lifts 21 m. So 14 m separates the artefact from
 * the road, and putting such a vertex back on the chord loses nothing real.
 * Three passes, because flattening one spike can expose the next.
 *
 * It never fixed the broader case, where the fit flipped between the two
 * carriageways across several bins and the line hooked out and back over a few
 * hundred metres -- that was the staircase at Dau, and it needed the binning
 * changed rather than a clean-up after it. `resample` now summarises a bin as a
 * single signed offset and emits vertices at a fixed step, so neither the flip
 * nor the short legs that amplified it can arise. This is kept as a cheap guard
 * on whatever the passes still leave behind.
 */
function despike(line: LngLat[], maxOffsetM = 14, passes = 3): LngLat[] {
  if (line.length < 3) return line;
  const out = line.slice();
  for (let pass = 0; pass < passes; pass++) {
    let moved = 0;
    for (let i = 1; i < out.length - 1; i++) {
      const [ax, ay] = toXY(out[i - 1]);
      const [bx, by] = toXY(out[i]);
      const [cx, cy] = toXY(out[i + 1]);
      const dx = cx - ax;
      const dy = cy - ay;
      const len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((bx - ax) * dx + (by - ay) * dy) / len)) : 0;
      const px = ax + t * dx;
      const py = ay + t * dy;
      if (Math.hypot(bx - px, by - py) > maxOffsetM) {
        out[i] = fromXY([px, py]);
        moved++;
      }
    }
    if (moved === 0) break;
  }
  return out;
}

/**
 * One resampling pass: raw points, measured against `reference`.
 *
 * Each bin is reduced to a single number -- how far the road sits to the left
 * of the reference there -- and the vertex is then placed back on the reference
 * at that offset. The previous version took the median of longitude and the
 * median of latitude INDEPENDENTLY, which is what put the staircase in the road
 * at Dau: the two medians can come from different carriageways, so where the
 * carriageways pull apart at an interchange one bin lands on the northbound
 * track and the next on the southbound, and the line walks between them. An
 * offset cannot do that, because there is only one number to pick.
 *
 * The vertices are also emitted at a FIXED step rather than one per occupied
 * bin. There are about 78 m between consecutive OSM points on one carriageway,
 * so a 40 m bin is empty more often than not, and the survivors landed 7 m
 * apart in one place and 50 m apart in the next. On a short leg, ordinary
 * lateral noise becomes a large angle -- a 7 m leg turned a 2 m wobble into an
 * 89-degree corner, and an offset ribbon on a corner that sharp splays wide on
 * the outside and crosses itself on the inside. Even spacing makes that
 * impossible rather than merely unlikely.
 *
 * Smoothing now runs over the offsets rather than over the finished
 * coordinates, which is the same 1-2-1 kernel applied to the thing that is
 * actually noisy. Smoothing coordinates also pulls real curves straight.
 */
function resample(raw: LngLat[], reference: LngLat[], pass: (typeof PASSES)[number]): LngLat[] {
  const ref = measured(reference);
  const bins = new Map<number, number[]>();

  for (const p of raw) {
    const { s, off, side } = projectOn(ref, p);
    if (off > pass.halfWidth) continue; // ramp, frontage road, service loop
    const key = Math.round(s / pass.bin);
    const bucket = bins.get(key);
    if (bucket) bucket.push(side);
    else bins.set(key, [side]);
  }

  const keys = [...bins.keys()].sort((a, b) => a - b);
  if (keys.length < 2) return [];

  // Distance along the reference, and how far left of it the road runs there.
  let knots: [number, number][] = keys.map((k) => [k * pass.bin, trimmedMean(bins.get(k)!)]);
  for (let i = 0; i < pass.smooth; i++) {
    knots = knots.map((kn, j, a) =>
      j === 0 || j === a.length - 1 ? kn : [kn[0], (a[j - 1][1] + 2 * kn[1] + a[j + 1][1]) / 4],
    );
  }

  const line: LngLat[] = [];
  let j = 0;
  const end = knots[knots.length - 1][0];
  for (let s = knots[0][0]; s <= end; s += pass.step) {
    while (j < knots.length - 2 && knots[j + 1][0] < s) j++;
    const [as, ao] = knots[j];
    const [bs, bo] = knots[j + 1];
    const t = bs === as ? 0 : (s - as) / (bs - as);
    line.push(pointOnRef(ref, s, ao + t * (bo - ao)));
  }
  return line;
}

/**
 * One ordered centreline for the whole corridor, plus the vertex each exit sits
 * on. `exits` must be in corridor order.
 */
function buildCentreline(raw: LngLat[], exits: LngLat[]) {
  let line = exits;
  for (const pass of PASSES) {
    const next = resample(raw, line, pass);
    if (next.length < 2) break; // a pass too tight to keep anything: stop here
    line = next;
  }
  if (line === exits) return { line: exits, cuts: exits.map((_, i) => i) };

  // The passes fit the road well on average and leave spikes at interchanges.
  line = despike(line);

  // Where each exit sits on the finished line.
  const ref = measured(line);
  const cuts = exits.map((e) => {
    const [qx, qy] = toXY(e);
    let bestIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < ref.xy.length; i++) {
      const d = Math.hypot(qx - ref.xy[i][0], qy - ref.xy[i][1]);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  });

  // Keep the cuts advancing. Bocaue Barrier and Bocaue Interchange sit ~600 m
  // apart and can land on the same vertex; the later one is nudged past the
  // earlier rather than swapped, since the corridor order is known and correct.
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i] <= cuts[i - 1]) cuts[i] = Math.min(cuts[i - 1] + 1, line.length - 1);
  }

  return { line, cuts };
}

/**
 * One sub-path per consecutive pair of exits, following the real road.
 * Returns `exits.length - 1` entries, so entry i is segment_order i + 1.
 */
export function sliceCorridor(raw: LngLat[], exits: LngLat[]): LngLat[][] {
  if (raw.length < 2 || exits.length < 2) return [];
  const { line, cuts } = buildCentreline(raw, exits);
  if (line.length < 2) return [];

  const out: LngLat[][] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    // slice is end-exclusive, so +1 keeps the shared vertex and the ribbons meet.
    const part = line.slice(a, b + 1);
    out.push(part.length >= 2 ? part : [line[a], line[Math.min(a + 1, line.length - 1)]]);
  }
  return out;
}


/* ---------------------------------------------------------------------------
   Is a report actually on NLEX?

   The Waze feed is polled over a bounding box, so it returns everything in the
   area, and the backend matched alerts to the nearest exit within 3 km -- wide
   enough to sweep in MacArthur Highway, Maysan Road, Quirino Highway and the
   rest of the surrounding network. Measured against the corridor centreline,
   all 22 alerts in a sample were off it, the nearest by 334 m, and three of
   seven jams sat on Pulilan Regional Road up to 1.4 km away.

   Distance is measured to the corridor itself rather than to an exit, because
   an exit is a point and the road is 76 km long: anything within a few hundred
   metres of an exit is near a junction, not necessarily near the highway.
   ------------------------------------------------------------------------- */

/** Covers the carriageways, their ramps and the service roads alongside. */
export const CORRIDOR_TOLERANCE_M = 200;

/**
 * Is this Waze street name the NLEX corridor itself?
 *
 * Being within the tolerance is not enough to be the expressway. Service roads,
 * frontage roads and the local roads that cross NLEX run within metres of it for
 * long stretches, so geometry alone let a jam on "East Service Rd" and one on
 * "Santa Ana - Mexico - San Luis - San Simon Rd" paint mainline ribbons red.
 *
 * Ramps and exits are kept deliberately: "E1: NLEX N On-Ramp" and "NLEX Mexico
 * Exit" are NLEX, and traffic backing onto a ramp is traffic on the corridor.
 * Matching "expressway" alone would leak in SLEX and Skyway, so the name has to
 * say NLEX or North Luzon.
 *
 * Mirrors isNlexCorridorStreet in the backend's lib/nlex-corridor.ts, which
 * applies the same test to the alerts.
 */
export function isNlexStreet(street: string | null | undefined): boolean {
  const s = (street || "").toLowerCase();
  if (!s) return true; // Waze named no road; geometry is all there is to go on.
  const isNlex = s.includes("nlex") || s.includes("north luzon");
  const isNeighbour =
    s.includes("service") || s.includes("crossing") || s.includes("exit rd") ||
    s.includes("slex") || s.includes("skyway") || s.includes("sctex") ||
    s.includes("tplex") || s.includes("cavitex");
  return isNlex && !isNeighbour;
}

/**
 * Which carriageway a point report is on.
 *
 * Two signals, and they disagree often enough to need an order. The street name
 * is the carriageway Waze assigned the report — "E1: NLEX N On-Ramp" — and it is
 * a statement about the road. The heading is the reporter's own bearing, which
 * on a curving ramp points wherever the driver happened to be facing: one live
 * report sat on "NLEX N On-Ramp" with a heading of 129 degrees, pointing
 * south-east. So the name wins, and the heading is used only where the name
 * declares nothing.
 *
 * NLEX runs roughly SSE to NNW, so a bearing in the northern half means
 * northbound. Reports with neither signal get no direction rather than a guess.
 */
export function reportDirection(
  street: string | null | undefined,
  heading: number | null | undefined,
): "NB" | "SB" | null {
  const named = directionFromStreet(street);
  if (named) return named;
  if (heading == null || !Number.isFinite(heading)) return null;
  const deg = ((heading % 360) + 360) % 360;
  return deg < 90 || deg > 270 ? "NB" : "SB";
}

/** "Northbound" / "Southbound", or null when neither signal says. */
export function directionLabel(
  street: string | null | undefined,
  heading: number | null | undefined,
): string | null {
  const d = reportDirection(street, heading);
  return d === "NB" ? "Northbound" : d === "SB" ? "Southbound" : null;
}

export type SnappedJam = {
  coords: LngLat[];
  direction: "NB" | "SB";
  /** "street" when Waze named the direction, "bearing" when it was inferred. */
  directionSource: "street" | "bearing";
  /** Where the jam sits on the centreline, so it can be mapped to segments. */
  startIndex: number;
  endIndex: number;
};

/* Waze names the carriageway on ramps and exits -- "NLEX N San Fernando Exit",
   "E1: NLEX S On-Ramp" -- for roughly half the jams on the corridor. That is
   reported data and beats anything geometry can infer, so it is read first.

   It matters: a jam on "NLEX N San Fernando Exit" has a bearing of 115 deg,
   because the slip road curves away east as it leaves the mainline. Inferring
   from that bearing put a northbound jam on the southbound ribbon. */
export function directionFromStreet(street?: string | null): "NB" | "SB" | null {
  if (!street) return null;
  if (/\bnorth\s*bound\b/i.test(street)) return "NB";
  if (/\bsouth\s*bound\b/i.test(street)) return "SB";
  /* "NLEX N ...", "E1: North Luzon Expressway N", "NLEX S On-Ramp" — the
     letter directly after the road name, spelled out or abbreviated. */
  const m = /\b(?:NLEX|North\s+Luzon\s+Expressway)\s+([NS])\b/i.exec(street);
  if (m) return m[1].toUpperCase() === "N" ? "NB" : "SB";
  return null;
}


export type CorridorGuard = {
  metresOff: (lngLat: number[]) => number;
  onCorridor: (feature: { geometry?: { type?: string; coordinates?: unknown }; properties?: unknown }) => boolean;
  /** Drops off-corridor jams and alerts. Everything else passes through. */
  filter: <T extends { features?: unknown[] }>(fc: T) => T;
  /** The rebuilt centreline, ordered south to north. */
  centreline: LngLat[];
  /** Puts a jam onto the corridor, and works out which way it runs. */
  snap: (coords: number[][], street?: string | null) => SnappedJam | null;
};

export function corridorGuard(raw: LngLat[], exits: LngLat[], toleranceM = CORRIDOR_TOLERANCE_M): CorridorGuard {
  // Parts repeat the previous part's last vertex, so drop it on the way in and
  // the centreline stays a clean ordered path with no doubled points.
  const centreline: LngLat[] = sliceCorridor(raw, exits).reduce<LngLat[]>(
    (acc, part, i) => acc.concat(i === 0 ? part : part.slice(1)),
    [],
  );
  const xy = centreline.map((c) => [c[0] * M_PER_DEG_LON, c[1] * M_PER_DEG_LAT] as const);

  /* The corridor is ordered south to north, so latitude is a usable index into
     it: a point's nearest stretch of road is always near the vertex at the same
     latitude. Binary searching that and scanning a window either side replaces
     a sweep of all ~500 segments per query.

     It is worth the trouble because these run per vertex, per feature, on every
     poll: fifty jams of ten points each was a quarter of a million distance
     tests every fifteen seconds, on the main thread, which showed up as a hitch
     in the flow animation on a fifteen-second beat.

     The window is generous rather than tight — the alignment wanders east and
     west enough that the nearest vertex is not always the one at the matching
     latitude — and is checked against the exhaustive sweep in the scratch
     harness before being relied on. */
  const WINDOW = 48;
  const lats = centreline.map((c) => c[1]);

  const windowAround = (lat: number): [number, number] => {
    let lo = 0;
    let hi = lats.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lats[mid] < lat) lo = mid + 1;
      else hi = mid;
    }
    return [Math.max(1, lo - WINDOW), Math.min(xy.length - 1, lo + WINDOW)];
  };

  const metresOff = (lngLat: number[]): number => {
    if (!xy.length || !lngLat || lngLat.length < 2) return Infinity;
    const qx = lngLat[0] * M_PER_DEG_LON;
    const qy = lngLat[1] * M_PER_DEG_LAT;
    let best = Infinity;
    const [from, to] = windowAround(lngLat[1]);
    for (let i = from; i <= to; i++) {
      const [ax, ay] = xy[i - 1];
      const vx = xy[i][0] - ax;
      const vy = xy[i][1] - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 === 0) continue;
      let t = ((qx - ax) * vx + (qy - ay) * vy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(qx - ax - t * vx, qy - ay - t * vy);
      if (d < best) best = d;
    }
    return best;
  };

  const onCorridor: CorridorGuard["onCorridor"] = (f) => {
    const g = f?.geometry;
    const coords =
      g?.type === "Point" ? [g.coordinates as number[]]
      : g?.type === "LineString" ? (g.coordinates as number[][])
      : [];
    if (!coords.length) return false;
    /* Every vertex, not just the midpoint. Testing the middle alone admitted a
       jam on the Tabang spur road whose geometry wandered 1.6 km off the
       corridor while passing near it: snapped, that would have painted a long
       stretch of mainline as jammed on the strength of a report about a spur.
       Requiring the whole line to be on the corridor keeps ramps and service
       roads, which run within the tolerance for their whole length, and
       excludes anything that merely crosses it. */
    return coords.every((c) => metresOff(c) <= toleranceM);
  };

  /** Index of the centreline vertex nearest a point. */
  const nearestIndex = (lngLat: number[]): number => {
    const qx = lngLat[0] * M_PER_DEG_LON;
    const qy = lngLat[1] * M_PER_DEG_LAT;
    let best = 0;
    let bestD = Infinity;
    const [from, to] = windowAround(lngLat[1]);
    for (let i = from - 1 < 0 ? 0 : from - 1; i <= to; i++) {
      const d = Math.hypot(qx - xy[i][0], qy - xy[i][1]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  /* Waze reports a jam with its own geometry, traced on whichever carriageway
     the reporting drivers were on. Drawn as-is it runs alongside the corridor
     we build rather than on it -- visibly parallel, sometimes a whole
     carriageway's width off, and occasionally floating clear of the road. So a
     jam is snapped: its endpoints are projected onto the centreline and the
     stretch between them is taken from the centreline itself. The jam then lies
     exactly on the ribbon, because it is made of the same points.

     Direction is read from Waze's street name where it names one, and inferred
     from bearing only where it does not. NLEX runs roughly south to north and
     the centreline is ordered the same way, so a jam whose latitude increases
     from start to end is northbound -- but that inference is unreliable exactly
     where jams cluster, on the curving slip roads at exits and ramps. */
  const snap: CorridorGuard["snap"] = (coords, street) => {
    if (!coords || coords.length < 2 || centreline.length < 2) return null;
    const first = coords[0];
    const last = coords[coords.length - 1];

    const a = nearestIndex(first);
    const b = nearestIndex(last);
    let lo = Math.min(a, b);
    let hi = Math.max(a, b);
    // A jam shorter than the resampling interval collapses to one vertex;
    // widen it so it still draws as a line rather than vanishing.
    if (hi === lo) {
      if (hi + 1 < centreline.length) hi += 1;
      else if (lo > 0) lo -= 1;
      else return null;
    }

    const named = directionFromStreet(street);
    return {
      coords: centreline.slice(lo, hi + 1),
      direction: named ?? (last[1] >= first[1] ? "NB" : "SB"),
      directionSource: named ? "street" : "bearing",
      startIndex: lo,
      endIndex: hi,
    };
  };

  return {
    metresOff,
    onCorridor,
    centreline,
    snap,
    filter: (fc) => {
      if (!fc?.features) return fc;
      return {
        ...fc,
        features: (fc.features as { properties?: { feature_type?: string; street?: string } }[]).filter((f) => {
          const kind = f?.properties?.feature_type;
          if (kind !== "jam" && kind !== "alert") return true;

          /* Both are tested by position.

             Alerts were exempted for a while, on the grounds that the API had
             already filtered them by street name — a more meaningful test than
             distance, since it reads the road Waze itself named. It is not
             enough. Waze brands its slip roads: four hazards on "E1: NLEX
             Tabang Spur Road W" sat 1.8 km from the mainline and an "E1: NLEX N
             Entry" 302 m off, and every one of them passed on its name while
             plainly not being on the road the map draws.

             The reason the test was dropped was a disagreement — the tile
             counted a report the map had thrown away — but that was two
             different filters, not one filter being wrong. The tile and the
             maximised view's list now run this same guard, so there is one rule
             and they cannot drift.

             A jam also has to be on the corridor by name, because a jam paints
             the road: service roads run within the tolerance for their whole
             length and would otherwise colour the mainline. */
          if (kind === "jam" && !isNlexStreet(f?.properties?.street)) return false;
          return onCorridor(f as Parameters<CorridorGuard["onCorridor"]>[0]);
        }),
      };
    },
  };
}
