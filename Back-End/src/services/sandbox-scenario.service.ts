import {
  getMLPredictiveVolume,
  getMLModelMetrics,
  getEmissionForecast,
  getTrafficAnalyticsFromDb,
} from "./traffic.service.js";
import {
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

   Only dates every module actually forecasts are offered. The horizons differ —
   volume and emissions store 90 future days, incidents 28 — and a picker that
   offered a date two of the three could not speak to would produce a scenario
   half-seeded from a forecast and half from a default, with nothing on screen
   saying which.

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

export type ScenarioContext = {
  date: string;
  /** Every date all three modules forecast. The picker offers only these. */
  availableDates: string[];
  volume: {
    /** Corridor-wide daily total the champion predicts for this date. */
    dailyVehicles: number | null;
    /** Busiest plaza's share of corridor volume, used to load one segment. */
    segmentSharePct: number | null;
    segmentName: string | null;
    /** Derived arrival rate for the simulation, already clamped to its range. */
    peakHourInflow: number | null;
    clamped: boolean;
    model: string | null;
    wmape: number | null;
  };
  incidents: {
    /** Corridor-wide expected incidents on this date. */
    predictedForDate: number | null;
    model: string | null;
    /**
     * Expected incidents at each exit ON THIS DATE — the module publishes an
     * apportionment over its whole horizon, divided here by the horizon length
     * so the figure beside a one-day scenario is a one-day figure.
     */
    byExit: { exitName: string; km: number; perDay: number }[];
    horizonDays: number;
  };
  emissions: {
    predictedTonnes: number | null;
    model: string | null;
    wmape: number | null;
  };
  /** Set when a module forecasts the date but stored no value for it. */
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

  if (!volumes || !emissions || !incidents) return null;

  // ── the dates all three can speak to ────────────────────────────────────────
  const volFuture = new Map<string, any>();
  for (const r of volumes as any[]) if (r.is_future) volFuture.set(iso(r.date), r);

  const emiFuture = new Map<string, any>();
  for (const r of (emissions as any).series ?? []) {
    if (r.zone === "future") emiFuture.set(iso(r.date), r);
  }

  const incFuture = new Map<string, any>();
  for (const r of (incidents as any).daily ?? []) {
    if (r.predictionType === "future") incFuture.set(iso(r.date), r);
  }

  const availableDates = [...volFuture.keys()]
    .filter((d) => emiFuture.has(d) && incFuture.has(d))
    .sort();

  if (availableDates.length === 0) return null;

  const chosen = date && availableDates.includes(date) ? date : availableDates[0];
  const notes: string[] = [];

  // ── volume ──────────────────────────────────────────────────────────────────
  const champion = (metrics ?? []).find((m) => m.accepted && m.wmape != null) ?? null;
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
    notes.push("The volume champion stored no prediction for this date.");
  }

  // ── incidents ───────────────────────────────────────────────────────────────
  const iRow = incFuture.get(chosen);
  const horizonDays = Math.max(1, Number((incidents as any).corridorForecastDays) || incFuture.size);
  const byExit = ((incidents as any).corridorForecast ?? [])
    .map((x: any) => ({
      exitName: String(x.exitName),
      km: Number(x.km),
      // The published figure covers the whole horizon; a one-day scenario needs
      // a one-day number.
      perDay: Number(x.predictedIncidents) / horizonDays,
    }))
    .sort((a: any, b: any) => b.perDay - a.perDay);

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
      clamped,
      model: champion?.model ?? null,
      wmape: champion?.wmape ?? null,
    },
    incidents: {
      predictedForDate: iRow?.predicted != null ? Number(iRow.predicted) : null,
      model: (incidents as any).summary?.championModel ?? null,
      byExit,
      horizonDays,
    },
    emissions: {
      predictedTonnes: eRow?.predicted != null ? Number(eRow.predicted) : null,
      model: eChampion,
      wmape: eMetric?.wmape ?? null,
    },
    notes,
  };
}
