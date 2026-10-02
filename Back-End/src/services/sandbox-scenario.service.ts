import { db } from "../config/db.js";
import {
  getMLPredictiveVolume,
  getMLPredictiveVolumeHourly,
  getMLModelMetrics,
  getEmissionForecast,
  getTrafficAnalyticsFromDb,
} from "./traffic.service.js";
import {
  getIncidentHourlyFromDb,
  getIncidentPredictiveFromDb,
  getIncidentPredictiveAnchors,
} from "./incident.service.js";

/* ══════════════════════════════════════════════════════════════════════════════
   SCENARIO CONTEXT — THE PRESCRIPTIVE JOIN

   The three predictive modules each answer "what will happen" for their own
   quantity. The sandbox answers "what should we do about it". This is the seam:
   it takes one forecast date and returns what all three modules expect for that
   day, so a simulation can start from a predicted Tuesday rather than from an
   annual average.

   The dates offered are the ones the VOLUME and EMISSION forecasts both cover,
   because the volume forecast is what actually seeds the simulation. The
   horizons differ — volume and emissions store 90 future days, incidents
   currently 28 — so a date past the incident horizon is still offered, but its
   incident figures are returned as absent (covered: false) with a note saying
   so. They are never filled from a default or stretched from another date:
   a scenario is seeded only from what a model actually forecast for that day.
   When the incident model's horizon grows, the covered range grows with it.

   Nothing here decides policy. It reports what was forecast and how accurate
   each forecast has been; the operator decides what to simulate against it.
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Daily corridor total to peak-hour arrivals AT ONE SEGMENT.
 *
 * Two conversions, and the second one matters more than it looks.
 *
 * 1.6 is the peak-hour factor: the busiest hour carries more than 1/24th of the
 * day. It matches what the AI Sandbox page already used.
 *
 * The segment share is the part the page got wrong. `totalVolume` counts every
 * vehicle once, at whichever of the ~19 plazas it entered — it is a corridor
 * total, not a flow past a point. Feeding it whole into a single 4-lane stretch
 * implied 23,000 vehicles/hour, which is roughly three times what four lanes can
 * physically carry (~2,000/lane/hour), so the simulation simply saturated and
 * every scenario looked identically gridlocked regardless of the forecast.
 *
 * Without an origin-destination matrix the honest approximation is the busiest
 * plaza's share of corridor volume — the load at the heaviest point on the road,
 * which is where a closure is worth simulating. The share used is returned in
 * the payload so the assumption is visible rather than buried here.
 */
const PEAK_HOUR_FACTOR = 1.6;

/** Bounds the sandbox simulation accepts. Mirrors the page's own inflow slider. */
const INFLOW_MIN = 500;
const INFLOW_MAX = 12_000;
/**
 * Floor for a single hour's inflow. A quiet hour really is a fraction of the peak, so the peak's floor
 * (INFLOW_MIN) would overstate 03:00 several times over; this only keeps the engine from being asked for none.
 */
const HOURLY_INFLOW_MIN = 100;

export type ScenarioContext = {
  date: string;
  /** Every date the volume and emission forecasts both cover. The picker offers only these. */
  availableDates: string[];
  volume: {
    /** Corridor-wide daily total the champion predicts for this date. */
    dailyVehicles: number | null;
    /** Busiest plaza's share of corridor volume, used to load one segment. */
    segmentSharePct: number | null;
    segmentName: string | null;
    /** Derived arrival rate for the simulation, already clamped to its range. */
    peakHourInflow: number | null;
    /**
     * Corridor-wide vehicles the champion predicts for each hour (0-23) of this date: the Traffic page's own
     * hourly drill-down for the same model — the day's prediction spread over this weekday's typical shape.
     * Null when no hourly shape exists for the date.
     */
    hourly: (number | null)[] | null;
    /** `hourly` at one segment (× segmentSharePct), the arrival rate the simulation runs at that hour. */
    hourlyInflow: (number | null)[] | null;
    clamped: boolean;
    model: string | null;
    wmape: number | null;
  };
  incidents: {
    /** Whether the incident model forecasts THIS date. When false, every figure below is empty. */
    covered: boolean;
    /** Last date the incident model forecasts, or null if its forecast is unavailable. */
    coverageEnd: string | null;
    /** Corridor-wide expected incidents on this date. */
    predictedForDate: number | null;
    model: string | null;
    /**
     * Expected incidents at each exit ON THIS DATE — the module publishes an
     * apportionment over its whole horizon, divided here by the horizon length
     * so the figure beside a one-day scenario is a one-day figure. Empty for a
     * date outside that horizon: the apportionment describes those 28 days, not
     * any later one.
     */
    byExit: { exitName: string; km: number; perDay: number }[];
    horizonDays: number;
    /**
     * Whole incidents the champion expects in each hour (0-23) of this date, corridor-wide: the Incident
     * page's own hourly drill-down for the same model. That model predicts a daily count only, so this is
     * the day spread over the weekday's typical shape and rounded — a derived curve, as that page labels it.
     * Null when the date is outside the incident horizon or no shape exists.
     */
    hourly: number[] | null;
    hourlyModel: string | null;
  };
  emissions: {
    predictedTonnes: number | null;
    model: string | null;
    wmape: number | null;
  };
  /**
   * The fleet-mix model's forecast Class 1 / 2 / 3 shares for this date (fractions summing to 1), which is what
   * sets the mix of vehicles the road runs. That model's horizon is 7 days against the volume model's ~90, so most
   * dates have none: null, and the road keeps the observed hourly mix rather than borrowing another day's.
   */
  fleet: { c1: number; c2: number; c3: number; heavyShare: number; heavySurge: boolean; model: string | null } | null;
  /** Set when a module forecasts the date but stored no value for it, or does not forecast it. */
  notes: string[];
};

/**
 * Calendar date on the corridor, as Asia/Manila.
 *
 * The three modules do not agree on a type. gold.ml_predictive_volume stores a
 * timestamp — midnight Manila, which is 16:00Z the day BEFORE — while the
 * incident and emission series return plain "YYYY-MM-DD" strings. Formatting the
 * timestamp naively gave "Wed Dec 31" and, once that was fixed, taking its UTC
 * date would still have named the previous day and matched nothing.
 *
 * Shifting by +8h before reading the UTC parts lands on the same day the charts
 * label, without depending on the server's own timezone.
 */
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

const iso = (value: unknown): string => {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
};

const readableDay = (isoDay: string) =>
  new Date(`${isoDay}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

/**
 * gold.ml_predictive_fleet_mix is written by the fleet-mix training script, and no API route serves it, so it is read
 * here. Absent table, absent day, or shares that do not form a composition all give null — never a default mix.
 */
async function getFleetMixForDate(date: string): Promise<ScenarioContext["fleet"]> {
  if (!db) return null;
  try {
    const { rows } = await db.query(
      `SELECT pred_c1::float AS c1, pred_c2::float AS c2, pred_c3::float AS c3,
              heavy_pred::float AS heavy, heavy_surge, champion_model
       FROM gold.ml_predictive_fleet_mix
       WHERE forecast_date = $1::date AND pred_c1 IS NOT NULL AND pred_c2 IS NOT NULL AND pred_c3 IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`,
      [date],
    );
    const r = rows[0];
    if (!r) return null;
    const sum = r.c1 + r.c2 + r.c3;
    if (![r.c1, r.c2, r.c3].every((v) => Number.isFinite(v) && v >= 0) || Math.abs(sum - 1) > 0.02) return null;
    return {
      c1: r.c1 / sum,
      c2: r.c2 / sum,
      c3: r.c3 / sum,
      heavyShare: (r.c2 + r.c3) / sum,
      heavySurge: Boolean(r.heavy_surge),
      model: r.champion_model ?? null,
    };
  } catch {
    return null;
  }
}

export async function getScenarioContext(date?: string): Promise<ScenarioContext | null> {
  const anchors = await getIncidentPredictiveAnchors();

  const [volumes, metrics, emissions, incidents, analytics] = await Promise.all([
    getMLPredictiveVolume({ months: "all" }),
    getMLModelMetrics("80_20"),
    getEmissionForecast(),
    // "all" weather: the scenario picker does not filter by weather, so the
    // unfiltered forecast is the right one to seed from.
    anchors ? getIncidentPredictiveFromDb({ weather: "all" }, anchors) : Promise.resolve(null),
    getTrafficAnalyticsFromDb({ months: "12" }),
  ]);

  // Volume seeds the simulation and emissions define the offered range, so
  // both are required. Incidents are not: a missing incident forecast leaves
  // those figures empty rather than taking the whole panel down.
  if (!volumes || !emissions) return null;

  // ── the dates on offer ──────────────────────────────────────────────────────
  const volFuture = new Map<string, any>();
  for (const r of volumes as any[]) if (r.is_future) volFuture.set(iso(r.date), r);

  const emiFuture = new Map<string, any>();
  for (const r of (emissions as any).series ?? []) {
    if (r.zone === "future") emiFuture.set(iso(r.date), r);
  }

  const incFuture = new Map<string, any>();
  for (const r of (incidents as any)?.daily ?? []) {
    if (r.predictionType === "future") incFuture.set(iso(r.date), r);
  }
  const incDates = [...incFuture.keys()].sort();
  const coverageEnd = incDates.length > 0 ? incDates[incDates.length - 1] : null;

  const availableDates = [...volFuture.keys()].filter((d) => emiFuture.has(d)).sort();

  if (availableDates.length === 0) return null;

  const chosen = date && availableDates.includes(date) ? date : availableDates[0];
  const notes: string[] = [];

  // ── volume ──────────────────────────────────────────────────────────────────
  /* The best model available, preferring an accepted one.
   *
   * This used to REQUIRE `accepted`, and since the honest retrain every volume
   * model fails the MASE gate — none beats a seasonal-naive baseline. So
   * `champion` was always null, the column was never read, and the panel
   * refused to load a day whose forecast was sitting right there: Prophet has
   * 354,854 vehicles stored for 2026-01-21.
   *
   * Refusing to seed a what-if sandbox because the forecast is imperfect is
   * not a choice to make on the operator's behalf. The best-ranked model is
   * used and the rejection is REPORTED instead — the same call the traffic
   * optimiser makes. */
  const accepted = (metrics ?? []).find((m) => m.accepted && m.wmape != null) ?? null;
  const champion = accepted ?? (metrics ?? []).find((m) => m.wmape != null) ?? null;
  const vRow = volFuture.get(chosen);

  // Read the champion's own column rather than a fixed one, so a retrain that
  // changes the winner changes what the sandbox is seeded from.
  const COLUMN: Record<string, string> = {
    Prophet: "pred_prophet",
    LSTM: "pred_lstm",
    HoltWinters: "pred_holtwinters",
    SARIMAX: "pred_sarimax",
    Holts_Linear: "pred_holts_linear",
    Prophet_nw: "pred_prophet_nw",
    SARIMAX_nw: "pred_sarimax_nw",
    LSTM_nw: "pred_lstm_nw",
  };
  const col = champion ? COLUMN[champion.model] : undefined;
  const rawDaily = col && vRow?.[col] != null ? Number(vRow[col]) : null;

  // Busiest plaza's share of corridor volume. Falls back to an even split
  // across the plazas if the breakdown is unavailable, rather than silently
  // reverting to the whole-corridor figure that saturates the simulation.
  const byPlaza: any[] = (analytics as any)?.byPlaza ?? [];
  const plazaTotal = byPlaza.reduce((sum, p) => sum + Number(p.v || 0), 0);
  const busiest = byPlaza.reduce(
    (best, p) => (Number(p.v || 0) > Number(best?.v || 0) ? p : best),
    byPlaza[0],
  );
  const segmentShare =
    plazaTotal > 0 && busiest
      ? Number(busiest.v) / plazaTotal
      : byPlaza.length > 0
        ? 1 / byPlaza.length
        : null;
  const segmentName = busiest ? String(busiest.plaza) : null;

  if (segmentShare == null) {
    notes.push(
      "The per-plaza breakdown was unavailable, so the segment load could not be apportioned from the corridor total.",
    );
  }

  let peakHourInflow: number | null = null;
  let clamped = false;
  /* Seeded from a model that was rejected — said plainly rather than hidden.
     The operator should know the level is indicative before they build a
     scenario on it. */
  if (champion != null && accepted == null) {
    notes.push(
      `${champion.model} is the best-ranked volume model but did NOT pass its acceptance gate: it does not beat a seasonal-naive baseline on MASE. The scenario is seeded from it anyway — treat the level as indicative.`,
    );
  }
  if (rawDaily != null && Number.isFinite(rawDaily) && segmentShare != null) {
    const raw = Math.round(((rawDaily * segmentShare) / 24) * PEAK_HOUR_FACTOR);
    peakHourInflow = Math.min(INFLOW_MAX, Math.max(INFLOW_MIN, raw));
    clamped = peakHourInflow !== raw;
    if (clamped) {
      notes.push(
        `The forecast implies ${raw.toLocaleString("en-US")} vehicles/hour at peak, outside the simulation's ${INFLOW_MIN}-${INFLOW_MAX} range; it has been clamped.`,
      );
    }
  } else if (rawDaily == null) {
    /* Say which of the two it actually is. "The champion stored no prediction"
       was reported for BOTH a missing row and a missing champion, and it was
       always the second — which sent the reader hunting for absent data that
       was never absent. */
    notes.push(
      champion == null
        ? "No volume model has usable metrics, so corridor volume could not be seeded."
        : `The ${champion.model} forecast has no row for this date.`,
    );
  }

  // ── incidents ───────────────────────────────────────────────────────────────
  const covered = incFuture.has(chosen);
  const iRow = incFuture.get(chosen);
  const horizonDays = Math.max(1, Number((incidents as any)?.corridorForecastDays) || incFuture.size);
  const byExit = covered
    ? ((incidents as any)?.corridorForecast ?? [])
        .map((x: any) => ({
          exitName: String(x.exitName),
          km: Number(x.km),
          // The published figure covers the whole horizon; a one-day scenario
          // needs a one-day number.
          perDay: Number(x.predictedIncidents) / horizonDays,
        }))
        .sort((a: any, b: any) => b.perDay - a.perDay)
    : [];

  if (!covered) {
    notes.push(
      coverageEnd
        ? `No incident forecast for this date — the incident model currently forecasts through ${readableDay(coverageEnd)}. Traffic and CO₂ are still forecast; place incidents yourself to test a response.`
        : "The incident forecast is unavailable, so no incident figures are shown. Traffic and CO₂ are still forecast.",
    );
  }

  // ── the hour ────────────────────────────────────────────────────────────────
  // The Traffic and Incident pages each draw this date hour by hour. Reading the same functions with the
  // same model is what makes the sandbox show the figures those pages show, rather than a copy of their
  // logic that can drift. Either can be missing (no weekday shape, outside the incident horizon), and
  // then the field is null — never a number borrowed from another hour or day.
  const [hourlyVol, hourlyInc, fleet] = await Promise.all([
    champion && rawDaily != null && col ? getMLPredictiveVolumeHourly(chosen, champion.model, "all") : Promise.resolve(null),
    covered ? getIncidentHourlyFromDb(chosen) : Promise.resolve(null),
    getFleetMixForDate(chosen),
  ]);
  if (!fleet) {
    notes.push(
      "No fleet-mix forecast for this date (that model forecasts about a week ahead), so the vehicle mix on the road is the observed mix for the chosen hour.",
    );
  }
  const hourly = hourlyVol?.hours.some((h) => h.predicted != null) ? hourlyVol.hours.map((h) => h.predicted) : null;
  const hourlyInflow =
    hourly && segmentShare != null
      ? hourly.map((v) => (v == null ? null : Math.min(INFLOW_MAX, Math.max(HOURLY_INFLOW_MIN, Math.round(v * segmentShare)))))
      : null;
  const incChampion = (hourlyInc as any)?.models?.find((m: any) => m.isChampion) ?? null;
  const incHourly: number[] | null =
    incChampion && Array.isArray(incChampion.hours) && incChampion.hours.every((v: unknown) => typeof v === "number")
      ? (incChampion.hours as number[])
      : null;

  // ── emissions ───────────────────────────────────────────────────────────────
  const eRow = emiFuture.get(chosen);
  const eChampion = (emissions as any).championModel ?? null;
  const eMetric = ((emissions as any).metrics ?? []).find((m: any) => m.model === eChampion) ?? null;

  return {
    date: chosen,
    availableDates,
    volume: {
      dailyVehicles: rawDaily,
      segmentSharePct: segmentShare != null ? segmentShare * 100 : null,
      segmentName,
      peakHourInflow,
      hourly,
      hourlyInflow,
      clamped,
      model: champion?.model ?? null,
      wmape: champion?.wmape ?? null,
    },
    incidents: {
      covered,
      coverageEnd,
      predictedForDate: covered && iRow?.predicted != null ? Number(iRow.predicted) : null,
      model: (incidents as any)?.summary?.championModel ?? null,
      byExit,
      horizonDays,
      hourly: incHourly,
      hourlyModel: incHourly ? String(incChampion.key) : null,
    },
    emissions: {
      predictedTonnes: eRow?.predicted != null ? Number(eRow.predicted) : null,
      model: eChampion,
      wmape: eMetric?.wmape ?? null,
    },
    fleet,
    notes,
  };
}
