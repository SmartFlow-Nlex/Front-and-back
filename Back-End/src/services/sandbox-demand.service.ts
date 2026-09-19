import { db } from "../config/db.js";

/* ───────────────────────────────────────────────────────────────────────────
 * Demand profile for the AI Sandbox.
 *
 * The sandbox used to run at a single inflow figure derived as
 * (total volume / days / 24) x 1.6, where 1.6 was an assumed peaking factor
 * that nobody had checked. The warehouse holds the real shape: hourly volume
 * per interchange per direction, split by vehicle class, over four years. At
 * Balintawak northbound it runs from 1,226 veh/h at 03:00 to 4,892 at 19:00 —
 * a peak-to-mean ratio of 1.89, not 1.6 — and the class mix swings just as
 * hard, from 1.6% heavy vehicles at 06:00 to 12.4% at 02:00. Freight runs at
 * night and cars run at rush hour, and a simulation given one flat mix cannot
 * reproduce either.
 *
 * Serving the measured profile replaces two assumptions with observations, and
 * lets the sandbox answer the question an operator actually has: not "what
 * happens at this flow" but "at which hour does this closure cost least".
 * ------------------------------------------------------------------------ */

export type DemandHour = {
  hour: number;
  vehPerHour: number;
  /** Class shares for this hour, summing to 1. */
  mix: { 1: number; 2: number; 3: number };
};

export type DemandProfile = {
  exit: string;
  direction: string | null;
  hours: DemandHour[];
  peakHour: number;
  peakVehPerHour: number;
  meanVehPerHour: number;
  /** Observed peak-to-mean ratio, replacing the assumed 1.6. */
  peakingFactor: number;
  days: number;
  source: string;
};

/** Interchanges the sandbox can anchor demand to, busiest first. */
export async function getDemandExits() {
  if (!db) return null;
  const r = await db.query(
    `SELECT exit_canonical AS exit, direction,
            ROUND(AVG(total)::numeric, 0)::int AS avg_veh_h,
            MAX(total)::int AS peak_veh_h,
            COUNT(DISTINCT date)::int AS days
     FROM gold.fact_traffic_hourly
     WHERE total IS NOT NULL
     GROUP BY 1, 2
     HAVING COUNT(*) > 500
     ORDER BY peak_veh_h DESC`,
  );
  return { exits: r.rows, source: "gold.fact_traffic_hourly" };
}

export async function getDemandProfile(
  exit: string,
  direction?: string,
): Promise<DemandProfile | null> {
  if (!db) return null;

  /* Direction is NULL for some interchanges in this table (single-carriageway
   * plazas and the Harbor Link), so it is matched with IS NOT DISTINCT FROM
   * rather than = , which would silently return nothing for exactly those. */
  const r = await db.query(
    `SELECT hour,
            AVG(total)::float             AS veh_h,
            AVG(class_1)::float           AS c1,
            AVG(class_2)::float           AS c2,
            AVG(class_3)::float           AS c3,
            COUNT(DISTINCT date)::int     AS days
     FROM gold.fact_traffic_hourly
     WHERE exit_canonical = $1
       AND ($2::text IS NULL OR direction IS NOT DISTINCT FROM $2)
       AND total IS NOT NULL
     GROUP BY hour
     ORDER BY hour`,
    [exit, direction ?? null],
  );
  if (r.rows.length === 0) return null;

  const hours: DemandHour[] = r.rows.map((row: any) => {
    const c1 = Number(row.c1) || 0;
    const c2 = Number(row.c2) || 0;
    const c3 = Number(row.c3) || 0;
    const sum = c1 + c2 + c3;
    return {
      hour: Number(row.hour),
      vehPerHour: Math.round(Number(row.veh_h) || 0),
      // Falls back to the corridor default rather than 0/0 when an hour has
      // volume but no class split, which would otherwise hand the simulation
      // an empty fleet.
      mix: sum > 0 ? { 1: c1 / sum, 2: c2 / sum, 3: c3 / sum } : { 1: 0.781, 2: 0.13, 3: 0.089 },
    };
  });

  const vols = hours.map((h) => h.vehPerHour);
  const mean = vols.reduce((a, b) => a + b, 0) / vols.length;
  const peak = Math.max(...vols);
  const peakHour = hours[vols.indexOf(peak)].hour;

  return {
    exit,
    direction: direction ?? null,
    hours,
    peakHour,
    peakVehPerHour: peak,
    meanVehPerHour: Math.round(mean),
    peakingFactor: mean > 0 ? peak / mean : 1,
    days: Number(r.rows[0].days) || 0,
    source: "gold.fact_traffic_hourly",
  };
}

/* ───────────────────────────────────────────────────────────────────────────
 * Mainline flow, from toll transactions.
 *
 * THE BUG THIS EXISTS TO FIX
 * The sandbox anchored its inflow to the volume recorded at the NEAREST
 * interchange. That is an on-ramp figure, not a through-flow: at Balintawak
 * (km 0, the corridor's gateway) the two happen to be close, but eight
 * kilometres north at Meycauayan the plaza records 211 veh/h northbound while
 * the mainline past it carries roughly 2,900. The sandbox was simulating the
 * slip road and calling it the expressway, and it got quietly worse the
 * further along the corridor the operator looked.
 *
 * WHY THIS IS COMPUTABLE
 * gold.fact_traffic_hourly stores ONE ROW PER TOLLED TRIP, at the plaza where
 * the transaction happened — entry for the open system, exit for the closed
 * one (see Back-End/src/etl/canonical-exit.ts). So `role` is not a clean
 * entry/exit split of every movement, and an origin-destination matrix cannot
 * be recovered from it.
 *
 * What CAN be recovered is a conservation count. Every northbound entry south
 * of a point put a vehicle onto the carriageway; every northbound exit south
 * of it took one off. The difference is the flow crossing that point:
 *
 *     mainline(x) = SUM(entries at km <= x) - SUM(exits at km <= x)     [NB]
 *
 * and mirrored for southbound. This is exact wherever both sides are
 * transacted. On the southern open-system stretch exits are untolled and so
 * unrecorded, which makes the figure an UPPER BOUND there rather than an
 * equality — but the first northbound off-ramp is CDV/PH Arena at km 14.05,
 * so for anything south of that nothing has left yet and the bound is tight.
 *
 * Km-posts are not in the warehouse (silver.nlex_exit_reference carries
 * lat/long only), so this returns per-plaza volumes and the caller, which has
 * the km table, does the ordering and the cumulative sum.
 * ------------------------------------------------------------------------ */

export type PlazaFlow = {
  exit: string;
  /** veh/h joining here, by hour 0-23. */
  entriesByHour: number[];
  /** veh/h leaving here, by hour 0-23. */
  exitsByHour: number[];
};

export async function getPlazaFlows(direction: "NB" | "SB") {
  if (!db) return null;

  /* Direction handling, stated rather than buried.
   *
   * A plaza row is counted in full when its direction matches. Rows recorded
   * with no direction, or as serving both, are counted at HALF: the traffic is
   * real and on the corridor, but attributing all of it to each direction
   * would count it twice. This matters here - NLEX Harbor Link carries 58.9M
   * vehicles with no direction recorded, far more than its 128 NB / 137 SB
   * attributed rows, so discarding it would understate the mainline badly and
   * double-counting it would overstate it just as badly. */
  const r = await db.query(
    `SELECT exit_canonical AS exit,
            hour,
            SUM(CASE WHEN role = 'Entry' THEN
                  total * CASE WHEN direction = $1 THEN 1.0 ELSE 0.5 END
                ELSE 0 END)::float AS entries,
            SUM(CASE WHEN role = 'Exit' THEN
                  total * CASE WHEN direction = $1 THEN 1.0 ELSE 0.5 END
                ELSE 0 END)::float AS exits,
            COUNT(DISTINCT date)::int AS days
     FROM gold.fact_traffic_hourly
     WHERE total IS NOT NULL
       AND (direction = $1 OR direction IS NULL OR direction = 'NB/SB')
     GROUP BY 1, 2
     ORDER BY 1, 2`,
    [direction],
  );

  const byExit = new Map<string, PlazaFlow>();
  let days = 0;
  for (const row of r.rows as any[]) {
    const name = String(row.exit);
    if (!byExit.has(name)) {
      byExit.set(name, {
        exit: name,
        entriesByHour: Array(24).fill(0),
        exitsByHour: Array(24).fill(0),
      });
    }
    const f = byExit.get(name)!;
    const h = Number(row.hour);
    if (h >= 0 && h < 24) {
      // Divided by days because the SUM above is over the whole history; the
      // caller wants a typical hour, not a four-year total.
      const d = Math.max(1, Number(row.days) || 1);
      f.entriesByHour[h] = (Number(row.entries) || 0) / d;
      f.exitsByHour[h] = (Number(row.exits) || 0) / d;
      days = Math.max(days, d);
    }
  }

  return {
    direction,
    plazas: [...byExit.values()],
    days,
    source: "gold.fact_traffic_hourly (role = Entry/Exit, one row per tolled trip)",
    note:
      "Southbound open-system exits are untolled and therefore unrecorded, so a " +
      "cumulative mainline figure is an upper bound south of the closed-system " +
      "barrier rather than an equality.",
  };
}
