"use client";

import { corridorGuard, sliceCorridor, type LngLat } from "./corridor-shape";
import { FALLBACK_EXITS, type NlexExit } from "./nlex-exits";
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

  type Acc = { level: number | null; speed: number | null; count: number; observedAt: string | null };
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

    const acc = byKey.get(key);
    if (!acc) {
      byKey.set(key, { level, speed, count: 1, observedAt: at });
    } else {
      // Worst level and slowest speed seen, matching the SQL this replaces.
      acc.level = acc.level == null ? level : level == null ? acc.level : Math.max(acc.level, level);
      acc.speed = acc.speed == null ? speed : speed == null ? acc.speed : Math.min(acc.speed, speed);
      acc.count += 1;
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
