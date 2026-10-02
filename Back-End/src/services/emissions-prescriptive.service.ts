import { db } from "../config/db.js";
import { clearedIncidents, EMISSIONS_TABLE, exposureByHour, idleKg, IDLING_KG_PER_VEHICLE_MINUTE, recordBounds } from "./emissions-source.js";

/* ══════════════════════════════════════════════════════════════════════════════
   PRESCRIPTIVE EMISSIONS — three strategies, computed from the warehouse

   Replaces the three hardcoded bars ([8, 14, 22] under "Strategy X/Y/Z") that
   the sustainability tab carried behind an "Illustrative" chip. Spec, including
   the derivations and the one negative result below, is in
   docs/emissions-optimiser-spec.md.

   THE MODEL THESE OPTIMISE AGAINST

     CO2(exit, hour, class, direction) = volume x segment_distance_km x F(class)

   with F from nlex_emission_factors: 192 / 354 / 1492 g/km for classes 1/2/3.
   Verified against the live table — dividing co2_grams by volume x distance
   returns those three constants to the cent.

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
  /** For a strategy that is not evidence-bounded: what the record does show, in one sentence. */
  evidenceNote?: string;
  /** True when the bound comes from something the corridor has actually
   *  achieved. False marks a policy scenario — the UI must show the
   *  difference rather than letting the two sit side by side unlabelled. */
  evidenceBounded: boolean;
  assumptions: string[];
};

export type PrescriptiveResult = {
  strategies: Strategy[];
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

/** Per the warehouse's own factor table. Kept for the counterfactual: what a
 *  displaced heavy vehicle-km would emit if it moved to the medium class. */
const F_HEAVY = 1492;
const F_MEDIUM = 354;

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
  // Same anchoring as getEmissionsAnalyticsFromDb, so the Range control means
  // the same thing on this tab's Prescriptive view as on its Descriptive one.
  const anchor = "2025-01-01";
  const lo = anchor < minDate ? minDate : anchor > maxDate ? minDate : anchor;
  if (filters.months === "all") return { lo, hi: maxDate, askedFrom: lo, askedTo: maxDate, ...record };
  const { rows } = await db!.query(
    `SELECT LEAST(($1::date + ($2 || ' months')::interval - interval '1 day')::date, $3::date)::text AS hi`,
    [lo, filters.months, maxDate],
  );
  return { lo, hi: rows[0].hi as string, askedFrom: lo, askedTo: rows[0].hi as string, ...record };
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

  const [totals, exposure, incidents, monthly] = await Promise.all([
    // The denominator every reduction is expressed against, and Strategy A's raw material.
    db.query(
      `SELECT COALESCE(SUM(co2_tonnes), 0)                 AS co2_tonnes,
              COALESCE(SUM(total * segment_km), 0)         AS all_vkm,
              COALESCE(SUM(class_3 * segment_km), 0)       AS heavy_vkm
         FROM ${EMISSIONS_TABLE} WHERE date BETWEEN $1 AND $2`,
      [lo, hi],
    ),
    /* Strategy C's weight, and B's: how many vehicles an incident actually
       exposes. An incident blocks ONE exit-segment in ONE direction, so it is
       the vehicles per hour on one segment of one carriageway (see
       exposureByHour), not the corridor's. */
    exposureByHour(lo, hi),
    // Strategies B and C: every cleared accident in the Range, with its own clearance time.
    clearedIncidents(lo, hi),
    // Strategy A's evidence: the heavy share of vehicle-km in every month of the record.
    db.query(
      `SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS m,
              (100 * SUM(class_3 * segment_km) / NULLIF(SUM(total * segment_km), 0))::float AS share
         FROM ${EMISSIONS_TABLE} GROUP BY 1 ORDER BY 2`,
    ),
  ]);

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
     the factors, not the whole heavy factor. Assuming the whole 1492 g/km
     disappears would roughly double the answer. */
  const heavySharePct = allVkm > 0 ? (heavyVkm / allVkm) * 100 : 0;
  // A target, capped at the heavy share actually present: no more heavy vehicle-km can move than exist.
  const deltaPp = Math.round(Math.max(0, Math.min(filters.heavyShiftPp ?? 1, heavySharePct)) * 100) / 100;
  const shiftedVkm = allVkm * (deltaPp / 100);
  const cappedShiftVkm = Math.min(shiftedVkm, heavyVkm); // cannot move more heavy than exists
  const fleetTonnes = (cappedShiftVkm * (F_HEAVY - F_MEDIUM)) / 1e6;

  /* ── B and C. Idling ────────────────────────────────────────────────────
     Each incident's idling is the area of its queue triangle at its OWN
     clearance time (idleKg in emissions-source.ts): squaring each time, not a
     band's mean, which understated the tail. Bands are kept for the floors:
     clearance is heavily right-skewed (median 5 min, p90 59), so one floor for
     all would be meaningless. The floor in each band and hour is the p10 the
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
  const hoursByLoad = [...exposure.entries()].sort((a, b) => b[1] - a[1]);
  const targetHours = new Set(hoursByLoad.slice(0, 12).map(([h]) => h));

  /** Per incident: idling now, with B (every incident to its floor) and with C (only in the target hours). */
  const perIncident = incidents.map((e) => {
    const veh = exposure.get(e.hr) ?? 0;
    const floor = Math.min(e.minutes, floorOf.get(`${e.band}|${e.hr}`) ?? e.minutes);
    const now = idleKg(veh, e.minutes);
    const b = idleKg(veh, floor);
    return { saveB: now - b, saveC: targetHours.has(e.hr) ? now - b : 0 };
  });
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
      label: "Faster incident clearance",
      reductionPct: r2(pct(clearanceTonnes)),
      reductionTonnes: r2(clearanceTonnes),
      range: rangeOf(runsB),
      lever: "every clearance band pulled to the fastest 10% already achieved in that band",
      evidenceBounded: true,
      assumptions: [
        "Idling is the area of the queue triangle, lambda x T^2 / 2: vehicles join while the incident is live and drain as it clears. Still quadratic in delay, so the long tail dominates.",
        "One incident is taken to affect one exit-segment in one direction, not the whole corridor.",
        "The floor per band is that band's observed 10th percentile, so the target is a response time this corridor has already delivered.",
        `Idling factor ${IDLING_KG_PER_VEHICLE_MINUTE} kg CO2 per vehicle-minute, from Climatiq's petrol-car factor scaled by 0.10 for idling.`,
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
      lever: "same total capacity, concentrated on the 12 hours with the most vehicles exposed",
      evidenceBounded: true,
      assumptions: [
        "Reallocation, not extra resourcing: the hours outside the target keep their current clearance times.",
        "A minute saved at 17:00 traps roughly ten times the vehicles of a minute saved at 02:00, which is the entire reason this differs from the strategy above.",
        "Always at most as large as faster clearance corridor-wide, since it applies the same floor to fewer hours.",
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
      evidenceBounded: false,
      evidenceNote: fleetNote,
      assumptions: [
        `NOT bounded by evidence. ${fleetNote}`,
        "The freight still moves: the saving is the gap between the heavy and medium factors (1492 - 354 g/km), not the whole heavy factor.",
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
            reason: `No cleared incidents are recorded between ${lo} and ${hi}, and this strategy is computed from them.`,
          }));

  const data: PrescriptiveResult = {
    strategies: strategies.filter((s) => !unavailable.some((u) => u.key === s.key)),
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
