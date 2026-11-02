import { db } from "../config/db.js";
import { exitDisplayName, fmtKm, kmMeasured, kmPost, KM_POST_ANCHORS, KM_POST_START, nearestExitName } from "../lib/km-post.js";
import { clearedIncidents, EMISSIONS_TABLE, exposureByHour, idleKg, IDLING_SOURCE, recordBounds } from "./emissions-source.js";
import { forecastTable } from "./forecast-source.js";

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
   PRESCRIPTIVE EMISSIONS — measured recommendations only, from the warehouse

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
   must not be one: it would report a saving the model cannot produce.

   WHAT IT LEAVES (2 Nov 2026: only what the record measures)

     Shorter lane blockages   idling CO2 grows with delay SQUARED, and the p10 of
                              comparable blockages shows how far the corridor has
                              itself already cut it. Looked back over the Range,
                              and carried over the incident forecast's validated days.
     Class 3 window           the congestion forecast's High hours and Class 3's
                              measured share of vehicle-km in them (no CO2 claimed)
     Tolling (where)          the exits carrying most of that window's Class 3 CO2

   Removed on 2 Nov 2026 as not data-backed: the Class 3 share shift (its size was
   a chosen target, not an observed change), busiest-hours responder deployment
   (the record has no responder capacity data, and its "when" is already on the
   blockage strategy), and the TOPSIS ranking (its weights were the team's choice).

   Everything returned carries the window it was computed over and the bound it
   respected, so a reader can see where each number came from.
══════════════════════════════════════════════════════════════════════════════ */

export type PrescriptiveFilters = {
  months: "3" | "12" | "all";
  from?: string;
  to?: string;
  /** Accepted for old links and ignored since 2 Nov 2026: the Class 3 share shift it set was removed as not data-backed. */
  heavyShiftPp?: number;
};

export type Strategy = {
  key: "clearance";
  label: string;
  /** Reduction against the SAME window's actual CO2, so it is comparable to the Descriptive tab. */
  reductionPct: number;
  reductionTonnes: number;
  /** The bootstrap range (5th–95th percentile of resampled incidents); null with no incidents to resample. */
  range: { lowTonnes: number; highTonnes: number; lowPct: number; highPct: number; runs: number } | null;
  /** The decision variable's chosen value, in words. */
  lever: string;
  /** Where on the corridor the saving is, and when in the day: read off the incidents the figure is made of
   *  (the stretches and the hours that hold most of it), so the card names somewhere to act, not "corridor-wide". */
  where: string;
  when: string;
  /** What the saving is concentrated in, as one sentence an operator can act on. */
  focus?: string;
  /** Always true: the bound is a blockage time the corridor has already achieved. */
  evidenceBounded: boolean;
  /** How the figure is computed, step by step, each from the record or a cited source. */
  assumptions: string[];
  /** How the blockage floors were set and how many incidents stand behind them. */
  floorNote?: string;
  /** The same saving carried forward: the incident forecast's validated days x what each incident of the Range
   *  would have saved. Null with a reason in `projectionNote` where the data cannot support one. */
  projection?: { tonnes: number; from: string; to: string; days: number; forecastIncidents: number; basis: string } | null;
  projectionNote?: string;
};

/** One class's emissions per kilometre (the diagram's "CO2 per class-km" KPI). */
export type ClassKm = { cls: 1 | 2 | 3; label: string; gPerKm: number; vkmSharePct: number; co2SharePct: number };

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
  /** The advice, in words. Absent when there is no distinct window (see noWindow). */
  action?: string;
  /** Where the window came from: the congestion forecast's High-congestion hours, or (no forecast) the busiest hours. */
  source: "forecast" | "history";
  basis: string;
  /** Set, with no action, when the window is over half the day: there are then no distinct hours to avoid. */
  noWindow?: string;
};

/** Where and when a Class-3 peak toll would act (the diagram's "Dynamic tolling recommendation"). */
export type Tolling = {
  hours: string;
  exits: { name: string; class3Tonnes: number; sharePct: number }[];
  atStakeTonnes: number;
  note: string;
  /** The advice, in words: where a Class-3 surcharge would apply if one is considered. */
  action: string;
  /** Share of the window's Class-3 CO2 the listed exits carry. */
  coveredPct: number;
};

export type PrescriptiveResult = {
  strategies: Strategy[];
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

/* Bootstrap for the blockage strategy. Its saving depends on WHICH incidents
   happen in a Range — and because idling is quadratic, on how many long ones —
   so one figure overstates how well it is known. The Range's own incidents are
   resampled with replacement MC_RUNS times, each run recomputing the saving
   against the same observed floors, and the 5th–95th percentiles are reported
   as the range. Seeded, so the same Range gives the same range. */
const MC_RUNS = 400;
const MC_SEED = 20261002;

/** mulberry32: a small seeded generator, so the bootstrap is reproducible. */
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

  const [totals, exposure, incidents, hourly, byExitHour, factorRows, rangeIncidents, ahead] = await Promise.all([
    // The denominator every reduction is expressed against, and the class-km table's vehicle-km.
    db.query(
      `SELECT COALESCE(SUM(co2_tonnes), 0)                 AS co2_tonnes,
              COALESCE(SUM(vkm_1 + vkm_2 + vkm_3), 0)      AS all_vkm,
              COALESCE(SUM(vkm_1), 0)                      AS c1_vkm,
              COALESCE(SUM(vkm_2), 0)                      AS c2_vkm,
              COALESCE(SUM(vkm_3), 0)                      AS heavy_vkm
         FROM ${EMISSIONS_TABLE} WHERE date BETWEEN $1 AND $2`,
      [lo, hi],
    ),
    /* How many vehicles an incident actually exposes. An incident blocks ONE exit-segment in ONE direction, so it is
       the vehicles per hour on one segment of one carriageway (see
       exposureByHour), not the corridor's. */
    exposureByHour(lo, hi),
    // Every accident in the Range that blocked a lane, with its own blockage time.
    clearedIncidents(lo, hi),
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
    // g CO2 per km by class, for the class-km table and the tolling exits' Class 3 CO2.
    db.query(`SELECT vehicle_class AS c, co2_g_per_km::float AS g FROM nlex_emission_factors WHERE vehicle_class IN (1, 2, 3)`),
    /* The projection's two inputs (2 Nov 2026). Every incident of the Range, accidents and breakdowns, because that
       is what the incident forecast counts; and the forecast itself, only on the days its rolling-origin accuracy
       study passes (ml_incident_horizon_accuracy.usable), since a projection on failing days would be no better
       than repeating last week. Optional: missing tables leave the projection out with a reason. */
    db.query(
      `SELECT (SELECT COUNT(*) FROM silver.nlex_accident_events_clean WHERE event_start_date::date BETWEEN $1 AND $2)
            + (SELECT COUNT(*) FROM silver.nlex_breakdown_events_clean WHERE event_encoded_date::date BETWEEN $1 AND $2) AS n`,
      [lo, hi],
    ).catch(() => ({ rows: [] as { n: number }[] })),
    db.query(
      `WITH f AS (
         SELECT forecast_date, predicted_incident_count::float AS n, ROW_NUMBER() OVER (ORDER BY forecast_date) AS h
           FROM public.ml_predictive_incidents WHERE prediction_type = 'future'
       ), u AS (SELECT h_lo, h_hi FROM ml_incident_horizon_accuracy WHERE usable)
       SELECT MIN(forecast_date)::text AS a, MAX(forecast_date)::text AS b, COUNT(*)::int AS days, SUM(n)::float AS n,
              (SELECT string_agg(h_lo || '-' || h_hi, ', ' ORDER BY h_lo) FROM u) AS buckets
         FROM f WHERE EXISTS (SELECT 1 FROM u WHERE f.h BETWEEN u.h_lo AND u.h_hi)`,
    ).catch(() => ({ rows: [] as { a: string | null; b: string | null; days: number; n: number | null; buckets: string | null }[] })),
  ]);
  const factorOf = (c: number) => Number((factorRows.rows as { c: number; g: number }[]).find((r) => Number(r.c) === c)?.g ?? 0);
  const F_LIGHT = factorOf(1);
  const F_MEDIUM = factorOf(2);
  const F_HEAVY = factorOf(3);

  const actualTonnes = Number(totals.rows[0]?.co2_tonnes ?? 0);
  const heavyVkm = Number(totals.rows[0]?.heavy_vkm ?? 0);
  // Inside the record's bounds but with nothing in it (a gap): the same answer.
  if (!(actualTonnes > 0)) {
    const data = nothing(
      `No emissions are recorded between ${lo} and ${hi}, although the record runs from ${recordFrom} to ${recordTo}: this stretch of it is empty.`,
    );
    cache.set(key, { at: Date.now(), data });
    return data;
  }

  /* ── Shorter lane blockages: idling ─────────────────────────────────────
     Each incident's idling is the area of its queue triangle at its OWN
     lane-blockage time (idleKg and clearedIncidents in emissions-source.ts):
     squaring each time, not a band's mean, which understated the tail. Bands
     are kept for the floors: blockage is heavily right-skewed (median 4 min,
     p90 about 33), so one floor for all would be meaningless. The floor in each band and hour is the p10 the
     corridor has itself achieved there: the target is a response time already
     delivered, which is why the figure is evidence-bounded. An incident
     already faster than its floor keeps its own time. */
  /* A "fastest 10%" needs enough blockages to have a 10th percentile (2 Nov 2026). Split by length band AND hour,
     the long bands held 1-4 incidents a group, so their "floor" was simply the shortest of a handful, or the incident
     itself. Now: the band-and-hour p10 where that group has MIN_FLOOR_N or more blockages; otherwise the band's p10
     over all hours; and always the band's for blockages of an hour or more, whose groups are never that large. A band
     with fewer than MIN_FLOOR_N blockages in the Range gets no floor: its incidents keep their own times. */
  const MIN_FLOOR_N = 10;
  const LONG_BANDS = new Set(["to180", "over180"]);
  const groups = new Map<string, number[]>();
  const bandGroups = new Map<string, number[]>();
  for (const e of incidents) {
    const k = `${e.band}|${e.hr}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(e.minutes);
    if (!bandGroups.has(e.band)) bandGroups.set(e.band, []);
    bandGroups.get(e.band)!.push(e.minutes);
  }
  const p10 = (list: number[]) => percentile([...list].sort((a, b) => a - b), 0.1);
  const bandFloor = new Map<string, number>();
  for (const [b, list] of bandGroups) if (list.length >= MIN_FLOOR_N) bandFloor.set(b, p10(list));
  const floorOf = (band: string, hr: number): number | undefined => {
    const g = groups.get(`${band}|${hr}`);
    if (!LONG_BANDS.has(band) && g && g.length >= MIN_FLOOR_N) return p10(g);
    return bandFloor.get(band);
  };
  const BAND_WORDS: Record<string, string> = { under15: "under 15 min", to60: "15-60 min", to180: "1-3 h", over180: "over 3 h" };
  const longCounts = ["to180", "over180"].map((b) => `${(bandGroups.get(b)?.length ?? 0).toLocaleString("en-US")} blockages of ${BAND_WORDS[b]}`);
  const unfloored = [...bandGroups.entries()].filter(([, l]) => l.length < MIN_FLOOR_N).map(([b]) => BAND_WORDS[b]);
  const floorNote =
    `Floors: the 10th percentile of this Range's blockages of the same length at the same hour where at least ${MIN_FLOOR_N} exist, ` +
    `otherwise of that length at any hour; blockages of an hour or more always use their length band at any hour ` +
    `(${longCounts.join(", ")}).` +
    (unfloored.length ? ` Fewer than ${MIN_FLOOR_N} blockages of ${unfloored.join(", ")}: no floor, they keep their own times.` : "");

  /** Per incident: idling now, and the kg saved with its blockage cut to its floor. */
  const perIncident = incidents.map((e) => {
    const x = exposure.get(e.hr);
    const floor = Math.min(e.minutes, floorOf(e.band, e.hr) ?? e.minutes);
    const now = idleKg(x, e.minutes);
    const b = idleKg(x, floor);
    return { e, saveB: now - b };
  });

  /* Where and when each saving is, from the incidents it is made of. A stretch is 10 km of one carriageway —
     fine enough to send a patrol to, coarse enough that a year's incidents on it are not one bad afternoon. */
  const BOUND: Record<string, string> = { NB: "Northbound", SB: "Southbound", EB: "Eastbound", WB: "Westbound" };
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  /** Hours as ranges: [6,7,8,17,18] -> "06:00–09:00, 17:00–19:00". */
  const hourRanges = (hours: number[]): string => {
    const hs = [...new Set(hours)].sort((a, b) => a - b);
    const out: string[] = [];
    const runs: [number, number][] = [];
    for (let i = 0; i < hs.length; i++) {
      let j = i;
      while (j + 1 < hs.length && hs[j + 1] === hs[j] + 1) j++;
      runs.push([hs[i], hs[j]]);
      i = j;
    }
    // A run ending at 23:00 and one starting at 00:00 are one window across midnight ("23:00–01:00", 2 Nov 2026).
    if (runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === 23) {
      const last = runs.pop()!;
      runs[0] = [last[0], runs[0][1]];
    }
    for (const [a, z] of runs) out.push(`${hh(a)}–${hh((z + 1) % 24)}`);
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
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const clearanceTonnes = Math.max(0, sum(perIncident.map((x) => x.saveB)) / 1000);

  // The bootstrap: the same saving over MC_RUNS resamples of the Range's incidents.
  const runsB: number[] = [];
  if (perIncident.length > 0) {
    const random = rng(MC_SEED);
    for (let r = 0; r < MC_RUNS; r++) {
      let b = 0;
      for (let i = 0; i < perIncident.length; i++) b += perIncident[Math.floor(random() * perIncident.length)].saveB;
      runsB.push(b / 1000);
    }
    runsB.sort((a, b) => a - b);
  }

  const pct = (t: number) => (actualTonnes > 0 ? (t / actualTonnes) * 100 : 0);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const rangeOf = (runs: number[]): Strategy["range"] => {
    if (runs.length === 0) return null;
    const low = percentile(runs, 0.05);
    const high = percentile(runs, 0.95);
    return { lowTonnes: r2(low), highTonnes: r2(high), lowPct: r2(pct(low)), highPct: r2(pct(high)), runs: runs.length };
  };

  /* Carried forward (2 Nov 2026): what the Range's incidents would have saved, per incident, times the incidents the
     forecast expects on its validated days, so it carries the Range's mix of incidents, blockage lengths and hours. */
  const rangeIncidentN = Number((rangeIncidents.rows[0] as { n?: number } | undefined)?.n ?? 0);
  const fc = ahead.rows[0] as { a: string | null; b: string | null; days: number; n: number | null; buckets: string | null } | undefined;
  const projectionOf = (tonnes: number): { projection: Strategy["projection"]; projectionNote?: string } => {
    if (!fc || fc.n == null || !fc.a || !fc.b || !(fc.days > 0))
      return { projection: null, projectionNote: "No forward figure: the incident forecast has no days its accuracy study passes, so a projection would be no better than repeating last week." };
    if (!(rangeIncidentN > 0)) return { projection: null, projectionNote: "No forward figure: the Range holds no incidents to take a per-incident saving from." };
    const perIncident = tonnes / rangeIncidentN;
    return {
      projection: {
        tonnes: r2(fc.n * perIncident),
        from: fc.a,
        to: fc.b,
        days: fc.days,
        forecastIncidents: Math.round(fc.n),
        basis: `${Math.round(fc.n).toLocaleString("en-US")} incidents forecast for ${fc.a} to ${fc.b} (forecast days ${fc.buckets ?? "?"}, the only ones its accuracy study passes) x ${(perIncident * 1000).toFixed(1)} kg avoided per incident in the Range (${rangeIncidentN.toLocaleString("en-US")} incidents, ${incidents.length.toLocaleString("en-US")} of them lane-blocking). The per-incident saving is the Range's own, so it carries the Range's mix of incidents, blockage lengths and hours.`,
      },
    };
  };

  const days = incidents.map((e) => e.day).sort();
  const span = { lo: days[0] ?? null, hi: days[days.length - 1] ?? null, n: incidents.length };
  const bootstrapNote =
    `Range: the 5th to 95th percentile of ${MC_RUNS} bootstrap resamples of this Range's incidents, with the floors held at the observed ones. Which incidents happen moves the figure, the rare long ones most of all.`;

  const strategies: Strategy[] = [
    {
      key: "clearance",
      label: "Shorter lane blockages",
      reductionPct: r2(pct(clearanceTonnes)),
      reductionTonnes: r2(clearanceTonnes),
      range: rangeOf(runsB),
      lever: "in this Range, each lane blockage shortened to the fastest 10% of comparable blockages the corridor already achieved (same length, same hour where at least 10 exist): what that would have avoided, looking back",
      where: focusB.where,
      when: focusB.when,
      focus: focusB.focus,
      evidenceBounded: true,
      floorNote,
      ...projectionOf(clearanceTonnes),
      assumptions: [
        "Queueing lasts as long as a lane is blocked (blockage cleared minus the start), not as long as the site takes to clear: an incident that never blocked a lane queues nobody and is not counted.",
        "Idling is the area of the queue triangle, lambda x T^2 / 2: vehicles join while the lane is blocked and drain as it clears. Still quadratic in delay, so the long tail dominates.",
        "One incident is taken to affect one exit-segment in one direction, not the whole corridor.",
        floorNote,
        `Idling: ${IDLING_SOURCE} Weighted by each hour's class mix. US figures: none were found for the Philippine fleet.`,
        "Incident records end before the emissions record does; the window is stated in basis.",
        bootstrapNote,
      ],
    },
  ];

  /* The blockage strategy rests on cleared incidents in the Range. With none
     recorded there, its zero is an absence of data, not a result. */
  const incidentsCounted = span.n;
  const unavailable: PrescriptiveResult["unavailable"] =
    incidentsCounted > 0
      ? []
      : strategies
          .filter((s) => s.key === "clearance")
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

  /* ── Class 3 window advisory (the diagram's fleet-mix box, KPI: Class 3 peak share reduction) ──────────
     A recommendation again since 2 Nov 2026, claiming only what can be measured. The window is the hours the
     CONGESTION FORECAST expects High congestion most (those within 10% of its highest hour's average chance of
     High, over the next 7 days), so the advice follows the predictive model; with no forecast it falls back to
     the Range's busiest hours and says so. The effect is the diagram's KPI, Class 3's share of vehicle-km in
     those hours, which falls to 0 if trucks keep out; the receiving hours are the quietest, filled in order
     while each stays under the window's own lowest hour. No CO2 saving is claimed: in this model a truck emits
     the same at 03:00 as at 17:00, and the record has no freight or truck-ban data to say what it costs. */
  const hrs = (hourly.rows as { h: number; vkm: number; c3: number }[]).map((r) => ({ h: Number(r.h), vkm: Number(r.vkm), c3: Number(r.c3) }));
  let forecastHours: number[] = [];
  let forecastBase: string | null = null;
  try {
    const src = await forecastTable(db);
    const fc = await db!.query<{ h: number; p: number; base: string }>(
      `SELECT EXTRACT(hour FROM base_ts + make_interval(hours => hours_ahead))::int AS h,
              AVG(COALESCE(p_high, 0))::float AS p,
              to_char(MAX(base_ts), 'DD Mon YYYY HH24:00') AS base
         FROM ${src} WHERE hours_ahead BETWEEN 1 AND 168 GROUP BY 1`,
    );
    const topP = Math.max(0, ...fc.rows.map((r) => Number(r.p)));
    if (topP > 0) {
      forecastHours = fc.rows.filter((r) => Number(r.p) >= topP * 0.9).map((r) => Number(r.h));
      forecastBase = fc.rows[0]?.base ?? null;
    }
  } catch {
    // No congestion forecast to read: the busiest hours stand in, labelled as such below.
  }
  let heavyWindow: HeavyWindow | null = null;
  if (hrs.length >= 12) {
    const top = Math.max(...hrs.map((r) => r.vkm));
    const fromForecast = forecastHours.length > 0;
    const peak = fromForecast ? hrs.filter((r) => forecastHours.includes(r.h)) : hrs.filter((r) => r.vkm >= top * 0.9);
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
    const window = hourRanges([...peakSet]);
    const into = receiving.length ? hourRanges(receiving) : "the quieter hours";
    heavyWindow = {
      peakHours: window,
      peakHourList: [...peakSet].sort((a, b) => a - b),
      peakClass3SharePct: r2(sharePeak),
      class3InPeakPct: r2(allC3 > 0 ? (peakC3 / allC3) * 100 : 0),
      allDayClass3SharePct: r2(allVkmByHour > 0 ? (allC3 / allVkmByHour) * 100 : 0),
      shareReductionPp: r2(sharePeak),
      receivingHours: receiving.length ? hourRanges(receiving) : "none needed",
      fitsOffPeak: left <= 0,
      capacityNote:
        left <= 0
          ? `${receiving.length === 1 ? "The quietest hour" : `The ${receiving.length} quietest hours`} can take every moved Class-3 vehicle-km and stay${receiving.length === 1 ? "s" : ""} below the window's own lowest hour.`
          : `The quiet hours cannot take all of it without becoming as busy as the window (${Math.round((left / peakC3) * 100)}% would be left over): advise part of the window, not all of it.`,
      co2Note:
        "No CO2 saving is claimed: in this model a truck emits the same at 03:00 as at 17:00 (no congestion term), and the record holds no freight, delivery-hour or truck-ban data to say what the advisory costs operators.",
      action: left <= 0
        ? `Advise Class 3 to avoid ${window} and travel in ${into}.`
        : `Advise Class 3 to avoid the worst of ${window}; the quiet hours cannot take all of it.`,
      source: fromForecast ? "forecast" : "history",
      basis: fromForecast
        ? `Window from the congestion forecast${forecastBase ? ` of ${forecastBase}` : ""}: the hours it expects High congestion most over the next 7 days. Class 3 shares from this Range's vehicle-km.`
        : "No congestion forecast available: the window is this Range's busiest hours (within 10% of the busiest hour's vehicle-km).",
    };
    /* A "window" of more than half the day is not one (2 Nov 2026: a flat forecast once put 17 of 24 hours in
       it). Advising trucks off most of the day is not actionable, so no advisory and no surcharge is offered;
       the card says why instead. */
    if (peakSet.size > 12) {
      heavyWindow.action = undefined;
      heavyWindow.noWindow = `${fromForecast ? "The congestion forecast" : "This Range's traffic"} has no distinct peak: ${peakSet.size} of 24 hours are within 10% of the highest, so there is no window to advise Class 3 away from.`;
    }
  }

  /* ── Tolling recommendation (the diagram's "Dynamic tolling recommendation") ──────────────────────────
     Where a Class-3 surcharge in the advisory window would apply: the fewest exits that carry most (at least
     80%, at most five) of Class 3's CO2 in those hours. It says WHERE, not how much: the record has no toll
     prices, toll elasticity or diversion data, so no reduction is claimed. */
  let tolling: Tolling | null = null;
  if (heavyWindow?.action) {
    const peakSet = new Set(heavyWindow.peakHourList);
    const byExit = new Map<string, number>();
    for (const r of byExitHour.rows as { exit: string; h: number; c3: number }[]) {
      if (!peakSet.has(Number(r.h))) continue;
      byExit.set(r.exit, (byExit.get(r.exit) ?? 0) + (Number(r.c3) * F_HEAVY) / 1e6);
    }
    const total = [...byExit.values()].reduce((a, b) => a + b, 0);
    const sorted = [...byExit.entries()].sort((a, b) => b[1] - a[1]);
    const ranked: [string, number][] = [];
    let covered = 0;
    for (const e of sorted) {
      if (ranked.length >= 5 || (total > 0 && covered / total >= 0.8)) break;
      ranked.push(e);
      covered += e[1];
    }
    if (ranked.length) {
      const coveredPct = r2(total > 0 ? (covered / total) * 100 : 0);
      tolling = {
        hours: heavyWindow.peakHours,
        exits: ranked.map(([name, t]) => ({ name, class3Tonnes: r2(t), sharePct: r2(total > 0 ? (t / total) * 100 : 0) })),
        atStakeTonnes: r2(total),
        coveredPct,
        action: `If a Class 3 surcharge for ${heavyWindow.peakHours} is considered, apply it at ${ranked.map(([n]) => n).join(", ")}: they carry ${coveredPct.toFixed(0)}% of Class 3's CO2 in those hours.`,
        note:
          "It says where a surcharge would reach most of the Class-3 traffic in the advisory window, not how much it would cut: the record holds no toll prices, toll elasticity or diversion data, so no reduction is claimed.",
      };
    }
  }

  const data: PrescriptiveResult = {
    strategies: shown,
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
