import { db } from "../config/db.js";

/* ───────────────────────────────────────────────────────────────────────────
 * Where a scenario event belongs, according to the record.
 *
 * The sandbox lets an operator drop a breakdown or a collision anywhere. That
 * is right for "what if it happened here", and wrong as a default: the first
 * question is usually "what happens when it happens where it USUALLY happens",
 * and the corridor's own incident log answers that.
 *
 * Both logs locate every event two ways, and both are used:
 *   - km_value, on the same km-post scale as the exit list and the sandbox
 *     (Balintawak at Km 12) — for events on the carriageway, binned into
 *     100 m stretches;
 *   - location / sub_location — "Carriageway" with the lane ("Lane1".."Lane4",
 *     "E-Lane" for the shoulder), or "Toll Plaza" / "Interchange" / "TSF"
 *     (toll service facility: a service area) with the facility's name.
 * So a hotspot can be a stretch of a lane, or a named plaza or service area,
 * and the sandbox can put the event in the booth lane rather than near it.
 *
 * Counts are over everything recorded (2022-01 to the last loaded day), for
 * one carriageway, filtered to the kind of event being placed.
 * ------------------------------------------------------------------------ */

export type HotspotFamily =
  | "breakdown_in_lane"
  | "breakdown_shoulder"
  | "minor_collision"
  | "multi_vehicle_collision"
  | "self_accident"
  | "overturned_vehicle";

/* The record's own event types, grouped to the sandbox's families. Overturns
 * are not a type in the log; a self-accident is the nearest kind of event and
 * the only honest stand-in — the response says so. */
const ACCIDENT_TYPES: Record<Exclude<HotspotFamily, "breakdown_in_lane" | "breakdown_shoulder">, string[]> = {
  minor_collision: ["Rear End", "Side Swipe", "Hit and Run", "Angle Collision"],
  multi_vehicle_collision: ["Multiple Collision"],
  self_accident: ["Self Accident", "Hit Toll Plaza Equipment", "Hit Objects On The Road"],
  overturned_vehicle: ["Self Accident"],
};
/** Where a breakdown is recorded as being: in a running lane, or off it. */
const BREAKDOWN_PLACE: Record<"breakdown_in_lane" | "breakdown_shoulder", string> = {
  breakdown_in_lane: "^Lane[1-4]$",
  breakdown_shoulder: "^(E-Lane|Soft Shoulder|E-Parking)$",
};

export type Hotspots = {
  family: HotspotFamily;
  direction: "NB" | "SB";
  fromKm: number;
  toKm: number;
  /** Events of this kind on the carriageway inside the window. */
  inWindow: number;
  /** The busiest 100 m stretches in the window, with the lane most of them were in. */
  stretches: { fromKm: number; toKm: number; count: number; lane: number | null; laneShare: number | null }[];
  /** Named facilities on this carriageway, corridor-wide: plazas, interchanges, service areas. */
  facilities: { place: "Toll Plaza" | "Interchange" | "TSF"; name: string; count: number }[];
  period: { from: string; to: string } | null;
  source: string;
  note: string | null;
};

const cache = new Map<string, { at: number; data: Hotspots }>();
const CACHE_MS = 5 * 60 * 1000;

export async function getHotspots(
  family: HotspotFamily,
  direction: "NB" | "SB",
  fromKm: number,
  toKm: number,
): Promise<Hotspots | null> {
  if (!db) return null;
  const key = `${family}|${direction}|${fromKm.toFixed(3)}|${toKm.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const isBreakdown = family === "breakdown_in_lane" || family === "breakdown_shoulder";
  const table = isBreakdown ? "silver.nlex_breakdown_events_clean" : "silver.nlex_accident_events_clean";
  const dateCol = isBreakdown ? "event_encoded_date" : "event_start_date";
  // The kind of event, as a SQL condition with its parameter.
  const kindSql = isBreakdown ? "sub_location ~ $4" : "type_of_event = ANY($4::text[])";
  const kindParam = isBreakdown ? BREAKDOWN_PLACE[family] : ACCIDENT_TYPES[family];
  // At a facility a breakdown is recorded by the facility's name, not a lane, so it is not filtered by place.
  const facilityKindSql = isBreakdown ? "TRUE" : "type_of_event = ANY($2::text[])";

  const [win, stretches, lanes, facilities, period] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS n FROM ${table}
       WHERE direction = $1 AND location = 'Carriageway' AND km_value >= $2 AND km_value < $3 AND ${kindSql}`,
      [direction, fromKm, toKm, kindParam],
    ),
    db.query(
      `SELECT (floor(km_value * 10) / 10)::float AS bin, COUNT(*)::int AS n FROM ${table}
       WHERE direction = $1 AND location = 'Carriageway' AND km_value >= $2 AND km_value < $3 AND ${kindSql}
       GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 5`,
      [direction, fromKm, toKm, kindParam],
    ),
    db.query(
      `SELECT (floor(km_value * 10) / 10)::float AS bin, substring(sub_location from 5)::int AS lane, COUNT(*)::int AS n
       FROM ${table}
       WHERE direction = $1 AND location = 'Carriageway' AND km_value >= $2 AND km_value < $3 AND ${kindSql}
         AND sub_location ~ '^Lane[1-4]$'
       GROUP BY 1, 2`,
      [direction, fromKm, toKm, kindParam],
    ),
    db.query(
      `SELECT location AS place, sub_location AS name, COUNT(*)::int AS n FROM ${table}
       WHERE direction = $1 AND location IN ('Toll Plaza', 'Interchange', 'TSF') AND sub_location IS NOT NULL AND ${facilityKindSql}
       GROUP BY 1, 2 ORDER BY 3 DESC`,
      isBreakdown ? [direction] : [direction, kindParam],
    ),
    db.query(`SELECT min(${dateCol})::date::text AS lo, max(${dateCol})::date::text AS hi FROM ${table}`),
  ]);

  const byBin = new Map<number, { lane: number; n: number }[]>();
  for (const r of lanes.rows as any[]) {
    const b = Number(r.bin);
    const arr = byBin.get(b) ?? [];
    arr.push({ lane: Number(r.lane), n: Number(r.n) });
    byBin.set(b, arr);
  }

  const data: Hotspots = {
    family,
    direction,
    fromKm,
    toKm,
    inWindow: Number(win.rows[0]?.n ?? 0),
    stretches: (stretches.rows as any[]).map((r) => {
      const b = Number(r.bin);
      const ls = byBin.get(b) ?? [];
      const total = ls.reduce((s, x) => s + x.n, 0);
      const top = ls.sort((x, y) => y.n - x.n)[0] ?? null;
      return {
        fromKm: Math.round(b * 10) / 10,
        toKm: Math.round((b + 0.1) * 10) / 10,
        count: Number(r.n),
        lane: top ? top.lane : null,
        laneShare: top && total > 0 ? top.n / total : null,
      };
    }),
    facilities: (facilities.rows as any[]).map((r) => ({ place: r.place, name: String(r.name), count: Number(r.n) })),
    period: period.rows[0]?.lo ? { from: String(period.rows[0].lo), to: String(period.rows[0].hi) } : null,
    source: isBreakdown
      ? `silver.nlex_breakdown_events_clean, ${family === "breakdown_in_lane" ? "breakdowns recorded in a running lane" : "breakdowns recorded on the shoulder or emergency lane"}`
      : `silver.nlex_accident_events_clean, type_of_event in (${ACCIDENT_TYPES[family].join(", ")})`,
    note: family === "overturned_vehicle" ? "The record has no overturn type; self-accidents are used as the nearest kind of event." : null,
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}
