import { db } from "../config/db.js";
import { getMLPredictiveCongestion } from "./traffic.service.js";
import {
  OSM_TOLL_PLAZAS, OSM_TOLL_PLAZAS_AWAY, OSM_TOLL_PLAZAS_READ, type OsmTollPlaza,
} from "../data/nlex-toll-plazas.js";

/* ══════════════════════════════════════════════════════════════════════════════
   PRESCRIPTIVE TRAFFIC — booth staffing and congestion response

   The two models already existed, but they ran in the browser
   (prescriptiveTraffic.shared.ts) on props the descriptive tab happened to
   have loaded. That had three costs: the recommendation depended on which
   range the operator had selected elsewhere on the page, nothing else could
   ask for it, and the staffing plan only ever covered each plaza's single
   busiest hour — so it could not answer "how many booths at 10am".

   Both now run here, against the warehouse.

   BOOTH STAFFING

     demand(plaza, hour, day) = corridorForecast(day)
                              x plazaShare(plaza)
                              x hourShare(plaza, hour, weekday|weekend)

   Every factor except booth throughput is MEASURED:
     corridorForecast   gold.ml_predictive_volume, the champion's future rows
     plazaShare         gold.fact_traffic_hourly, that plaza's share of corridor
     hourShare          the same table, that plaza's own profile across the day

   Throughput is the one thing the warehouse does not hold and the operator
   does, so it stays a parameter rather than being invented here.

   The profiles are split weekday/weekend because they are genuinely different
   shapes, and because a staffing plan that ignores that is wrong two days in
   seven. They are also per plaza: Bocaue Barrier peaks at 07:00 and Balintawak
   at 19:00, so a single corridor-wide peak hour would over-staff one and
   under-staff the other at every hour of the day.

   THE ALLOCATION

   Given a finite pool of booth-hours, which plaza-hours get them? Stated as a
   linear program:

     minimise    sum over (p,h) of unmet(p,h)
     subject to  unmet(p,h) >= demand(p,h) - staffed(p,h) x throughput
                 unmet(p,h) >= 0
                 sum staffed(p,h) <= pool
                 staffed(p,h) <= need(p,h)

   Each booth retires exactly `throughput` vehicles of unmet demand until that
   cell reaches zero, so the constraint matrix is an interval matrix and the
   greedy assignment — next booth to whichever cell still has the most unmet —
   attains the LP optimum exactly. No simplex library, and not an
   approximation either.

   BOOTHS THAT EXIST

   need = ceil(demand / throughput) had no ceiling: at 50 vehicles a booth-hour
   it planned 98 booths at Balintawak, which has 25. A plan nobody can carry
   out is not a plan. So each plaza is capped at the booth lanes OpenStreetMap
   maps for the movement that takes its payments (data/nlex-toll-plazas.ts):
   its exit booths where the warehouse records exits, its entry booths where
   it records paid entries, its barrier where it stands on the carriageway.
   Per carriageway wherever both the warehouse and the map say which, because
   a northbound booth cannot serve a southbound car; pooled where either
   cannot tell. The cap enters the program above as one more bound,

                 staffed(p,h) <= booths(p)

   which leaves the greedy exact. Demand beyond what every booth clears is
   reported as UNSERVED: it queues however the plaza is staffed, so it calls
   for diversion or an advisory, and the answer says that instead of asking
   for booths that are not there.

   CONGESTION RESPONSE

   A Mamdani controller over "how likely" and "how soon". Crisp thresholds are
   the wrong tool: 0.61 and 0.59 describe the same road, and an alert that
   fires at one and not the other is how operators learn to ignore alerts.
   Triangular memberships overlap, so a segment near a boundary reads as near
   a boundary instead of flipping.
══════════════════════════════════════════════════════════════════════════════ */

/** What one booth clears in an hour. The operator's number, not the warehouse's. */
const DEFAULT_THROUGHPUT = 350;
/** How many future days the week-ahead view covers. */
const WEEK_DAYS = 7;

const MODEL_COLUMN: Record<string, string> = {
  Prophet: "pred_prophet",
  Prophet_nw: "pred_prophet_nw",
  LSTM: "pred_lstm",
  LSTM_nw: "pred_lstm_nw",
  XGBoost: "pred_xgboost",
  HoltWinters: "pred_holtwinters",
  SARIMAX: "pred_sarimax",
  SARIMAX_nw: "pred_sarimax_nw",
  Holts_Linear: "pred_holts_linear",
  HoltsLinear: "pred_holts_linear",
};

export type BoothHour = {
  hour: number;
  /** Vehicles expected at this plaza in this hour. */
  demand: number;
  /** Booths that would clear them all, whether or not the plaza has that many. */
  need: number;
  /** Booths to open: need, limited by the booths the plaza has and, when one
   *  is given, by the pool. */
  staffed: number;
  /** Vehicles left queuing after `staffed` booths. */
  unmet: number;
};

export type BoothPlazaDay = {
  plaza: string;
  sharePct: number;
  peakHour: number;
  /** Booths that would clear the peak hour. */
  peakNeed: number;
  /** Booths to open at the peak hour: peakNeed, limited to what the plaza has. */
  peakStaffed: number;
  /** Booth lanes the plaza has for the movement that pays there. Null where
   *  OpenStreetMap maps none: then nothing is capped. */
  booths: number | null;
  /** Which booths those are, e.g. "NB exit 3 + SB exit 3". */
  boothBasis: string;
  /** What a typical day of the same type needs at that hour, for comparison. */
  typicalPeakNeed: number;
  /** ...and what it can open there. */
  typicalPeakStaffed: number;
  /** Vehicles over the day that the staffed booths leave queuing. */
  unmetVehicles: number;
  /** The hour that leaves the most; null when none leaves any. */
  worstUnmet: {
    hour: number;
    vehicles: number;
    need: number;
    staffed: number;
    /** Which booths leave it ("SB exit"). A plaza can have booths to spare on
     *  one carriageway while the other is full. */
    where: string | null;
  } | null;
  hours: BoothHour[];
};

export type BoothDay = {
  date: string;
  dayType: "weekday" | "weekend";
  corridorForecast: number;
  /** Booths to open across the corridor, each plaza at its own peak. */
  totalPeakBooths: number;
  /** Vehicles the staffed booths cannot clear that day, corridor-wide. */
  unmetVehicles: number;
  plazas: BoothPlazaDay[];
};

/** A plaza-day whose demand outruns every booth of one of its booth sets. */
export type OverCapacity = {
  date: string;
  plaza: string;
  /** Which booths: "NB exit", "SB barrier", "entry, both directions". */
  where: string;
  /** The hour that leaves the most queuing that day. */
  hour: number;
  /** Vehicles an hour that queue with every one of those booths open. */
  vehicles: number;
  /** Booths that hour would need, and booths there are. */
  need: number;
  booths: number;
};

export type CongestionAdvice = {
  segment: string;
  km: number | null;
  /** Probability of HIGH congestion. A "low" forecast row is reported as its
   *  complement, so this always reads the same way round. */
  probability: number;
  hoursAhead: number;
  urgency: number;
  label: "Monitor" | "Prepare" | "Act";
  action: string;
};

export type TrafficPrescriptive = {
  champion: { model: string | null; wmapePct: number | null; accepted: boolean };
  assumptions: string[];
  basis: {
    profileFrom: string | null;
    profileTo: string | null;
    plazasProfiled: number;
    forecastFrom: string | null;
    forecastTo: string | null;
    throughputPerBoothHour: number;
    poolBoothHours: number | null;
    /** Where the booth counts come from. */
    boothsFrom: string;
    /** Plazas with traffic but no booths mapped, so not capped. */
    plazasWithoutBooths: string[];
  };
  /** Hour by hour for the first forecast day: the shift plan. */
  shiftPlan: BoothDay | null;
  /** Peak hour only, for the week ahead. */
  week: BoothDay[];
  /** Every plaza-day in the week whose demand outruns all its booths, worst first. */
  overCapacity: OverCapacity[];
  congestion: CongestionAdvice[];
  /** Segments on the exit list with no congestion forecast at all. They are
   *  named, not dropped: an empty row and a quiet road look the same. */
  congestionMissing: string[];
};

/* ── fuzzy controller ─────────────────────────────────────────────────────── */

const tri = (x: number, a: number, b: number, c: number): number => {
  if (x <= a || x >= c) return 0;
  if (x === b) return 1;
  return x < b ? (x - a) / (b - a) : (c - x) / (c - b);
};

/* Ported verbatim from prescriptiveTraffic.shared.ts, memberships, rule base
 * and defuzzification alike.
 *
 * My first attempt at moving this rewrote it — different horizon memberships
 * and three collapsed rules instead of nine — which would have quietly changed
 * every advisory the panel has ever given while the commit claimed only to
 * have moved it server-side. Moving a model and retuning it are separate
 * changes and must not be made in the same breath. */
function fuzzyUrgency(probability: number, hoursAhead: number): { score: number; label: CongestionAdvice["label"] } {
  // Likelihood memberships
  const pLow = tri(probability, -1, 0.15, 0.5);
  const pMed = tri(probability, 0.3, 0.55, 0.8);
  const pHigh = tri(probability, 0.6, 0.9, 2);

  // Proximity memberships, over a 12-hour horizon
  const tSoon = tri(hoursAhead, -6, 1, 5);
  const tMid = tri(hoursAhead, 2, 6, 10);
  const tFar = tri(hoursAhead, 7, 12, 18);

  // Rule base. Consequent singletons on a 0..1 urgency axis; the closer and
  // the likelier, the higher.
  const rules: [number, number][] = [
    [Math.min(pHigh, tSoon), 1.0],
    [Math.min(pHigh, tMid), 0.8],
    [Math.min(pHigh, tFar), 0.6],
    [Math.min(pMed, tSoon), 0.65],
    [Math.min(pMed, tMid), 0.45],
    [Math.min(pMed, tFar), 0.3],
    [Math.min(pLow, tSoon), 0.2],
    [Math.min(pLow, tMid), 0.1],
    [Math.min(pLow, tFar), 0.05],
  ];

  // Centroid defuzzification over the firing strengths.
  let numr = 0;
  let den = 0;
  for (const [w, v] of rules) {
    numr += w * v;
    den += w;
  }
  const score = den > 0 ? numr / den : 0;
  const label: CongestionAdvice["label"] = score >= 0.7 ? "Act" : score >= 0.4 ? "Prepare" : "Monitor";
  return { score, label };
}

const ACTION: Record<CongestionAdvice["label"], string> = {
  Act: "Deploy counter-flow and post VMS advisories before the first High hour.",
  Prepare: "Stage units nearby; hold the advisory until probability firms up.",
  Monitor: "No action; re-check next cycle.",
};

/* ── booths per plaza ─────────────────────────────────────────────────────── */

type Dir = "NB" | "SB";
/** A warehouse direction: one carriageway, or not said ("NB/SB", or none). */
type Side = Dir | "both";

/** One plaza's recorded volume for one movement, side, hour and day type,
 *  summed over the history. */
type ProfileRow = { plaza: string; role: string; side: Side; hour: number; weekend: boolean; v: number };

/** One set of booths at a plaza, and the recorded payments that go through it. */
type BoothGroup = {
  /** "SB exit"; just "entry" where one pool serves both carriageways. */
  label: string;
  pooled: boolean;
  /** Booth lanes; null where none are mapped. */
  booths: number | null;
  /** Volume by [weekday, weekend][hour], summed over the history. */
  v: [number[], number[]];
};

type PlazaBooths = {
  plaza: string;
  groups: BoothGroup[];
  /** All its booths; null when any group has none mapped. */
  booths: number | null;
  basis: string;
};

const MAPPED: OsmTollPlaza[] = [...OSM_TOLL_PLAZAS, ...OSM_TOLL_PLAZAS_AWAY];

const sideOf = (direction: string | null): Side =>
  direction === "NB" || direction === "SB" ? direction : "both";

function volumes(rows: ProfileRow[]): [number[], number[]] {
  const v: [number[], number[]] = [new Array(24).fill(0), new Array(24).fill(0)];
  for (const r of rows) if (r.hour >= 0 && r.hour < 24) v[r.weekend ? 1 : 0][r.hour] += r.v;
  return v;
}

const laneSum = (ms: OsmTollPlaza[]): number | null =>
  ms.length === 0 || ms.some((m) => m.lanes == null) ? null : ms.reduce((s, m) => s + (m.lanes ?? 0), 0);

/* Which booths take a plaza's payments.
 *
 * The warehouse keeps each trip where it paid: on entry in the open system, on
 * exit in the closed one, and at the barrier at Balintawak, Bocaue and Sta.
 * Ines, whose booths stand across the carriageway itself. So a recorded payment
 * is matched to the mapped booths of the same movement, or to the barrier where
 * the plaza has none of that movement mapped. Names match ignoring case: the
 * map spells it "Cdv/Ph Arena", the warehouse "CDV/PH Arena".
 *
 * Per carriageway only when both sides can say which: every warehouse row of
 * the movement carries NB or SB, and every mapped plaza road serves exactly one.
 * NLEX Harbor Link's plazas serve both carriageways and most of its trips have
 * no direction recorded, so its 14 booths are one pool for all of them. */
function boothGroups(plaza: string, rows: ProfileRow[]): BoothGroup[] {
  const mapped = MAPPED.filter((m) => m.exit.toLowerCase() === plaza.toLowerCase());
  const groups: BoothGroup[] = [];
  for (const role of [...new Set(rows.map((r) => r.role))].sort()) {
    const paid = rows.filter((r) => r.role === role);
    let movement: OsmTollPlaza["movement"] = role === "Entry" ? "entry" : "exit";
    let booths = mapped.filter((m) => m.movement === movement);
    const barrier = mapped.filter((m) => m.movement === "barrier");
    if (booths.length === 0 && barrier.length > 0) {
      movement = "barrier";
      booths = barrier;
    }
    const sides = [...new Set(paid.map((r) => r.side))].sort();
    const perSide = !sides.includes("both") && booths.every((m) => m.directions.length === 1);
    if (perSide) {
      for (const side of sides) {
        groups.push({
          label: `${side} ${movement}`,
          pooled: false,
          booths: laneSum(booths.filter((m) => m.directions[0] === side)),
          v: volumes(paid.filter((r) => r.side === side)),
        });
      }
    } else {
      groups.push({ label: movement, pooled: true, booths: laneSum(booths), v: volumes(paid) });
    }
  }
  return groups;
}

/* ── what the plan is computed from ──────────────────────────────────────── */

type CongestionRow = { segment: string; km?: number | null; hours: number; state: string; probability: number | string };

type Inputs = {
  champion: { model_name: string; wmape: string | null; accepted: boolean };
  future: { date: string; dow: number; v: number }[];
  plazas: PlazaBooths[];
  /** Corridor volume by day type [weekday, weekend], summed over the history. */
  corridor: [number, number];
  profileFrom: string | null;
  profileTo: string | null;
  typicalDaily: number;
  congestionRows: CongestionRow[] | null;
  /** The exit list, for naming segments the congestion forecast lacks. */
  segments: string[];
};

/* Read once per split and kept. None of it depends on the operator's two
   dials, yet every notch of the throughput slider used to re-run all of it:
   7 to 46 s a notch on a cold database. Now a notch is arithmetic. One read at
   a time per split, so panels asking together share it. */
const INPUT_TTL_MS = 10 * 60 * 1000;
const inputCache = new Map<string, { at: number; data: Inputs | null }>();
const inputReads = new Map<string, Promise<Inputs | null>>();

function loadInputs(split: string): Promise<Inputs | null> {
  const hit = inputCache.get(split);
  if (hit && Date.now() - hit.at < INPUT_TTL_MS) return Promise.resolve(hit.data);
  let read = inputReads.get(split);
  if (!read) {
    read = readInputs(split)
      .then((data) => {
        inputCache.set(split, { at: Date.now(), data });
        return data;
      })
      .finally(() => inputReads.delete(split));
    inputReads.set(split, read);
  }
  return read;
}

async function readInputs(split: string): Promise<Inputs | null> {
  /* The champion. `accepted` is reported rather than required: the volume
     models currently all fail the MASE gate, and refusing to staff a toll
     plaza because the forecast is imperfect is not the operator's choice to
     have made for them. The flag travels with the answer instead. */
  const champQ = await db!.query<{ model_name: string; wmape: string | null; accepted: boolean }>(
    `SELECT model_name, wmape, accepted FROM gold.ml_model_metrics
      WHERE target = 'Total Traffic' AND split_label = $1
      ORDER BY accepted DESC, rank ASC NULLS LAST LIMIT 1`,
    [split],
  );
  const champion = champQ.rows[0];
  const col = champion ? MODEL_COLUMN[champion.model_name] : undefined;
  if (!champion || !col) return null;

  const [futureQ, profileQ, typicalQ, congestionRows, segmentQ] = await Promise.all([
    db!.query<{ d: string; v: string | null; dow: number }>(
      `SELECT forecast_date::text AS d, ${col}::text AS v, EXTRACT(dow FROM forecast_date)::int AS dow
         FROM gold.ml_predictive_volume
        WHERE split_label = $1 AND is_future AND ${col} IS NOT NULL
        ORDER BY forecast_date ASC LIMIT $2`,
      [split, WEEK_DAYS],
    ),
    /* Plaza volume by movement, carriageway, hour and day type in one pass:
       the shares the demand formula multiplies by, and which of the plaza's
       booths each part of it goes through. Shares are computed WITHIN each
       day type so they sum to 1 for a weekday and again for a weekend. */
    db!.query<{ plaza: string; role: string | null; direction: string | null; hour: number; weekend: boolean; v: string }>(
      `SELECT exit_canonical AS plaza, role, direction,
              hour::int      AS hour,
              (EXTRACT(dow FROM date)::int IN (0, 6)) AS weekend,
              SUM(total)::text AS v
         FROM gold.fact_traffic_hourly
        WHERE total IS NOT NULL
        GROUP BY 1, 2, 3, 4, 5`,
    ),
    db!.query<{ lo: string; hi: string; typical: string }>(
      `SELECT MIN(date)::text AS lo, MAX(date)::text AS hi,
              (SUM(total) / NULLIF(COUNT(DISTINCT date), 0))::text AS typical
         FROM gold.fact_traffic_hourly WHERE total IS NOT NULL`,
    ),
    getMLPredictiveCongestion() as Promise<CongestionRow[] | null>,
    db!.query<{ name: string }>(`SELECT exit_name AS name FROM gold.exit_km_post ORDER BY km_post`)
      .catch(() => ({ rows: [] as { name: string }[] })),
  ]);

  const profile: ProfileRow[] = profileQ.rows.map((r) => ({
    plaza: r.plaza, role: String(r.role ?? ""), side: sideOf(r.direction),
    hour: Number(r.hour), weekend: r.weekend, v: Number(r.v),
  }));
  const corridor: [number, number] = [0, 0];
  const byPlaza = new Map<string, ProfileRow[]>();
  for (const r of profile) {
    if (!(r.v > 0)) continue;
    corridor[r.weekend ? 1 : 0] += r.v;
    byPlaza.set(r.plaza, [...(byPlaza.get(r.plaza) ?? []), r]);
  }
  const plazas: PlazaBooths[] = [...byPlaza.entries()].map(([plaza, rows]) => {
    const groups = boothGroups(plaza, rows);
    return {
      plaza,
      groups,
      booths: groups.every((g) => g.booths != null) ? groups.reduce((s, g) => s + (g.booths ?? 0), 0) : null,
      basis: groups.map((g) => `${g.label} ${g.booths ?? "(none mapped)"}${g.pooled ? " (both directions)" : ""}`).join(" + "),
    };
  });

  return {
    champion,
    future: futureQ.rows
      .map((r) => ({ date: r.d, dow: Number(r.dow), v: Number(r.v) }))
      .filter((r) => Number.isFinite(r.v) && r.v > 0),
    plazas,
    corridor,
    profileFrom: typicalQ.rows[0]?.lo ?? null,
    profileTo: typicalQ.rows[0]?.hi ?? null,
    typicalDaily: Number(typicalQ.rows[0]?.typical ?? 0),
    congestionRows,
    segments: segmentQ.rows.map((r) => r.name),
  };
}

/* ── the endpoint ─────────────────────────────────────────────────────────── */

/** One set of booths in one hour. `max` is Infinity where none are mapped. */
type Part = { demand: number; need: number; max: number; staffed: number; unmet: number };

const fmtList = (xs: string[]) =>
  xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

export async function getTrafficPrescriptive(opts: {
  throughput?: number;
  /** Booth-hours available across the corridor for the shift plan. Null = unlimited. */
  pool?: number | null;
  split?: string;
}): Promise<TrafficPrescriptive | null> {
  if (!db) return null;

  const throughput = Math.max(1, opts.throughput ?? DEFAULT_THROUGHPUT);
  const pool = opts.pool ?? null;
  const split = opts.split ?? "80_20";

  const inputs = await loadInputs(split);
  if (!inputs) return null;
  const { champion, future, corridor, typicalDaily } = inputs;

  /** One plaza-hour, booth set by booth set: each needs a booth open while
   *  anyone uses it, and none can open more booths than it has. */
  const partsAt = (p: PlazaBooths, wk: 0 | 1, h: number, scale: number): Part[] =>
    p.groups.map((g) => {
      const demand = scale * g.v[wk][h];
      const need = demand > 0 ? Math.max(1, Math.ceil(demand / throughput)) : 0;
      const max = g.booths ?? Infinity;
      const staffed = Math.min(need, max);
      return { demand, need, max, staffed, unmet: Math.max(0, demand - staffed * throughput) };
    });
  const sumParts = (hour: number, parts: Part[]): BoothHour => ({
    hour,
    demand: Math.round(parts.reduce((s, x) => s + x.demand, 0)),
    need: parts.reduce((s, x) => s + x.need, 0),
    staffed: parts.reduce((s, x) => s + x.staffed, 0),
    unmet: Math.round(parts.reduce((s, x) => s + x.unmet, 0)),
  });
  /** A plaza's peak staffing and what it leaves queuing, from its hours.
   *  `whereAt` names the booth sets still leaving vehicles in an hour. */
  const settle = (p: BoothPlazaDay, hours: BoothHour[], whereAt: (hour: number) => string | null) => {
    p.peakStaffed = hours[p.peakHour]?.staffed ?? 0;
    p.unmetVehicles = hours.reduce((s, h) => s + h.unmet, 0);
    const worst = hours.reduce<BoothHour | null>((w, h) => (h.unmet > (w?.unmet ?? 0) ? h : w), null);
    p.worstUnmet = worst
      ? { hour: worst.hour, vehicles: worst.unmet, need: worst.need, staffed: worst.staffed, where: whereAt(worst.hour) }
      : null;
  };
  const totals = (d: BoothDay) => {
    d.totalPeakBooths = d.plazas.reduce((s, p) => s + p.peakStaffed, 0);
    d.unmetVehicles = d.plazas.reduce((s, p) => s + p.unmetVehicles, 0);
  };

  /** One day's plan. `hourly` false keeps only each plaza's summary; the
   *  parts come back for the allocator, and the over-capacity hours for the
   *  operator. */
  const buildDay = (date: string, dow: number, forecast: number, hourly: boolean) => {
    const weekend = dow === 0 || dow === 6;
    const wk: 0 | 1 = weekend ? 1 : 0;
    const denom = corridor[wk] || 1;
    const cells: { hour: BoothHour; parts: Part[] }[] = [];
    const over: OverCapacity[] = [];
    const whereOf = new Map<BoothPlazaDay, (hour: number) => string | null>();

    const plazas: BoothPlazaDay[] = [];
    for (const p of inputs.plazas) {
      const share = p.groups.reduce((s, g) => s + g.v[wk].reduce((a, x) => a + x, 0), 0) / denom;
      if (!(share > 0)) continue;

      const hours: BoothHour[] = [];
      const partsByHour: Part[][] = [];
      const worstByGroup = new Map<number, OverCapacity>();
      let peakHour = 0;
      for (let h = 0; h < 24; h++) {
        const parts = partsAt(p, wk, h, forecast / denom);
        const hour = sumParts(h, parts);
        hours.push(hour);
        partsByHour.push(parts);
        if (hourly) cells.push({ hour, parts });
        const best = hours[peakHour];
        if (hour.need > best.need || (hour.need === best.need && hour.demand > best.demand)) peakHour = h;
        parts.forEach((x, gi) => {
          if (x.need > x.max && Math.round(x.unmet) > (worstByGroup.get(gi)?.vehicles ?? 0)) {
            worstByGroup.set(gi, {
              date, plaza: p.plaza, where: p.groups[gi].label, hour: h,
              vehicles: Math.round(x.unmet), need: x.need, booths: x.max,
            });
          }
        });
      }
      over.push(...worstByGroup.values());

      const typical = partsAt(p, wk, peakHour, typicalDaily / denom);
      const day: BoothPlazaDay = {
        plaza: p.plaza,
        sharePct: Math.round(share * 10000) / 100,
        peakHour,
        peakNeed: hours[peakHour].need,
        peakStaffed: 0,
        booths: p.booths,
        boothBasis: p.basis,
        typicalPeakNeed: typical.reduce((s, x) => s + x.need, 0),
        typicalPeakStaffed: typical.reduce((s, x) => s + x.staffed, 0),
        unmetVehicles: 0,
        worstUnmet: null,
        hours: hourly ? hours : [],
      };
      // Reads the parts live, so it still answers after the allocator has reworked them.
      const whereAt = (h: number) =>
        partsByHour[h]?.map((x, gi) => (x.unmet >= 1 ? p.groups[gi].label : null)).filter(Boolean).join(" and ") || null;
      whereOf.set(day, whereAt);
      settle(day, hours, whereAt);
      plazas.push(day);
    }

    plazas.sort((a, b) => b.peakNeed - a.peakNeed);
    const day: BoothDay = {
      date,
      dayType: weekend ? "weekend" : "weekday",
      corridorForecast: Math.round(forecast),
      totalPeakBooths: 0,
      unmetVehicles: 0,
      plazas,
    };
    totals(day);
    return { day, cells, over, whereOf };
  };

  const weekBuilt = future.map((r) => buildDay(r.date, r.dow, r.v, false));
  const week = weekBuilt.map((b) => b.day);
  const first = future.length > 0 ? buildDay(future[0].date, future[0].dow, future[0].v, true) : null;
  const shiftPlan = first?.day ?? null;

  /* The allocation. Only meaningful when the pool is scarce; with no pool
     every cell is staffed to need, or to every booth it has, and what is left
     unmet is what no staffing could clear. */
  if (first && pool !== null && pool >= 0) {
    const parts = first.cells.flatMap((c) => c.parts);
    for (const x of parts) {
      x.staffed = 0;
      x.unmet = x.demand;
    }
    let left = pool;
    while (left > 0) {
      let best: Part | null = null;
      for (const x of parts) {
        if (x.staffed >= Math.min(x.need, x.max)) continue;
        if (!best || x.unmet > best.unmet) best = x;
      }
      if (!best || best.unmet <= 0) break;
      best.staffed += 1;
      best.unmet = Math.max(0, best.unmet - throughput);
      left -= 1;
    }
    for (const c of first.cells) Object.assign(c.hour, sumParts(c.hour.hour, c.parts));
    for (const p of first.day.plazas) settle(p, p.hours, first.whereOf.get(p) ?? (() => null));
    totals(first.day);
  }

  /* Where demand outruns every booth a plaza has. Read from the week, which no
     pool limits, so what is left there is the plaza's own ceiling. */
  const overCapacity = weekBuilt.flatMap((b) => b.over).sort((a, b) => b.vehicles - a.vehicles);
  const withoutBooths = inputs.plazas.filter((p) => p.booths == null).map((p) => p.plaza);

  /* ── congestion ─────────────────────────────────────────────────────────── */
  const bySeg = new Map<string, CongestionAdvice>();
  for (const c of inputs.congestionRows ?? []) {
    const p = Number(c.probability);
    if (!Number.isFinite(p)) continue;
    const high = String(c.state).toLowerCase() === "high";
    /* A "low" row is evidence AGAINST congestion, so it enters the controller
       as its complement rather than being dropped. The COMPLEMENT is what gets
       reported too: reporting the raw p while scoring 1 - p made the published
       probability disagree with the urgency beside it, which is worse than
       either number alone. `probability` therefore always means "probability
       of High", whichever row it came from. */
    const pHigh = high ? p : 1 - p;
    const { score, label } = fuzzyUrgency(pHigh, Number(c.hours));
    const cur = bySeg.get(c.segment);
    if (!cur || score > cur.urgency) {
      bySeg.set(c.segment, {
        segment: c.segment,
        km: c.km ?? null,
        probability: Math.round(pHigh * 1000) / 1000,
        hoursAhead: Number(c.hours),
        urgency: Math.round(score * 1000) / 1000,
        label,
        action: ACTION[label],
      });
    }
  }
  const congestion = [...bySeg.values()].sort((a, b) => b.urgency - a.urgency);
  const forecastSegments = new Set((inputs.congestionRows ?? []).map((c) => c.segment));
  const congestionMissing = inputs.segments.filter((s) => !forecastSegments.has(s));

  const worst = overCapacity[0];
  const overDays = new Set(overCapacity.map((o) => `${o.date}|${o.plaza}`)).size;

  return {
    champion: {
      model: champion.model_name,
      wmapePct: champion.wmape == null ? null : Math.round(Number(champion.wmape) * 100) / 100,
      accepted: Boolean(champion.accepted),
    },
    assumptions: [
      `One booth clears ${throughput} vehicles an hour. This is the only figure not measured from the warehouse — it is the operator's to set.`,
      `Booth counts are OpenStreetMap's (© OpenStreetMap contributors, read ${OSM_TOLL_PLAZAS_READ}); the warehouse holds none. ` +
        "Each plaza is capped at the booths of the movement that pays there, per carriageway where that is known. " +
        "Demand beyond them is reported as unserved rather than given booths that do not exist.",
      ...(withoutBooths.length
        ? [`${fmtList(withoutBooths)} ${withoutBooths.length === 1 ? "has" : "have"} no toll booths mapped, so ${withoutBooths.length === 1 ? "its plan is" : "their plans are"} not capped.`]
        : []),
      ...(worst
        ? [`On ${overDays} plaza-day${overDays === 1 ? "" : "s"} this week demand outruns every booth. The worst: ${worst.plaza} (its ${worst.where} booths) at ${String(worst.hour).padStart(2, "0")}:00 on ${worst.date} needs ${worst.need} booths and has ${worst.booths}, so about ${worst.vehicles.toLocaleString("en-US")} vehicles an hour queue with all of them open. That calls for diversion or an advisory, not more staff.`]
        : []),
      "Plaza shares and hourly profiles are measured per plaza and split weekday/weekend: Bocaue Barrier peaks in the morning and Balintawak in the evening, so one corridor-wide peak hour would mis-staff both.",
      "Demand is the corridor forecast apportioned by those shares, not a separate forecast per plaza. A plaza's own error is therefore not represented.",
      pool === null
        ? "No staffing limit applied: every plaza-hour is staffed to its need, or to every booth it has."
        : `A pool of ${pool} booth-hours is allocated to the plaza-hours with the most unmet demand, which is the optimum for this constraint shape.`,
      champion.accepted
        ? "The forecast model passed its acceptance gate."
        : "The forecast model did NOT pass its acceptance gate (it does not beat the seasonal baseline on MASE). The staffing shape is still driven by measured profiles; the level it is scaled to is less certain.",
    ],
    basis: {
      profileFrom: inputs.profileFrom,
      profileTo: inputs.profileTo,
      plazasProfiled: inputs.plazas.length,
      forecastFrom: future[0]?.date ?? null,
      forecastTo: future[future.length - 1]?.date ?? null,
      throughputPerBoothHour: throughput,
      poolBoothHours: pool,
      boothsFrom: `OpenStreetMap (© OpenStreetMap contributors), read ${OSM_TOLL_PLAZAS_READ}`,
      plazasWithoutBooths: withoutBooths,
    },
    shiftPlan,
    week,
    overCapacity,
    congestion,
    congestionMissing,
  };
}
