import { db } from "../config/db.js";
import { exitDisplayName, fmtKm, kmMeasured, kmPost, KM_POST_ANCHORS, KM_POST_START, nearestExitName } from "../lib/km-post.js";
import { clearedIncidents, EMISSIONS_TABLE, exposureByHour, idleKg, IDLING_SOURCE, recordBounds } from "./emissions-source.js";

/* Exit names beside every km the Prescriptive tab prints (19 Oct 2026, testers: a bare "Southbound Km 50–60"
   meant nothing to a reader who knows the road by its exits), from lib/km-post.ts's one exit-name map, so the
   names match the rest of the dashboard. */
const SOUTH_OF_CORRIDOR = `south of Km ${KM_POST_START}, before Balintawak`;

/** "Km 50–60 near San Simon", "Km 10–20 from Balintawak to Paso de Blas Valenzuela": a 10-km stretch of official posts
    and the exits on it (the nearest one when none falls inside). Below the first post, no km is printed:
    NLEX has no posts south of Km 12. */
function stretchLabel(lo10: number): string {
  if (lo10 + 10 <= KM_POST_START) return SOUTH_OF_CORRIDOR;
  const on = KM_POST_ANCHORS.filter(([, , p]) => p >= lo10 && p < lo10 + 10).map(([k]) => exitDisplayName(k));
  const names = [...new Set(on)];
  const where = names.length > 1 ? `from ${names[0]} to ${names[names.length - 1]}` : `near ${names[0] ?? nearestExitName(kmMeasured(lo10 + 5))}`;
  return `Km ${lo10}–${lo10 + 10} ${where}`;
}

/** One measured km as "Km 59.2 near San Simon" (official post), or the south-of-corridor wording. */
function pointLabel(measured: number): string {
  const post = kmPost(measured);
  return post < KM_POST_START ? SOUTH_OF_CORRIDOR : `Km ${fmtKm(measured)} near ${nearestExitName(measured)}`;
}

/* ══════════════════════════════════════════════════════════════════════════════
   PRESCRIPTIVE EMISSIONS — three strategies, computed from the warehouse

   Replaces the three hardcoded bars ([8, 14, 22] under "Strategy X/Y/Z") that
   the sustainability tab carried behind an "Illustrative" chip. Spec, including
   the derivations and the one negative result below, is in
   docs/emissions-optimiser-spec.md.

   THE MODEL THESE OPTIMISE AGAINST

     CO2(exit, hour, class, direction) = vehicle-km x F(class)

   with vehicle-km from each trip's entry and exit (gold.fact_vkm_hourly) and F
   from nlex_emission_factors, the EMEP/EEA factors read from the table below.

   WHAT THAT RULES OUT

   The model is exactly linear in volume and carries NO speed or congestion
   term. Moving a trip from 17:00 to 10:00 therefore changes its emissions by
   exactly zero. There is no "shift demand off-peak" strategy here, and there
   must not be one: it would report a saving the model cannot produce. The peak
   enters only through Strategy C, where it changes how much a saved MINUTE of
   incident clearance is worth, not how much a vehicle emits.

   WHAT IT LEAVES

     A  fleet mix        the largest lever, but a policy SENSITIVITY, not an
                         optimisation — see the note on its bound below
     B  clearance time   idling CO2 grows with delay SQUARED, and the observed
                         p10 in each band shows how far it has actually been cut
     C  when to respond  the same minute saved is worth ~10x more at 17:00 than
                         at 02:00, because that is how many vehicles are trapped

   Everything returned carries the window it was computed over and the bound it
   respected, so a reader can see where each number came from.
══════════════════════════════════════════════════════════════════════════════ */

export type PrescriptiveFilters = {
  months: "3" | "12" | "all";
  from?: string;
  to?: string;
  /** Strategy A's policy target, in percentage points of Class-3 share.
   *  A CHOICE, not an observed bound. Defaults to 1 pp so the bar is non-zero
   *  and the elasticity is readable; the UI states that it is a target. */
  heavyShiftPp?: number;
};

export type Strategy = {
  key: "fleet_mix" | "clearance" | "deployment";
  label: string;
  /** Reduction against the SAME window's actual CO2, so the three bars are
   *  comparable to each other and to the Descriptive tab. */
  reductionPct: number;
  reductionTonnes: number;
  /** The Monte Carlo range (5th–95th percentile) where the saving depends on which incidents happen; null where it does not. */
  range: { lowTonnes: number; highTonnes: number; lowPct: number; highPct: number; runs: number } | null;
  /** The decision variable's chosen value, in words. */
  lever: string;
  /** Where on the corridor the saving is, and when in the day: read off the incidents the figure is made of
   *  (the stretches and the hours that hold most of it), so the card names somewhere to act, not "corridor-wide". */
  where: string;
  when: string;
  /** What the saving is concentrated in, as one sentence an operator can act on; absent for a policy scenario. */
  focus?: string;
  /** For a strategy that is not evidence-bounded: what the record does show, in one sentence. */
  evidenceNote?: string;
  /** True when the bound comes from something the corridor has actually
   *  achieved. False marks a policy scenario — the UI must show the
   *  difference rather than letting the two sit side by side unlabelled. */
  evidenceBounded: boolean;
  assumptions: string[];
};

/** One class's emissions per kilometre (the diagram's "CO2 per class-km" KPI). */
export type ClassKm = { cls: 1 | 2 | 3; label: string; gPerKm: number; vkmSharePct: number; co2SharePct: number };

/** TOPSIS over the CO2 strategies (the diagram's "TOPSIS - emission intervention ranking"). */
export type Ranking = {
  criteria: { key: string; label: string; weight: number; kind: "benefit" | "cost"; why: string }[];
  rows: { key: Strategy["key"]; label: string; closeness: number; rank: number; values: Record<string, number> }[];
  note: string;
};

/** The heavy-vehicle window restriction advisory (the diagram's fleet-mix box, KPI: Class 3 peak share reduction). */
export type HeavyWindow = {
  peakHours: string;
  peakHourList: number[];
  /** Class 3's share of vehicle-km in those hours now, and the share of all Class-3 vehicle-km that falls in them. */
  peakClass3SharePct: number;
  class3InPeakPct: number;
  /** Class 3's share of vehicle-km over the whole day, to compare the peak against. */
  allDayClass3SharePct: number;
  /** With the restriction honoured, the Class-3 share in the peak hours falls by this many points (the KPI). */
  shareReductionPp: number;
  receivingHours: string;
  /** Whether the hours that take the moved trucks stay below the peak's own level. */
  fitsOffPeak: boolean;
  capacityNote: string;
  co2Note: string;
};

/** Where and when a Class-3 peak toll would act (the diagram's "Dynamic tolling recommendation"). */
export type Tolling = {
  hours: string;
  exits: { name: string; class3Tonnes: number; sharePct: number }[];
  atStakeTonnes: number;
  note: string;
};

export type PrescriptiveResult = {
  strategies: Strategy[];
  ranking: Ranking | null;
  classKm: ClassKm[];
  corridorGPerVkm: number;
  heavyWindow: HeavyWindow | null;
  tolling: Tolling | null;
  /** Strategies this Range cannot support, and why. Left out of `strategies`
   *  rather than drawn as 0%: a bar at zero reads as "saves nothing", which is
   *  a finding, and there is no finding without the data. */
  unavailable: { key: Strategy["key"]; label: string; reason: string }[];
  /** Set when the Range holds no emissions at all. Nothing is computed, and
   *  this says why and what the record does cover. */
  noData: string | null;
  basis: {
    from: string;
    to: string;
    actualCo2Tonnes: number;
    /** Idling is modelled from incidents, which stop earlier than the
     *  emissions table. Stated rather than silently mixed. */
    incidentsFrom: string | null;
    incidentsTo: string | null;
    incidentsCounted: number;
    /** What the emissions record covers, whatever the Range asked for. */
    recordFrom: string;
    recordTo: string;
  };
};

const cache = new Map<string, { at: number; data: PrescriptiveResult }>();
const TTL_MS = 10 * 60 * 1000;

/* Monte Carlo for the two incident strategies. Their saving depends on WHICH
   incidents happen in a Range — and because idling is quadratic, on how many
   long ones — so one figure overstates how well it is known. The incidents are
   resampled with replacement (a bootstrap) MC_RUNS times, each run recomputing
   both savings against the same observed floors, and the 5th–95th percentiles
   are reported as the range. Seeded, so the same Range gives the same range. */
const MC_RUNS = 400;
const MC_SEED = 20261002;

/** mulberry32: a small seeded generator, so the Monte Carlo is reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The p-th percentile of sorted values, interpolated (PostgreSQL's PERCENTILE_CONT). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

async function resolveWindow(filters: PrescriptiveFilters) {
  const { minDate, maxDate } = await recordBounds();
  const record = { recordFrom: minDate, recordTo: maxDate };

  if (filters.from && filters.to) {
    const [f, t] = filters.from <= filters.to ? [filters.from, filters.to] : [filters.to, filters.from];
    /* Clipped to the record. A Range wholly outside it clips to nothing (lo
       after hi): that is reported as such, not run as an empty query whose
       zeros would read as "no saving". */
    return { lo: f < minDate ? minDate : f, hi: t > maxDate ? maxDate : t, askedFrom: f, askedTo: t, ...record };
  }
  // Same rule as every descriptive tab: month ranges END at the last day of data (the user, 2026-10-15).
  // "All" is the whole record; "3"/"12" are the last 3/12 months, 365 days for twelve.
  if (filters.months === "all") return { lo: minDate, hi: maxDate, askedFrom: minDate, askedTo: maxDate, ...record };
  const { rows } = await db!.query(
    `SELECT GREATEST(($1::date + interval '1 day' - ($2 || ' months')::interval)::date, $3::date)::text AS lo`,
    [maxDate, filters.months, minDate],
  );
  return { lo: rows[0].lo as string, hi: maxDate, askedFrom: rows[0].lo as string, askedTo: maxDate, ...record };
}

export async function getPrescriptiveStrategies(
  filters: PrescriptiveFilters,
): Promise<PrescriptiveResult | null> {
  if (!db) return null;

  const key = JSON.stringify(filters);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const { lo, hi, askedFrom, askedTo, recordFrom, recordTo } = await resolveWindow(filters);
  const nothing = (why: string): PrescriptiveResult => ({
    strategies: [],
    ranking: null,
    classKm: [],
    corridorGPerVkm: 0,
    heavyWindow: null,
    tolling: null,
    unavailable: [],
    noData: why,
    basis: {
      from: askedFrom, to: askedTo, actualCo2Tonnes: 0,
      incidentsFrom: null, incidentsTo: null, incidentsCounted: 0, recordFrom, recordTo,
    },
  });
  if (lo > hi) {
    const data = nothing(
      `No emissions are recorded between ${askedFrom} and ${askedTo}: the record runs from ${recordFrom} to ${recordTo}. Choose a Range inside it.`,
    );
    cache.set(key, { at: Date.now(), data });
    return data;
  }

  const [totals, exposure, incidents, monthly, hourly, byExitHour, factorRows] = await Promise.all([
    // The denominator every reduction is expressed against, and Strategy A's raw material.
    db.query(
      `SELECT COALESCE(SUM(co2_tonnes), 0)                 AS co2_tonnes,
              COALESCE(SUM(vkm_1 + vkm_2 + vkm_3), 0)      AS all_vkm,
              COALESCE(SUM(vkm_1), 0)                      AS c1_vkm,
              COALESCE(SUM(vkm_2), 0)                      AS c2_vkm,
              COALESCE(SUM(vkm_3), 0)                      AS heavy_vkm
         FROM ${EMISSIONS_TABLE} WHERE date BETWEEN $1 AND $2`,
      [lo, hi],
    ),
    /* Strategy C's weight, and B's: how many vehicles an incident actually
       exposes. An incident blocks ONE exit-segment in ONE direction, so it is
       the vehicles per hour on one segment of one carriageway (see
       exposureByHour), not the corridor's. */
    exposureByHour(lo, hi),
    // Strategies B and C: every accident in the Range that blocked a lane, with its own blockage time.
    clearedIncidents(lo, hi),
    // Strategy A's evidence: the heavy share of vehicle-km in every month of the record.
    db.query(
      `SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS m,
              (100 * SUM(vkm_3) / NULLIF(SUM(vkm_1 + vkm_2 + vkm_3), 0))::float AS share
         FROM ${EMISSIONS_TABLE} GROUP BY 1 ORDER BY 2`,
    ),
    // The window advisory's raw material: vehicle-km by hour of day, all classes and Class 3.
    db.query(
      `SELECT hour::int AS h, SUM(vkm_1 + vkm_2 + vkm_3)::float AS vkm, SUM(vkm_3)::float AS c3
         FROM ${EMISSIONS_TABLE} WHERE date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`,
      [lo, hi],
    ),
    // The tolling recommendation's: Class-3 vehicle-km by exit and hour.
    db.query(
      `SELECT exit_canonical AS exit, hour::int AS h, SUM(vkm_3)::float AS c3
         FROM ${EMISSIONS_TABLE} WHERE date BETWEEN $1 AND $2 GROUP BY 1, 2`,
      [lo, hi],
    ),
    // g CO2 per km by class, for what a displaced vehicle-km would emit in the class below it.
    db.query(`SELECT vehicle_class AS c, co2_g_per_km::float AS g FROM nlex_emission_factors WHERE vehicle_class IN (1, 2, 3)`),
  ]);
  const factorOf = (c: number) => Number((factorRows.rows as { c: number; g: number }[]).find((r) => Number(r.c) === c)?.g ?? 0);
  const F_LIGHT = factorOf(1);
  const F_MEDIUM = factorOf(2);
  const F_HEAVY = factorOf(3);

  const actualTonnes = Number(totals.rows[0]?.co2_tonnes ?? 0);
  const heavyVkm = Number(totals.rows[0]?.heavy_vkm ?? 0);
  const allVkm = Number(totals.rows[0]?.all_vkm ?? 0);
  // Inside the record's bounds but with nothing in it (a gap): the same answer.
  if (!(actualTonnes > 0)) {
    const data = nothing(
      `No emissions are recorded between ${lo} and ${hi}, although the record runs from ${recordFrom} to ${recordTo}: this stretch of it is empty.`,
    );
    cache.set(key, { at: Date.now(), data });
    return data;
  }

  /* ── A. Fleet mix ───────────────────────────────────────────────────────
     Displacing one heavy vehicle-km does not delete the trip, it moves the
     freight to the next class down, so the saving is the DIFFERENCE between
     the factors, not the whole heavy factor. */
  const heavySharePct = allVkm > 0 ? (heavyVkm / allVkm) * 100 : 0;
  // A target, capped at the heavy share actually present: no more heavy vehicle-km can move than exist.
  const deltaPp = Math.round(Math.max(0, Math.min(filters.heavyShiftPp ?? 1, heavySharePct)) * 100) / 100;
  const shiftedVkm = allVkm * (deltaPp / 100);
  const cappedShiftVkm = Math.min(shiftedVkm, heavyVkm); // cannot move more heavy than exists
  const fleetTonnes = (cappedShiftVkm * (F_HEAVY - F_MEDIUM)) / 1e6;

  /* ── B and C. Idling ────────────────────────────────────────────────────
     Each incident's idling is the area of its queue triangle at its OWN
     lane-blockage time (idleKg and clearedIncidents in emissions-source.ts):
     squaring each time, not a band's mean, which understated the tail. Bands
     are kept for the floors: blockage is heavily right-skewed (median 4 min,
     p90 about 33), so one floor for all would be meaningless. The floor in each band and hour is the p10 the
     corridor has itself achieved there: the target is a response time already
     delivered, which is why B and C are evidence-bounded and A is not. An
     incident already faster than its floor keeps its own time. */
  const groups = new Map<string, number[]>();
  for (const e of incidents) {
    const k = `${e.band}|${e.hr}`;
    const list = groups.get(k) ?? [];
    list.push(e.minutes);
    groups.set(k, list);
  }
  const floorOf = new Map<string, number>();
  for (const [k, list] of groups) floorOf.set(k, percentile([...list].sort((a, b) => a - b), 0.1));

  // Strategy C reallocates a fixed capacity, so it can only improve the hours
  // it is pointed at. Pointed at the busiest half of the day — where a saved
  // minute traps the most vehicles — and deliberately NOT at the rest.
  const hoursByLoad = [...exposure.entries()].sort((a, b) => b[1].veh - a[1].veh);
  const targetHours = new Set(hoursByLoad.slice(0, 12).map(([h]) => h));

  /** Per incident: idling now, with B (every incident to its floor) and with C (only in the target hours). */
  const perIncident = incidents.map((e) => {
    const x = exposure.get(e.hr);
    const floor = Math.min(e.minutes, floorOf.get(`${e.band}|${e.hr}`) ?? e.minutes);
    const now = idleKg(x, e.minutes);
    const b = idleKg(x, floor);
    return { e, saveB: now - b, saveC: targetHours.has(e.hr) ? now - b : 0 };
  });

  /* Where and when each saving is, from the incidents it is made of. A stretch is 10 km of one carriageway —
     fine enough to send a patrol to, coarse enough that a year's incidents on it are not one bad afternoon. */
  const BOUND: Record<string, string> = { NB: "Northbound", SB: "Southbound", EB: "Eastbound", WB: "Westbound" };
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  /** Hours as ranges: [6,7,8,17,18] -> "06:00–09:00, 17:00–19:00". */
  const hourRanges = (hours: number[]): string => {
    const hs = [...new Set(hours)].sort((a, b) => a - b);
    const out: string[] = [];
    for (let i = 0; i < hs.length; i++) {
      let j = i;
      while (j + 1 < hs.length && hs[j + 1] === hs[j] + 1) j++;
      out.push(`${hh(hs[i])}–${hh((hs[j] + 1) % 24)}`);
      i = j;
    }
    return out.join(", ");
  };
  const focusOf = (pick: (x: (typeof perIncident)[number]) => number) => {
    const total = perIncident.reduce((s, x) => s + pick(x), 0);
    const share = (v: number) => (total > 0 ? Math.round((v / total) * 100) : 0);
    const byStretch = new Map<string, { kg: number; long: number }>();
    const byHour = new Map<number, number>();
    let longKg = 0;
    let longN = 0;
    let biggest: (typeof perIncident)[number] | undefined;
    for (const x of perIncident) {
      const v = pick(x);
      if (!(v > 0)) continue;
      if (!biggest || v > pick(biggest)) biggest = x;
      if (x.e.km != null && x.e.direction != null) {
        // 10-km stretches of the official km post (lib/km-post.ts); x.e.km is DPWH chainage, which is on the measured scale.
        const lo10 = Math.floor(kmPost(x.e.km) / 10) * 10;
        const k = `${BOUND[x.e.direction] ?? x.e.direction} ${stretchLabel(lo10)}`;
        const s = byStretch.get(k) ?? { kg: 0, long: 0 };
        s.kg += v;
        if (x.e.minutes >= 60) s.long++;
        byStretch.set(k, s);
      }
      byHour.set(x.e.hr, (byHour.get(x.e.hr) ?? 0) + v);
      if (x.e.minutes >= 60) {
        longKg += v;
        longN++;
      }
    }
    const top = [...byStretch.entries()].sort((a, b) => b[1].kg - a[1].kg).slice(0, 3);
    /* The cost is quadratic, so one very long blockage can be most of a stretch's figure. Say so when it is:
       a stretch that leads because of one afternoon is not a stretch that needs a standing patrol. */
    const lone =
      biggest && total > 0 && pick(biggest) / total >= 0.2
        ? ` One incident alone is ${share(pick(biggest))}% of it (${biggest.e.day}, ${BOUND[biggest.e.direction ?? ""] ?? "direction not recorded"}${biggest.e.km != null ? ` ${pointLabel(biggest.e.km)}` : ""}, lane blocked ${(biggest.e.minutes / 60).toFixed(1)} h), so read the stretch shares as where the long blockages happened this Range, not as a fixed pattern.`
        : "";
    const topHours = [...byHour.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    return {
      where: top.length
        ? top.map(([k, v]) => `${k} (${share(v.kg)}%, ${v.long} blockage${v.long === 1 ? "" : "s"} of an hour or more)`).join(" · ")
        : "Corridor-wide (the incidents carry no km post)",
      when: topHours.length ? `${hourRanges(topHours.map(([h]) => h))} — ${share(topHours.reduce((s, [, v]) => s + v, 0))}% of the saving` : "No hour stands out",
      focus: total > 0
        ? `${share(longKg)}% of this saving comes from ${longN.toLocaleString("en-US")} incident${longN === 1 ? "" : "s"} that blocked a lane for an hour or more — the long blockages are the ones to shorten first.${lone}`
        : undefined,
    };
  };
  const focusB = focusOf((x) => x.saveB);
  const focusC = focusOf((x) => x.saveC);
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const clearanceTonnes = Math.max(0, sum(perIncident.map((x) => x.saveB)) / 1000);
  const deploymentTonnes = Math.max(0, sum(perIncident.map((x) => x.saveC)) / 1000);

  // The Monte Carlo: the same two savings over MC_RUNS resamples of the Range's incidents.
  const runsB: number[] = [];
  const runsC: number[] = [];
  if (perIncident.length > 0) {
    const random = rng(MC_SEED);
    for (let r = 0; r < MC_RUNS; r++) {
      let b = 0;
      let c = 0;
      for (let i = 0; i < perIncident.length; i++) {
        const x = perIncident[Math.floor(random() * perIncident.length)];
        b += x.saveB;
        c += x.saveC;
      }
      runsB.push(b / 1000);
      runsC.push(c / 1000);
    }
    runsB.sort((a, b) => a - b);
    runsC.sort((a, b) => a - b);
  }

  const pct = (t: number) => (actualTonnes > 0 ? (t / actualTonnes) * 100 : 0);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const rangeOf = (runs: number[]): Strategy["range"] => {
    if (runs.length === 0) return null;
    const low = percentile(runs, 0.05);
    const high = percentile(runs, 0.95);
    return { lowTonnes: r2(low), highTonnes: r2(high), lowPct: r2(pct(low)), highPct: r2(pct(high)), runs: runs.length };
  };

  /* Why A is a scenario, from the record itself. The heavy share does move month
     to month, but its lowest months are holiday months, when car traffic swells
     and dilutes the trucks — not months when fewer trucks ran — so they show the
     share CAN read lower, not that anything NLEX controls can make it. */
  const months = monthly.rows as { m: string; share: number }[];
  const fmtMonth = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  const lowest = months.slice(0, 3);
  const highest = months[months.length - 1];
  const allDecember = lowest.length > 0 && lowest.every((x) => x.m.endsWith("-12"));
  const fleetNote = lowest.length
    ? `Heavy vehicles' monthly share of vehicle-km ran from ${lowest[0].share.toFixed(2)}% (${fmtMonth(lowest[0].m)}) to ${highest.share.toFixed(2)}% (${fmtMonth(highest.m)}) over ${months.length} months. ` +
      (allDecember
        ? `The lowest months are all Decembers (${lowest.map((x) => fmtMonth(x.m)).join(", ")}), when holiday car traffic dilutes the trucks rather than fewer trucks running, so nothing in the record shows the share can be pushed down by policy.`
        : `The lowest were ${lowest.map((x) => `${fmtMonth(x.m)} (${x.share.toFixed(2)}%)`).join(", ")}; nothing in the record ties them to anything NLEX controls.`)
    : "The record has no monthly heavy share to compare against.";

  const days = incidents.map((e) => e.day).sort();
  const span = { lo: days[0] ?? null, hi: days[days.length - 1] ?? null, n: incidents.length };
  const mcNote =
    `Range: the 5th to 95th percentile of ${MC_RUNS} Monte Carlo resamples of this Range's incidents, with the floors held at the observed ones. Which incidents happen moves the figure, the rare long ones most of all.`;

  const strategies: Strategy[] = [
    {
      key: "clearance",
      label: "Shorter lane blockages",
      reductionPct: r2(pct(clearanceTonnes)),
      reductionTonnes: r2(clearanceTonnes),
      range: rangeOf(runsB),
      lever: "every lane blockage shortened to the fastest 10% already achieved for blockages of its length, at that hour",
      where: focusB.where,
      when: focusB.when,
      focus: focusB.focus,
      evidenceBounded: true,
      assumptions: [
        "Queueing lasts as long as a lane is blocked (blockage cleared minus the start), not as long as the site takes to clear: an incident that never blocked a lane queues nobody and is not counted.",
        "Idling is the area of the queue triangle, lambda x T^2 / 2: vehicles join while the lane is blocked and drain as it clears. Still quadratic in delay, so the long tail dominates.",
        "One incident is taken to affect one exit-segment in one direction, not the whole corridor.",
        "The floor per band is that band's observed 10th percentile, so the target is a response time this corridor has already delivered.",
        `Idling: ${IDLING_SOURCE} Weighted by each hour's class mix. US figures: none were found for the Philippine fleet.`,
        "Incident records end before the emissions record does; the window is stated in basis.",
        mcNote,
      ],
    },
    {
      key: "deployment",
      label: "Response capacity at the busiest hours",
      reductionPct: r2(pct(deploymentTonnes)),
      reductionTonnes: r2(deploymentTonnes),
      range: rangeOf(runsC),
      lever: `same total capacity, concentrated on the 12 busiest hours (${hourRanges([...targetHours])})`,
      where: focusC.where,
      when: hourRanges([...targetHours]),
      focus: focusC.focus,
      evidenceBounded: true,
      assumptions: [
        "Reallocation, not extra resourcing: the hours outside the target keep their current blockage times.",
        "A minute saved at 17:00 traps roughly ten times the vehicles of a minute saved at 02:00, which is the entire reason this differs from the strategy above.",
        "Always at most as large as shorter blockages corridor-wide, since it applies the same floor to fewer hours.",
        mcNote,
      ],
    },
    {
      key: "fleet_mix",
      label: `Heavy-vehicle share down ${deltaPp} pp`,
      reductionPct: r2(pct(fleetTonnes)),
      reductionTonnes: r2(fleetTonnes),
      range: null,
      lever: `${deltaPp} pp of Class-3 vehicle-km moved to Class 2 (from ${heavySharePct.toFixed(2)}% in this Range) — a policy target, not an observed change`,
      where: "Corridor-wide: it is a share of all vehicle-km, not of any one stretch",
      when: "Every day of the Range",
      evidenceBounded: false,
      evidenceNote: fleetNote,
      assumptions: [
        `NOT bounded by evidence. ${fleetNote}`,
        `The freight still moves: the saving is the gap between the Class 3 and Class 2 factors (${Math.round(F_HEAVY)} - ${Math.round(F_MEDIUM)} g/km), not the whole Class 3 factor.`,
        "Linear in the shift, so the figure doubles if the target doubles. Read it as a sensitivity: it has no Monte Carlo range because nothing in it is uncertain except the target you choose.",
      ],
    },
  ];

  /* The two incident strategies rest on cleared incidents in the Range. With
     none recorded there, their zero is an absence of data, not a result. */
  const incidentsCounted = span.n;
  const unavailable: PrescriptiveResult["unavailable"] =
    incidentsCounted > 0
      ? []
      : strategies
          .filter((s) => s.key === "clearance" || s.key === "deployment")
          .map((s) => ({
            key: s.key,
            label: s.label,
            reason: `No lane-blocking incidents are recorded between ${lo} and ${hi}, and this strategy is computed from them.`,
          }));

  const shown = strategies.filter((s) => !unavailable.some((u) => u.key === s.key));

  /* ── CO2 per class-km ───────────────────────────────────────────────────
     The diagram's KPI for this box. Per vehicle-km the factors ARE the model, so the
     finding is the gap between a class's share of the distance driven and its share of the CO2. */
  const c1 = Number(totals.rows[0]?.c1_vkm ?? 0);
  const c2 = Number(totals.rows[0]?.c2_vkm ?? 0);
  const classVkm = [c1, c2, heavyVkm];
  const factors = [F_LIGHT, F_MEDIUM, F_HEAVY];
  const classCo2 = classVkm.map((v, i) => v * factors[i]);
  const co2Sum = classCo2.reduce((a, b) => a + b, 0);
  const vkmSum = classVkm.reduce((a, b) => a + b, 0);
  const classKm: ClassKm[] = [0, 1, 2].map((i) => ({
    cls: (i + 1) as 1 | 2 | 3,
    label: ["Class 1 (cars, vans)", "Class 2 (buses, small trucks)", "Class 3 (large trucks)"][i],
    gPerKm: factors[i],
    vkmSharePct: r2(vkmSum > 0 ? (classVkm[i] / vkmSum) * 100 : 0),
    co2SharePct: r2(co2Sum > 0 ? (classCo2[i] / co2Sum) * 100 : 0),
  }));
  const corridorGPerVkm = vkmSum > 0 ? Math.round(co2Sum / vkmSum) : 0;

  /* ── Heavy-vehicle window advisory ──────────────────────────────────────
     The diagram's fleet-mix box: KPI "Class 3 peak share reduction". The peak hours are those within 10% of
     the busiest hour's vehicle-km; the receiving hours are the quietest, filled in order until they hold the
     moved Class-3 vehicle-km while each stays under the peak's own lowest hour. It is NOT a CO2 strategy: in
     this model a truck emits the same at 03:00 as at 17:00 (no congestion term), so it is reported on its own
     KPI and says so, rather than inflating the CO2 bars. */
  const hrs = (hourly.rows as { h: number; vkm: number; c3: number }[]).map((r) => ({ h: Number(r.h), vkm: Number(r.vkm), c3: Number(r.c3) }));
  let heavyWindow: HeavyWindow | null = null;
  if (hrs.length >= 12) {
    const top = Math.max(...hrs.map((r) => r.vkm));
    const peak = hrs.filter((r) => r.vkm >= top * 0.9);
    const peakSet = new Set(peak.map((r) => r.h));
    const peakVkm = peak.reduce((a, r) => a + r.vkm, 0);
    const peakC3 = peak.reduce((a, r) => a + r.c3, 0);
    const allC3 = hrs.reduce((a, r) => a + r.c3, 0);
    const allVkmByHour = hrs.reduce((a, r) => a + r.vkm, 0);
    const ceiling = Math.min(...peak.map((r) => r.vkm));
    const quiet = hrs.filter((r) => !peakSet.has(r.h)).sort((a, b) => a.vkm - b.vkm);
    let left = peakC3;
    const receiving: number[] = [];
    for (const r of quiet) {
      if (left <= 0) break;
      const room = Math.max(0, ceiling - r.vkm);
      if (room <= 0) continue;
      receiving.push(r.h);
      left -= room;
    }
    const sharePeak = peakVkm > 0 ? (peakC3 / peakVkm) * 100 : 0;
    heavyWindow = {
      peakHours: hourRanges([...peakSet]),
      peakHourList: [...peakSet].sort((a, b) => a - b),
      peakClass3SharePct: r2(sharePeak),
      class3InPeakPct: r2(allC3 > 0 ? (peakC3 / allC3) * 100 : 0),
      allDayClass3SharePct: r2(allVkmByHour > 0 ? (allC3 / allVkmByHour) * 100 : 0),
      shareReductionPp: r2(sharePeak),
      receivingHours: receiving.length ? hourRanges(receiving) : "none needed",
      fitsOffPeak: left <= 0,
      capacityNote:
        left <= 0
          ? `${receiving.length === 1 ? "The quietest hour" : `The ${receiving.length} quietest hours`} can take every displaced Class-3 vehicle-km and stay${receiving.length === 1 ? "s" : ""} below the peak's own lowest hour.`
          : `The quiet hours cannot take all of it without becoming as busy as the peak (${Math.round((left / peakC3) * 100)}% would be left over): restrict part of the window, not all of it.`,
      co2Note:
        "No CO2 saving is claimed: in this model emissions do not depend on the hour, so a truck moved to the night emits the same. The gain is a peak with fewer trucks in it; the KPI is the Class-3 share in those hours.",
    };
  }

  /* ── Dynamic tolling recommendation ─────────────────────────────────────
     Where a Class-3 peak toll would act: the exits carrying most Class-3 CO2 in the peak hours. No toll
     elasticity is in the record, so it states what is at stake there, not a saving. */
  let tolling: Tolling | null = null;
  if (heavyWindow) {
    const peakSet = new Set(heavyWindow.peakHourList);
    const byExit = new Map<string, number>();
    for (const r of byExitHour.rows as { exit: string; h: number; c3: number }[]) {
      if (!peakSet.has(Number(r.h))) continue;
      byExit.set(r.exit, (byExit.get(r.exit) ?? 0) + (Number(r.c3) * F_HEAVY) / 1e6);
    }
    const total = [...byExit.values()].reduce((a, b) => a + b, 0);
    const ranked = [...byExit.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (ranked.length) {
      tolling = {
        hours: heavyWindow.peakHours,
        exits: ranked.map(([name, t]) => ({ name, class3Tonnes: r2(t), sharePct: r2(total > 0 ? (t / total) * 100 : 0) })),
        atStakeTonnes: r2(total),
        note:
          "A Class-3 surcharge in these hours at these exits is the lever that would enforce the window above. The record holds no toll elasticity, so no CO2 reduction is claimed: the tonnes are what Class 3 emits there now, the most a toll there could act on.",
      };
    }
  }

  /* ── TOPSIS ─────────────────────────────────────────────────────────────
     The diagram ranks interventions with TOPSIS. Criteria are only what the record can measure: the expected
     saving, the saving even in a bad year (the Monte Carlo 5th percentile; a policy target with no evidence
     scores 0 there), whether the bound is something the corridor has already achieved, and how wide the
     uncertainty is. Weights are a stated choice (they sum to 1) and are returned with the ranking. */
  let ranking: Ranking | null = null;
  if (shown.length >= 2) {
    const criteria: Ranking["criteria"] = [
      { key: "expected", label: "Expected CO2 avoided, as the record supports it (t)", weight: 0.35, kind: "benefit", why: "The size of the saving. A policy target's figure is whatever target is chosen, so it counts 0 here: ranking a chosen number against measured ones would rank the choice." },
      { key: "worst", label: "Avoided even in a bad year (t, 5th percentile)", weight: 0.25, kind: "benefit", why: "What can be counted on; a policy target with no evidence counts 0." },
      { key: "evidence", label: "Bound already achieved on NLEX (1 = yes)", weight: 0.25, kind: "benefit", why: "Whether the corridor has shown it can do this." },
      { key: "spread", label: "Uncertainty (5th-95th width / expected)", weight: 0.15, kind: "cost", why: "How far the figure could move." },
    ];
    type Vals = { expected: number; worst: number; evidence: number; spread: number };
    const spreads = shown
      .filter((st) => st.range && st.reductionTonnes > 0)
      .map((st) => (st.range!.highTonnes - st.range!.lowTonnes) / st.reductionTonnes);
    // No range means the uncertainty is not known, which is scored as the widest one seen, not as none.
    const unknownSpread = spreads.length ? Math.max(...spreads) : 1;
    const vals: Vals[] = shown.map((st) => ({
      expected: st.evidenceBounded ? st.reductionTonnes : 0,
      worst: st.evidenceBounded ? (st.range?.lowTonnes ?? st.reductionTonnes) : 0,
      evidence: st.evidenceBounded ? 1 : 0,
      spread: st.range && st.reductionTonnes > 0 ? (st.range.highTonnes - st.range.lowTonnes) / st.reductionTonnes : unknownSpread,
    }));
    const keys = criteria.map((c) => c.key as keyof Vals);
    const norm = keys.map((k) => Math.sqrt(vals.reduce((a, v) => a + v[k] * v[k], 0)) || 1);
    const weighted = vals.map((v) => keys.map((k, j) => (v[k] / norm[j]) * criteria[j].weight));
    const col = (j: number) => weighted.map((w) => w[j]);
    const ideal = keys.map((_, j) => (criteria[j].kind === "benefit" ? Math.max(...col(j)) : Math.min(...col(j))));
    const anti = keys.map((_, j) => (criteria[j].kind === "benefit" ? Math.min(...col(j)) : Math.max(...col(j))));
    const closeness = weighted.map((w) => {
      const dPlus = Math.sqrt(w.reduce((a, x, j) => a + (x - ideal[j]) ** 2, 0));
      const dMinus = Math.sqrt(w.reduce((a, x, j) => a + (x - anti[j]) ** 2, 0));
      return dPlus + dMinus > 0 ? dMinus / (dPlus + dMinus) : 0;
    });
    const order = closeness.map((c, i) => ({ c, i })).sort((a, b) => b.c - a.c);
    ranking = {
      criteria,
      rows: order.map(({ c, i }, n) => ({
        key: shown[i].key,
        label: shown[i].label,
        closeness: Math.round(c * 1000) / 1000,
        rank: n + 1,
        values: Object.fromEntries(keys.map((k) => [k, Math.round(vals[i][k] * 100) / 100])),
      })),
      note:
        "TOPSIS scores each intervention by how close it is to an ideal one (best on every criterion) and how far from the worst, from 0 to 1. Shorter blockages and busiest-hours deployment overlap (the second is part of the first): rank them as alternatives, never add their savings.",
    };
  }

  const data: PrescriptiveResult = {
    strategies: shown,
    ranking,
    classKm,
    corridorGPerVkm,
    heavyWindow,
    tolling,
    unavailable,
    noData: null,
    basis: {
      from: lo,
      to: hi,
      actualCo2Tonnes: r2(actualTonnes),
      incidentsFrom: span.lo,
      incidentsTo: span.hi,
      incidentsCounted,
      recordFrom,
      recordTo,
    },
  };

  cache.set(key, { at: Date.now(), data });
  return data;
}
