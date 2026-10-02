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
  /** "paid": open-system entry transactions. "ticket": closed-system trips,
   *  counted at the plaza where they took their ticket. "none": no record. */
  entriesSource: "paid" | "ticket" | "none";
  /** "paid": closed-system exit transactions. "estimated": an open-system exit,
   *  which is free and so never recorded — see estimateOpenExits. "none". */
  exitsSource: "paid" | "estimated" | "none";
};

type Hours = number[];
type Dir = "NB" | "SB";
const zeros = (): Hours => Array(24).fill(0);
const sumOf = (a: Hours) => a.reduce((t, v) => t + v, 0);
const other = (d: Dir): Dir => (d === "NB" ? "SB" : "NB");

/* Plazas on the expressways that join NLEX at the SCTEX junction. Their trips
 * reach NLEX there, so that is where they are counted as joining it. */
const VIA_SCTEX = /\((SCTEX|TPLEX)\)|^SFEX\b|^SCTEX$/i;
/** Closed-system trips with no ticket: where they started is unknown. */
const NO_ORIGIN = /^no ticket$/i;

/* Both tables are read once and kept for a while: the history only grows
 * nightly, and every sandbox carriageway asks for it on load. */
const PLAZA_FLOW_TTL_MS = 10 * 60 * 1000;
let plazaFlowCache: { at: number; byDir: Record<Dir, PlazaFlow[]>; days: number } | null = null;
let plazaFlowBuilding: Promise<{ at: number; byDir: Record<Dir, PlazaFlow[]>; days: number }> | null = null;

async function hourlyBy(sql: string, d: Dir): Promise<Map<string, { a: Hours; b: Hours; days: number }>> {
  const r = await db!.query(sql, [d]);
  const out = new Map<string, { a: Hours; b: Hours; days: number }>();
  for (const row of r.rows as any[]) {
    const name = String(row.plaza);
    const g = out.get(name) ?? { a: zeros(), b: zeros(), days: 0 };
    out.set(name, g);
    const h = Number(row.hour);
    if (!(h >= 0 && h < 24)) continue;
    // Divided by days because the SUM is over the whole history; the caller
    // wants a typical hour, not a four-year total.
    const days = Math.max(1, Number(row.days) || 1);
    g.a[h] += (Number(row.a) || 0) / days;
    g.b[h] += (Number(row.b) || 0) / days;
    g.days = Math.max(g.days, days);
  }
  return out;
}

export async function getPlazaFlows(direction: Dir) {
  if (!db) return null;
  if (!plazaFlowCache || Date.now() - plazaFlowCache.at > PLAZA_FLOW_TTL_MS) {
    // One build at a time: the two carriageways ask together on every sandbox
    // load, and each starting its own five full-table reads held a share of the
    // pool every other page was waiting on.
    plazaFlowBuilding ??= buildPlazaFlows().finally(() => { plazaFlowBuilding = null; });
    plazaFlowCache = await plazaFlowBuilding;
  }
  return {
    direction,
    plazas: plazaFlowCache.byDir[direction],
    days: plazaFlowCache.days,
    source:
      "gold.fact_traffic_hourly (one row per tolled trip, at the plaza where it paid) and " +
      "gold.fact_traffic_hourly_origin (the same trips, at the plaza where they started)",
    note:
      "Entries are paid entries in the open system and ticketed starts in the closed one; exits are paid " +
      "exits in the closed system. Open-system exits are free and never recorded: those are ESTIMATED " +
      "(entriesSource / exitsSource say which figure is which).",
  };
}

async function buildPlazaFlows(): Promise<{ at: number; byDir: Record<Dir, PlazaFlow[]>; days: number }> {
  /* Direction handling, stated rather than buried.
   *
   * A plaza row is counted in full when its direction matches. Rows recorded
   * with no direction, or as serving both, are counted at HALF: the traffic is
   * real and on the corridor, but attributing all of it to each direction
   * would count it twice. This matters here - NLEX Harbor Link carries 58.9M
   * vehicles with no direction recorded, far more than its 128 NB / 137 SB
   * attributed rows, so discarding it would understate the mainline badly and
   * double-counting it would overstate it just as badly. */
  const weight = "CASE WHEN direction = $1 THEN 1.0 ELSE 0.5 END";
  const inDir = "(direction = $1 OR direction IS NULL OR direction = 'NB/SB')";
  const paidSql = `
    SELECT exit_canonical AS plaza, hour,
           SUM(CASE WHEN role = 'Entry' THEN total * ${weight} ELSE 0 END)::float AS a,
           SUM(CASE WHEN role = 'Exit'  THEN total * ${weight} ELSE 0 END)::float AS b,
           COUNT(DISTINCT date)::int AS days
      FROM gold.fact_traffic_hourly
     WHERE total IS NOT NULL AND ${inDir}
     GROUP BY 1, 2`;
  /* WHO JOINED WHERE.
   *
   * fact_traffic_hourly keeps each trip where it PAID: on entry in the open
   * system (Balintawak to Bocaue), on exit in the closed one. Read alone, every
   * closed-system plaza had no entries at all — San Fernando southbound, 952
   * veh/h joining at its busiest hour, showed none — and the sandbox drew its
   * entry plaza with nobody coming through it. fact_traffic_hourly_origin keeps
   * the same trips at the plaza where they STARTED (their ticket's origin), so
   * those entries are recorded after all.
   *
   * It is not used where a plaza takes payment on entry: a northbound car
   * paying at Meycauayan and again at a closed-system exit is two trips there,
   * one car, and the paid entry already counts it once. */
  const originSql = `
    SELECT entry_canonical AS plaza, hour,
           SUM(total * ${weight})::float AS a,
           0::float AS b,
           COUNT(DISTINCT date)::int AS days
      FROM gold.fact_traffic_hourly_origin
     WHERE total IS NOT NULL AND ${inDir}
     GROUP BY 1, 2`;
  const openRows = await db!.query(
    `SELECT DISTINCT exit_canonical AS plaza FROM gold.fact_traffic_hourly WHERE role = 'Entry' AND toll_system = 'OS'`,
  );
  const openSystem = new Set((openRows.rows as any[]).map((r) => String(r.plaza)));

  const paid = { NB: await hourlyBy(paidSql, "NB"), SB: await hourlyBy(paidSql, "SB") };
  const origin = { NB: await hourlyBy(originSql, "NB"), SB: await hourlyBy(originSql, "SB") };

  const entries: Record<Dir, Map<string, { h: Hours; src: PlazaFlow["entriesSource"] }>> = { NB: new Map(), SB: new Map() };
  const exits: Record<Dir, Map<string, { h: Hours; src: PlazaFlow["exitsSource"] }>> = { NB: new Map(), SB: new Map() };
  let days = 0;
  for (const d of ["NB", "SB"] as Dir[]) {
    for (const [name, g] of paid[d]) {
      days = Math.max(days, g.days);
      if (sumOf(g.a) > 0) entries[d].set(name, { h: g.a, src: "paid" });
      if (sumOf(g.b) > 0) exits[d].set(name, { h: g.b, src: "paid" });
    }
    for (const [raw, g] of origin[d]) {
      if (NO_ORIGIN.test(raw) || sumOf(g.a) <= 0) continue;
      const name = VIA_SCTEX.test(raw) ? "SCTEX" : raw;
      const have = entries[d].get(name);
      if (have?.src === "paid") continue;
      const h = have ? have.h.map((v, i) => v + g.a[i]) : g.a.slice();
      entries[d].set(name, { h, src: "ticket" });
    }
  }
  estimateOpenExits(entries, exits, openSystem);

  const byDir = { NB: [] as PlazaFlow[], SB: [] as PlazaFlow[] };
  for (const d of ["NB", "SB"] as Dir[]) {
    const names = new Set([...entries[d].keys(), ...exits[d].keys()]);
    for (const name of names) {
      const e = entries[d].get(name);
      const x = exits[d].get(name);
      byDir[d].push({
        exit: name,
        entriesByHour: e?.h ?? zeros(),
        exitsByHour: x?.h ?? zeros(),
        entriesSource: e?.src ?? "none",
        exitsSource: x?.src ?? "none",
      });
    }
    byDir[d].sort((p, q) => p.exit.localeCompare(q.exit));
  }
  return { at: Date.now(), byDir, days };
}

/* OPEN-SYSTEM EXITS, ESTIMATED.
 *
 * Between Balintawak and Bocaue the toll is paid on the way IN, and leaving is
 * free, so no exit there is ever recorded: Meycauayan had 841 veh/h joining
 * southbound at its busiest hour and, as far as the record goes, nobody ever
 * leaving. The sandbox took that literally.
 *
 * The estimate is the round trip, the standard assumption when only one end of
 * a journey is counted: over a day, as many people leave the expressway at a
 * plaza heading one way as join it there heading the other — the people who
 * drive south to Manila in the morning drive north and get off here in the
 * evening. So the day's exits northbound at a plaza are the day's entries
 * southbound there, and the other way round, spread over the hours at which
 * exits happen everywhere else in that direction (the paid closed-system ones).
 * Checked against the tickets: northbound, the open system's paid entries less
 * the trips that carry on into the closed one leave about 65,000 exits a day to
 * find; the round trip gives about 55,000.
 *
 * Never at a barrier: what the record calls its exits are the fares of traffic
 * passing straight through, not cars leaving. */
function estimateOpenExits(
  entries: Record<Dir, Map<string, { h: Hours; src: PlazaFlow["entriesSource"] }>>,
  exits: Record<Dir, Map<string, { h: Hours; src: PlazaFlow["exitsSource"] }>>,
  openSystem: ReadonlySet<string>,
): void {
  for (const d of ["NB", "SB"] as Dir[]) {
    const shape = zeros();
    for (const [name, x] of exits[d]) {
      if (x.src === "paid" && !/barrier/i.test(name)) x.h.forEach((v, i) => (shape[i] += v));
    }
    const total = sumOf(shape);
    if (total <= 0) continue;
    for (const name of openSystem) {
      if (/barrier/i.test(name) || exits[d].has(name)) continue;
      const day = sumOf(entries[other(d)].get(name)?.h ?? []);
      if (day <= 0) continue;
      exits[d].set(name, { h: shape.map((v) => (day * v) / total), src: "estimated" });
    }
  }
}
