"use client";

import { corridorGuard, sliceCorridor, type LngLat } from "./corridor-shape";
import { FALLBACK_EXITS, accessLabel, type NlexExit } from "./nlex-exits";
import nlexGeometry from "../components/maps/nlex-geometry.json";

/**
 * Per-exit corridor status, derived from the live map's own feed.
 *
 * The Home tab's corridor panel and the Maps tab's live map used to answer this
 * question through two different pipelines: the panel read
 * /api/dashboard/corridor-status, which aggregated in SQL, while the map
 * filtered and snapped the jams in the browser. They disagreed. Both applied
 * the NLEX street-name test, but only the map also required a jam to lie on the
 * corridor geometrically, and only the map read direction from the street name
 * before falling back to bearing. So the panel would call a stretch congested
 * on the strength of a jam the map had thrown away.
 *
 * This is now the single derivation. It runs the same corridorGuard the map
 * draws with, on the same payload, so the two cannot differ in principle rather
 * than merely agreeing today.
 */

export type SegmentStatus = "clear" | "slow" | "congested";

export type ExitStatus = {
  exit: string;
  direction: "NB" | "SB";
  status: SegmentStatus;
  level: number | null;
  speedKmh: number | null;
  jamCount: number;
  observedAt: string | null;
  /** The longest single queue at this exit, in metres.
   *
   *  Deliberately the longest and not the total. Waze's reports overlap
   *  heavily here -- measured against the length of their geometric union,
   *  summing them overstated by 49% to 520% across the corridor, and at Tabang
   *  Guiguinto by six times -- because successive reports re-describe the same
   *  queue. Adding them up would invent road that is not queued. The longest
   *  one is a figure Waze actually measured, and it never overstates. */
  longestQueueMeters: number | null;
  /** The worst single queue's delay, in seconds. Not a sum either, and for the
   *  same reason: these reports overlap, so adding their delays would claim a
   *  wait nobody was measured making. */
  delaySeconds: number | null;
};

/* Waze's own bands, unchanged from the server-side version this replaces, so
   the words on the panel do not shift with the source. */
function classify(level: number | null, speedKmh: number | null): SegmentStatus {
  if (level == null && speedKmh == null) return "clear";
  if (level === 0) return "clear";
  if ((level != null && level >= 3) || (speedKmh != null && speedKmh < 10)) return "congested";
  return "slow";
}

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos((15 * Math.PI) / 180);

const orderedExits = (exits: NlexExit[]) => [...exits].sort((a, b) => a.km - b.km);

let cachedParts: LngLat[][] | null = null;
function partsFor(exits: NlexExit[]) {
  if (!cachedParts) {
    cachedParts = sliceCorridor(
      (nlexGeometry as unknown as { coordinates: LngLat[] }).coordinates,
      orderedExits(exits).map((e) => [e.longitude, e.latitude] as LngLat),
    );
  }
  return cachedParts;
}

let cachedGuard: ReturnType<typeof corridorGuard> | null = null;
function guardFor(exits: NlexExit[]) {
  // The geometry is static, so the centreline is built once per session.
  if (!cachedGuard) {
    cachedGuard = corridorGuard(
      (nlexGeometry as unknown as { coordinates: LngLat[] }).coordinates,
      orderedExits(exits).map((e) => [e.longitude, e.latitude] as LngLat),
    );
  }
  return cachedGuard;
}

type Feature = {
  properties?: Record<string, unknown> | null;
  geometry?: { type?: string; coordinates?: unknown } | null;
};

/**
 * One row per exit and direction that the feed says something about. Exits the
 * feed is silent on are absent, which the panel already reads as clear.
 */
export function corridorStatusFromFeed(
  fc: { features?: Feature[] } | null | undefined,
  exits: NlexExit[] = FALLBACK_EXITS,
): ExitStatus[] {
  if (!fc?.features?.length) return [];

  const guard = guardFor(exits);
  const ordered = orderedExits(exits);
  const kept = guard.filter(fc as { features?: unknown[] }) as { features?: Feature[] };

  type Acc = { level: number | null; speed: number | null; count: number; observedAt: string | null;
               meters: number | null; delay: number | null };
  const byKey = new Map<string, Acc>();

  for (const f of kept.features ?? []) {
    const p = f.properties;
    if (p?.feature_type !== "jam" || f.geometry?.type !== "LineString") continue;

    const coords = f.geometry.coordinates as number[][];
    const snapped = guard.snap(coords, p.street as string | undefined);
    if (!snapped) continue;

    /* Attributed to the nearest exit, which is how the panel is keyed. A jam
       spans a stretch, so its midpoint decides which exit owns it. */
    const mid = coords[Math.floor(coords.length / 2)];
    let nearest = ordered[0];
    let best = Infinity;
    for (const e of ordered) {
      const d = Math.hypot((e.longitude - mid[0]) * M_PER_DEG_LON, (e.latitude - mid[1]) * M_PER_DEG_LAT);
      if (d < best) {
        best = d;
        nearest = e;
      }
    }

    const key = `${nearest.exit_name}|${snapped.direction}`;
    const level = Number.isFinite(Number(p.level)) ? Number(p.level) : null;
    const speed = Number.isFinite(Number(p.speed)) ? Number(p.speed) : null;
    const at = typeof p.observed_at === "string" ? p.observed_at : null;
    const meters = Number.isFinite(Number(p.length_m)) ? Number(p.length_m) : null;
    const delay = Number.isFinite(Number(p.delay_seconds)) ? Number(p.delay_seconds) : null;

    const acc = byKey.get(key);
    if (!acc) {
      byKey.set(key, { level, speed, count: 1, observedAt: at, meters, delay });
    } else {
      // Worst level and slowest speed seen, matching the SQL this replaces.
      acc.level = acc.level == null ? level : level == null ? acc.level : Math.max(acc.level, level);
      acc.speed = acc.speed == null ? speed : speed == null ? acc.speed : Math.min(acc.speed, speed);
      acc.count += 1;
      // Worst of each, never a total — see the field comments on ExitStatus.
      acc.meters = acc.meters == null ? meters : meters == null ? acc.meters : Math.max(acc.meters, meters);
      acc.delay = acc.delay == null ? delay : delay == null ? acc.delay : Math.max(acc.delay, delay);
      if (at && (!acc.observedAt || at > acc.observedAt)) acc.observedAt = at;
    }
  }

  return [...byKey.entries()].map(([key, a]) => {
    const [exit, direction] = key.split("|");
    return {
      exit,
      direction: direction as "NB" | "SB",
      status: classify(a.level, a.speed),
      level: a.level,
      speedKmh: a.speed,
      jamCount: a.count,
      observedAt: a.observedAt,
      longestQueueMeters: a.meters,
      delaySeconds: a.delay,
    };
  });
}


/* ---------------------------------------------------------------------------
   The same congestion, keyed the way the map draws it.

   corridorStatusFromFeed above answers "how is this exit", which is how the
   Home panel is laid out. The map paints the road between exits, so it needs
   "how is this segment". Both come from the same jams, but until they came from
   the same function the two views could still colour differently for the same
   feed — one attributing a jam to its nearest exit, the other to every segment
   it spans.
   ------------------------------------------------------------------------- */

/** Level per `${segmentOrder}:${direction}`, segment 1 being Balintawak's. */
export function corridorSegmentLevels(
  fc: { features?: Feature[] } | null | undefined,
  exits: NlexExit[] = FALLBACK_EXITS,
): Map<string, number> {
  const levels = new Map<string, number>();
  if (!fc?.features?.length) return levels;

  const guard = guardFor(exits);
  const parts = partsFor(exits);
  const kept = guard.filter(fc as { features?: unknown[] }) as { features?: Feature[] };

  /* Parts share their end vertices, so each one after the first advances the
     index by its length minus one. */
  const bounds: { order: number; from: number; to: number }[] = [];
  let at = 0;
  parts.forEach((part, i) => {
    const to = at + part.length - 1;
    bounds.push({ order: i + 1, from: at, to });
    at = to;
  });

  for (const f of kept.features ?? []) {
    const p = f.properties;
    if (p?.feature_type !== "jam" || f.geometry?.type !== "LineString") continue;
    const snapped = guard.snap(f.geometry.coordinates as number[][], p.street as string | undefined);
    if (!snapped) continue;
    const level = Number(p.level ?? 0);
    for (const b of bounds) {
      if (b.to < snapped.startIndex || b.from > snapped.endIndex) continue;
      const key = `${b.order}:${snapped.direction}`;
      levels.set(key, Math.max(levels.get(key) ?? 0, level));
    }
  }
  return levels;
}

/* ---------------------------------------------------------------------------
   The corridor tally, in one place.

   The home panel counted its own chips from the rows it had already built, and
   the hero strip counted the server's /api/dashboard/corridor-status/full -
   the very endpoint the note at the top of this file says was replaced because
   it disagreed with the map. Two tallies of the same road, six inches apart on
   the same screen, and they did differ: 4/3/33 against 4/2/34.

   Both now call this. It counts exit-directions, not segments, and it skips a
   direction an exit has no ramp for: those draw as bare tarmac, and counting
   them clear would make the total disagree with the drawing.
   ------------------------------------------------------------------------- */
export type CorridorTally = { congested: number; slow: number; clear: number };

export function tallyExitStatuses(exits: NlexExit[], statuses: ExitStatus[]): CorridorTally {
  /* Case-folded and trimmed, because the two sides are not always the same
     list: a caller may hand in the live exits while the statuses were derived
     against FALLBACK_EXITS, whose names differ in case and spacing. Keying
     raw silently missed every lookup and counted the whole corridor clear. */
  const key = (name: string, dir: string) => `${name.toLowerCase().trim()}|${dir}`;
  const by = new Map<string, SegmentStatus>();
  for (const s of statuses) by.set(key(s.exit, s.direction), s.status);

  const t: CorridorTally = { congested: 0, slow: 0, clear: 0 };
  for (const x of exits) {
    for (const dir of ["NB", "SB"] as const) {
      if (accessLabel(x, dir) === "No Access") continue;
      t[by.get(key(x.exit_name, dir)) ?? "clear"] += 1;
    }
  }
  return t;
}

/** The slowest reading anywhere on the corridor, for a headline. */
export function slowestReading(statuses: ExitStatus[]): { exit: string; speedKmh: number } | null {
  let best: { exit: string; speedKmh: number } | null = null;
  for (const s of statuses) {
    if (s.speedKmh == null) continue;
    if (!best || s.speedKmh < best.speedKmh) best = { exit: s.exit, speedKmh: s.speedKmh };
  }
  return best;
}
