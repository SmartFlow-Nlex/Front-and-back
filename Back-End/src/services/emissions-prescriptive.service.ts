import { db } from "../config/db.js";

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
  /** The decision variable's chosen value, in words. */
  lever: string;
  /** True when the bound comes from something the corridor has actually
   *  achieved. False marks a policy scenario — the UI must show the
   *  difference rather than letting the two sit side by side unlabelled. */
  evidenceBounded: boolean;
  assumptions: string[];
};

export type PrescriptiveResult = {
  strategies: Strategy[];
  basis: {
    from: string;
    to: string;
    actualCo2Tonnes: number;
    /** Idling is modelled from incidents, which stop earlier than the
     *  emissions table. Stated rather than silently mixed. */
    incidentsFrom: string | null;
    incidentsTo: string | null;
    incidentsCounted: number;
  };
};

const LOCAL_DATE = `timestamp_utc::date`;

const cache = new Map<string, { at: number; data: PrescriptiveResult }>();
const TTL_MS = 10 * 60 * 1000;

/* The idling factor from emissions.service.ts is a live Climatiq call, and an
   optimiser must not make one per candidate. Climatiq returns ~0.192 kg
   CO2e/km for a petrol car; the service scales by 0.10 for the idling
   equivalent, giving kg per vehicle-minute of standstill. Held as a constant
   so a run is reproducible and costs no API quota — if the factor is ever
   re-sourced, change it here and say so in the assumptions. */
const IDLING_KG_PER_VEHICLE_MINUTE = 0.0192;

/** Per the warehouse's own factor table. Kept for the counterfactual: what a
 *  displaced heavy vehicle-km would emit if it moved to the medium class. */
const F_HEAVY = 1492;
const F_MEDIUM = 354;

async function resolveWindow(filters: PrescriptiveFilters) {
  const bounds = await db!.query(
    `SELECT min(${LOCAL_DATE})::text AS lo, max(${LOCAL_DATE})::text AS hi FROM nlex_theoretical_emissions`,
  );
  const minDate: string = bounds.rows[0].lo;
  const maxDate: string = bounds.rows[0].hi;

  if (filters.from && filters.to) {
    const [f, t] = filters.from <= filters.to ? [filters.from, filters.to] : [filters.to, filters.from];
    return { lo: f < minDate ? minDate : f, hi: t > maxDate ? maxDate : t };
  }
  // Same anchoring as getEmissionsAnalyticsFromDb, so the Range control means
  // the same thing on this tab's Prescriptive view as on its Descriptive one.
  const anchor = "2025-01-01";
  const lo = anchor < minDate ? minDate : anchor > maxDate ? minDate : anchor;
  if (filters.months === "all") return { lo, hi: maxDate };
  const { rows } = await db!.query(
    `SELECT LEAST(($1::date + ($2 || ' months')::interval)::date, $3::date)::text AS hi`,
    [lo, filters.months, maxDate],
  );
  return { lo, hi: rows[0].hi as string };
}

export async function getPrescriptiveStrategies(
  filters: PrescriptiveFilters,
): Promise<PrescriptiveResult | null> {
  if (!db) return null;

  const key = JSON.stringify(filters);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const { lo, hi } = await resolveWindow(filters);
  const params = [lo, hi];
  const WHERE = `${LOCAL_DATE} BETWEEN $1 AND $2`;

  const [totals, heavy, hourly, bands, incidentSpan] = await Promise.all([
    // The denominator every reduction is expressed against.
    db.query(
      `SELECT COALESCE(SUM(co2_grams),0) / 1e6            AS co2_tonnes,
              COALESCE(SUM(volume * segment_distance_km),0) AS vkm
         FROM nlex_theoretical_emissions
        WHERE ${WHERE} AND co2_grams IS NOT NULL AND co2_grams::text <> 'NaN'`,
      params,
    ),
    // Strategy A's raw material: heavy vehicle-km in this window.
    db.query(
      `SELECT COALESCE(SUM(volume * segment_distance_km) FILTER (WHERE vehicle_class = 3),0) AS heavy_vkm,
              COALESCE(SUM(volume * segment_distance_km),0)                                  AS all_vkm
         FROM nlex_theoretical_emissions
        WHERE ${WHERE} AND co2_grams IS NOT NULL AND co2_grams::text <> 'NaN'`,
      params,
    ),
    /* Strategy C's weight: how many vehicles an incident actually exposes.
       An incident blocks ONE exit-segment in ONE direction, so the corridor
       total divided by the number of exit-direction pairs is the right
       exposure. Using the corridor figure overstated a single 6-hour incident
       at 1,912 tonnes — more vehicles trapped than use the whole corridor in
       half a day. Divisors come from the data, not a hardcoded 10 x 2. */
    db.query(
      `SELECT EXTRACT(hour FROM timestamp_utc)::int AS hr,
              COALESCE(SUM(volume),0)::float
                / NULLIF(COUNT(DISTINCT ${LOCAL_DATE}),0)
                / NULLIF(COUNT(DISTINCT exit_id),0)
                / NULLIF(COUNT(DISTINCT direction),0) AS veh_per_hour_segment
         FROM nlex_theoretical_emissions
        WHERE ${WHERE}
        GROUP BY 1 ORDER BY 1`,
      params,
    ),
    /* Strategies B and C. Bands rather than one mean because clearance is
       heavily right-skewed (median 5 min, p90 59) and idling goes as the
       square, so the tail carries almost all of the cost. The p10 within each
       band is the floor: the corridor's own demonstrated best, which is why
       this strategy is evidence-bounded and Strategy A is not. */
    db.query(
      `WITH b AS (
         SELECT CASE WHEN clearance_min <  15 THEN 'under15'
                     WHEN clearance_min <  60 THEN 'to60'
                     WHEN clearance_min < 180 THEN 'to180'
                     ELSE                          'over180' END AS band,
                clearance_min,
                EXTRACT(hour FROM event_start_date)::int AS hr
           FROM silver.nlex_accident_events_clean
          WHERE clearance_min IS NOT NULL AND clearance_min > 0
            AND event_start_date::date BETWEEN $1 AND $2)
       SELECT band, hr, COUNT(*)::int AS events,
              AVG(clearance_min)::float AS mean_min,
              PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY clearance_min)::float AS p10_floor
         FROM b GROUP BY 1, 2`,
      params,
    ),
    db.query(
      `SELECT MIN(event_start_date)::date::text AS lo, MAX(event_start_date)::date::text AS hi,
              COUNT(*)::int AS n
         FROM silver.nlex_accident_events_clean
        WHERE clearance_min IS NOT NULL AND clearance_min > 0
          AND event_start_date::date BETWEEN $1 AND $2`,
      params,
    ),
  ]);

  const actualTonnes = Number(totals.rows[0]?.co2_tonnes ?? 0);
  const heavyVkm = Number(heavy.rows[0]?.heavy_vkm ?? 0);
  const allVkm = Number(heavy.rows[0]?.all_vkm ?? 0);

  const vehPerDayByHour = new Map<number, number>();
  for (const r of hourly.rows) vehPerDayByHour.set(Number(r.hr), Number(r.veh_per_hour_segment ?? 0));

  /* ── A. Fleet mix ───────────────────────────────────────────────────────
     Displacing one heavy vehicle-km does not delete the trip, it moves the
     freight to the next class down, so the saving is the DIFFERENCE between
     the factors, not the whole heavy factor. Assuming the whole 1492 g/km
     disappears would roughly double the answer. */
  const deltaPp = Math.max(0, Math.min(filters.heavyShiftPp ?? 1, 4.2));
  const shiftedVkm = allVkm * (deltaPp / 100);
  const cappedShiftVkm = Math.min(shiftedVkm, heavyVkm); // cannot move more heavy than exists
  const fleetTonnes = (cappedShiftVkm * (F_HEAVY - F_MEDIUM)) / 1e6;

  /* ── B and C. Idling ────────────────────────────────────────────────────
     A queue builds while the incident is live and drains as it clears, so the
     total time lost is the AREA of that triangle:

         vehicle-minutes = lambda x T^2 / 2        lambda = arrivals per minute

     The /2 matters. emissions.service.ts's calculateRow() uses lambda x T^2,
     which charges every vehicle the full delay — true only if the queue never
     discharges. Combined with the corridor-wide exposure it was using, that
     ran 40x high. Still quadratic in T, which is the point: halving a 60-minute
     incident saves four times what halving a 30-minute one does. */
  const idleKg = (vehPerHourSegment: number, minutes: number) =>
    ((vehPerHourSegment / 60) * minutes * minutes) / 2 * IDLING_KG_PER_VEHICLE_MINUTE;

  let baselineIdleKg = 0;
  let clearanceIdleKg = 0;
  let peakWeightedIdleKg = 0;

  // Strategy C reallocates a fixed capacity, so it can only improve the hours
  // it is pointed at. Pointed at the busiest half of the day — where a saved
  // minute traps the most vehicles — and deliberately NOT at the rest.
  const hoursByLoad = [...vehPerDayByHour.entries()].sort((a, b) => b[1] - a[1]);
  const targetHours = new Set(hoursByLoad.slice(0, 12).map(([h]) => h));

  for (const r of bands.rows) {
    const events = Number(r.events);
    const meanMin = Number(r.mean_min);
    const floorMin = Number(r.p10_floor);
    const hr = Number(r.hr);
    const vehPerHour = vehPerDayByHour.get(hr) ?? 0;

    baselineIdleKg += events * idleKg(vehPerHour, meanMin);
    // B: every band pulled to its own demonstrated p10, corridor-wide.
    clearanceIdleKg += events * idleKg(vehPerHour, floorMin);
    // C: the same floor, but only where the capacity was sent.
    peakWeightedIdleKg += events * idleKg(vehPerHour, targetHours.has(hr) ? floorMin : meanMin);
  }

  const clearanceTonnes = Math.max(0, (baselineIdleKg - clearanceIdleKg) / 1000);
  const deploymentTonnes = Math.max(0, (baselineIdleKg - peakWeightedIdleKg) / 1000);

  const pct = (t: number) => (actualTonnes > 0 ? (t / actualTonnes) * 100 : 0);
  const r2 = (n: number) => Math.round(n * 100) / 100;

  const span = incidentSpan.rows[0];

  const strategies: Strategy[] = [
    {
      key: "clearance",
      label: "Faster incident clearance",
      reductionPct: r2(pct(clearanceTonnes)),
      reductionTonnes: r2(clearanceTonnes),
      lever: "every clearance band pulled to the fastest 10% already achieved in that band",
      evidenceBounded: true,
      assumptions: [
        "Idling is the area of the queue triangle, lambda x T^2 / 2: vehicles join while the incident is live and drain as it clears. Still quadratic in delay, so the long tail dominates.",
        "One incident is taken to affect one exit-segment in one direction, not the whole corridor.",
        "The floor per band is that band's observed 10th percentile, so the target is a response time this corridor has already delivered.",
        `Idling factor ${IDLING_KG_PER_VEHICLE_MINUTE} kg CO2 per vehicle-minute, from Climatiq's petrol-car factor scaled as in emissions.service.ts.`,
        "Incident records end before the emissions table does; the window is stated in basis.",
        "Tail-dominated, so short Ranges are volatile: about 1.5% of incidents run over three hours and, because the cost is quadratic, they carry most of it. Q1 2025 held 1.09% such incidents against 1.72% across the rest of that year, which alone moves the per-incident figure threefold. Read a 3-month window as indicative.",
      ],
    },
    {
      key: "deployment",
      label: "Response capacity at the busiest hours",
      reductionPct: r2(pct(deploymentTonnes)),
      reductionTonnes: r2(deploymentTonnes),
      lever: "same total capacity, concentrated on the 12 hours with the most vehicles exposed",
      evidenceBounded: true,
      assumptions: [
        "Reallocation, not extra resourcing: the hours outside the target keep their current clearance times.",
        "A minute saved at 17:00 traps roughly ten times the vehicles of a minute saved at 02:00, which is the entire reason this differs from the strategy above.",
        "Always at most as large as faster clearance corridor-wide, since it applies the same floor to fewer hours.",
      ],
    },
    {
      key: "fleet_mix",
      label: `Heavy-vehicle share down ${deltaPp} pp`,
      reductionPct: r2(pct(fleetTonnes)),
      reductionTonnes: r2(fleetTonnes),
      lever: `${deltaPp} pp of Class-3 vehicle-km moved to Class 2 — a policy target, not an observed change`,
      evidenceBounded: false,
      assumptions: [
        "NOT bounded by evidence. Class-3 share moved only between 4.172% and 4.242% across 54 months, a spread of 0.037 pp, so nothing in the record shows a shift of this size is achievable.",
        "The freight still moves: the saving is the gap between the heavy and medium factors (1492 - 354 g/km), not the whole heavy factor.",
        "Linear in the shift, so the figure doubles if the target doubles. Read it as a sensitivity.",
      ],
    },
  ];

  const data: PrescriptiveResult = {
    strategies,
    basis: {
      from: lo,
      to: hi,
      actualCo2Tonnes: r2(actualTonnes),
      incidentsFrom: span?.lo ?? null,
      incidentsTo: span?.hi ?? null,
      incidentsCounted: Number(span?.n ?? 0),
    },
  };

  cache.set(key, { at: Date.now(), data });
  return data;
}
