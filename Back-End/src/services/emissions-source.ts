/**
 * The corridor's CO2 record and its incident-delay idling model: one source for
 * the Emissions tab's Descriptive, Predictive and Prescriptive views.
 *
 * THE RECORD: gold.fact_emissions_hourly
 *   Hourly, per exit plaza (19) and direction: vehicle-km by class
 *   (gold.fact_vkm_hourly, from each trip's entry and exit; etl/trip-km.ts) x the
 *   per-class factors in nlex_emission_factors, which are EMEP/EEA Guidebook 2023
 *   (196 / 689 / 798 g CO2 per km for classes 1/2/3, with a low and high for each).
 *   It is a model: no CO2 is metered on NLEX. Checked against what the operator
 *   publishes, closed-system vehicle-km come to 79% of PhilRatings' first half of
 *   2024, so read the totals as more likely under than over. The CO2 forecast is
 *   trained on this same table, and every hourly toll upload rebuilds it for the
 *   days it covers, so the three views agree and move together.
 *
 *   Not nlex_theoretical_emissions: it covers 10 of the 20 exits and holds two
 *   rows for almost every (exit, hour, direction, class) — 1,420 of 1,430 keys
 *   on a sampled day — so summing it counted the corridor's CO2 about twice.
 *   It stays in the warehouse as the modelled-emissions upload's table.
 *
 *   Directions: 29.5% of 2025's CO2 sits at plazas the record does not split by
 *   direction (Angeles and Mexico as "NB/SB"; Balagtas, Harbor Link and
 *   Sta. Ines with none). It is reported as its own share, never dropped and
 *   never guessed into one carriageway.
 *
 * DELAY-INDUCED CARBON
 *   The factors carry no speed term, so congestion does not change a moving
 *   vehicle's emissions in this model. What a delay does add is idling: a queue
 *   builds behind an incident while it is live and drains as it clears, so the
 *   vehicle-minutes lost are the area of that triangle, lambda x T^2 / 2
 *   (lambda = vehicles per minute on the blocked segment, T = clearance
 *   minutes). Quadratic in T, so the long incidents carry almost all of it.
 */
import { db } from "../config/db.js";

export const EMISSIONS_TABLE = "gold.fact_emissions_hourly";

/* Fuel burned at a standstill, US gal per hour, by class. Class 1 and Class 3: "Idling a car wastes about 0.3 gal/h and
   a big truck about 1 gal/h. Each gallon of fuel burned emits about 20 lbs. of carbon dioxide" (Gaines, Levinson &
   McConnell, Argonne National Laboratory, 2010, To Idle or Not To Idle). Class 2: 0.8 gal/h, the heavy-duty figure in
   Argonne's Long-Haul Truck Idling Burns Up Profits (2015); no source separates buses and small trucks. */
const IDLE_GAL_PER_HOUR = [0.3, 0.8, 1] as const;
const KG_CO2_PER_GAL = 20 * 0.45359237;
/** kg CO2 per vehicle-minute at a standstill, by class. */
export const IDLING_KG_PER_MINUTE = IDLE_GAL_PER_HOUR.map((g) => (g * KG_CO2_PER_GAL) / 60);
export const IDLING_SOURCE =
  "Argonne National Laboratory: about 0.3 gal/h for a car, 1 for a big truck, 20 lb CO2 per gallon (2010); 0.8 gal/h for Class 2 (2015).";

/** The vehicles on one segment in one direction in an hour, and what one of them burns per minute of idling at that hour's class mix. */
export type Exposure = { veh: number; kgPerMinute: number };

/** Idling CO2 (kg) of one incident of `minutes` on a segment with this exposure. */
export const idleKg = (x: Exposure | undefined, minutes: number) =>
  x ? ((x.veh / 60) * minutes * minutes) / 2 * x.kgPerMinute : 0;

/** The record's first and last day. */
export async function recordBounds(): Promise<{ minDate: string; maxDate: string }> {
  const { rows } = await db!.query(`SELECT min(date)::text AS lo, max(date)::text AS hi FROM ${EMISSIONS_TABLE}`);
  return { minDate: rows[0].lo, maxDate: rows[0].hi };
}

/**
 * Vehicles per hour on ONE exit-segment in ONE direction, by hour of day, over
 * [lo, hi]. An incident blocks one segment of one carriageway, so this is its
 * exposure — the corridor total would trap more vehicles than use the whole
 * corridor in half a day. Divided by the exits and days in the data, and by
 * two carriageways.
 */
export async function exposureByHour(lo: string, hi: string): Promise<Map<number, Exposure>> {
  const { rows } = await db!.query(
    `SELECT hour::int AS hr,
            SUM(total)::float / NULLIF(COUNT(DISTINCT date), 0) / NULLIF(COUNT(DISTINCT exit_canonical), 0) / 2 AS veh,
            (SUM(class_1) * $3 + SUM(class_2) * $4 + SUM(class_3) * $5)::float / NULLIF(SUM(total), 0) AS rate
       FROM ${EMISSIONS_TABLE} WHERE date BETWEEN $1 AND $2 GROUP BY 1`,
    [lo, hi, ...IDLING_KG_PER_MINUTE],
  );
  return new Map(rows.map((r: { hr: number; veh: number | null; rate: number | null }) => [Number(r.hr), { veh: Number(r.veh ?? 0), kgPerMinute: Number(r.rate ?? 0) }]));
}

export type ClearedIncident = {
  day: string;
  hr: number;
  /** Minutes a LANE was blocked (see clearedIncidents): the time traffic queued behind it. */
  minutes: number;
  band: "under15" | "to60" | "to180" | "over180";
  /** "NB", "SB", "EB" or "WB" where recorded, and the km post it happened at; null where the record has none. */
  direction: string | null;
  km: number | null;
};

/**
 * Accidents in [lo, hi] that blocked a lane: the hour each started and how long the lane stayed blocked.
 *
 * The queue behind an incident lasts as long as the BLOCKAGE does (blockage_cleared - event_start_date), not as
 * long as the site takes to clear. This used clearance_min until 2026-10-11, which is the time to SITE cleared:
 * a vehicle down an embankment that never touched a lane, recovered twenty-two hours later, was counted as
 * twenty-two hours of queueing, squared. Measured on 2025: of the 61 incidents over three hours by clearance_min,
 * 18 had no blockage at all, and the sum of T squared (what the idling model is driven by) on blockage time is
 * 29.6% of what it was on clearance time. Delay-induced carbon and both incident strategies were therefore
 * about three times too large. An incident with no blockage (recorded as cleared the minute it began) queues
 * nobody and is left out; one recorded as cleared before it began is a data error and is left out too.
 */
export async function clearedIncidents(lo: string, hi: string): Promise<ClearedIncident[]> {
  const { rows } = await db!.query(
    `SELECT event_start_date::date::text AS day, EXTRACT(hour FROM event_start_date)::int AS hr,
            (EXTRACT(EPOCH FROM (blockage_cleared - event_start_date)) / 60)::float AS minutes,
            direction, km_value::float AS km
       FROM silver.nlex_accident_events_clean
      WHERE blockage_cleared IS NOT NULL AND blockage_cleared > event_start_date
        AND blockage_cleared - event_start_date <= interval '24 hours'
        AND event_start_date::date BETWEEN $1 AND $2`,
    [lo, hi],
  );
  return rows.map((r: { day: string; hr: number; minutes: number; direction: string | null; km: number | null }) => ({
    day: r.day,
    hr: Number(r.hr),
    minutes: Number(r.minutes),
    band: r.minutes < 15 ? "under15" : r.minutes < 60 ? "to60" : r.minutes < 180 ? "to180" : "over180",
    direction: ["NB", "SB", "EB", "WB"].includes(r.direction ?? "") ? r.direction : null,
    km: r.km == null ? null : Number(r.km),
  }));
}

/** Delay-induced carbon over [lo, hi]: the idling CO2 of every accident that blocked a lane, each for as long as it blocked it. */
export async function delayCarbon(lo: string, hi: string) {
  const [exposure, incidents] = await Promise.all([exposureByHour(lo, hi), clearedIncidents(lo, hi)]);
  const kg = incidents.reduce((s, e) => s + idleKg(exposure.get(e.hr), e.minutes), 0);
  const long = incidents.filter((e) => e.minutes >= 180);
  const longKg = long.reduce((s, e) => s + idleKg(exposure.get(e.hr), e.minutes), 0);
  return {
    tonnes: kg / 1000,
    incidents: incidents.length,
    /** Share of it from incidents that blocked a lane for three hours or more: the tail, because the cost is quadratic. */
    longIncidents: long.length,
    longSharePct: kg > 0 ? (longKg / kg) * 100 : 0,
  };
}
