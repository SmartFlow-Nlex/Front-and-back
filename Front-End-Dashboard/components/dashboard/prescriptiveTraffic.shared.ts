/* Shared data access and decision logic for the Traffic Prescriptive tab.
 *
 * All three panels are solutions FOR the Predictive tab's own numbers, so they
 * read the one payload that tab already produces -- /api/traffic/forecast
 * carries volumes, congestion and events together -- rather than each modelling
 * its own view of the future. A panel that disagreed with the forecast printed
 * one row above it would be worse than no panel.
 *
 * The fetch is shared and cached at module scope so mounting three panels costs
 * one request, not three. The Predictive tab's congestion and event cards
 * read from it too: the payload is ~600 KB, and each used to fetch it
 * separately within the same second.
 */

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

export type VolumeRow = {
  date: string;
  actual_volume: number | null;
  is_future: boolean;
  is_holdout: boolean;
  pred_prophet: number | null;
  pred_holtwinters: number | null;
  pred_sarimax: number | null;
  pred_lstm: number | null;
  pred_holts_linear: number | null;
};

export type CongestionRow = {
  segment: string;
  hours: number;
  state: string;
  probability: string | number;
  baseTs: string;
  /** Measured km (Balintawak = 12); show it through fmtKm, never raw. */
  km: number;
};

export type EventRow = {
  exit: string;
  event: string;
  baseline: number;
  surge: number;
  uplift: string | number;
  upliftLo: string | number;
  upliftHi: string | number;
  nEvents: number;
  material: boolean;
  anchorExit: string;
};

export type UpcomingEventExit = {
  exit: string; baseline: number; surge: number; surgeLo: number; surgeHi: number;
  uplift: number; nEvents: number;
};
export type UpcomingEvent = {
  date: string; title: string; isDerived: boolean; capacity: number | null;
  venue: string | null;
  exits: UpcomingEventExit[];
};

export type ForecastPayload = {
  championModel: string | null;
  mlConfidence: number | null;
  volumes: VolumeRow[];
  congestion: CongestionRow[];
  events: EventRow[];
  upcomingEvents: UpcomingEvent[];
  /* The rest of the payload, untyped here, so the Predictive cards can share
     this one fetch instead of each making their own. The congestion and event
     cards read congestionModel, congestionHorizonAccuracy and
     eventSurgeMetrics from it; they own those shapes. */
  extras: Record<string, unknown>;
};

/* The calendar day a forecast row is FOR.
   Rows arrive as ISO instants: a Manila midnight serialises as 16:00Z the
   evening before, so slicing the string to ten characters names the wrong
   day for every row. The corridor's days are Manila days, so the conversion is
   pinned to that zone rather than the browser's, and gives the same answer on
   any machine. */
export function manilaDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? String(value).slice(0, 10)
    : d.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* The champion is whichever model the training run accepted and ranked first;
   the API already resolves it. Reading a named column keeps the panels on the
   same series the Predictive chart draws. */
export function championValue(row: VolumeRow, champion: string | null): number | null {
  const key = (champion ?? "Prophet").toLowerCase().replace(/[^a-z]/g, "");
  const map: Record<string, keyof VolumeRow> = {
    prophet: "pred_prophet",
    holtwinters: "pred_holtwinters",
    sarimax: "pred_sarimax",
    lstm: "pred_lstm",
    holtslinear: "pred_holts_linear",
  };
  const col = map[key] ?? "pred_prophet";
  return num(row[col]);
}

let cache: Promise<ForecastPayload> | null = null;

/* Retried before giving up (17 Oct 2026, testers TR-12): right after the backend starts, the first
   request can fail or time out while the database wakes up, and the panel used to sit on that error
   until the page was reloaded. Three tries, 3 s then 8 s apart, cover a cold start. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- callers each read their own payload shape off the result
export async function fetchJsonWithRetry(url: string, label: string, tries = 3): Promise<any> {
  const waits = [3000, 8000];
  let last: unknown = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      last = new Error(`${label} ${r.status}`);
      if (r.status >= 400 && r.status < 500) break; // a bad request will not get better by asking again
    } catch (e) {
      last = e;
    }
    if (i < tries - 1) await new Promise((res) => setTimeout(res, waits[i] ?? 8000));
  }
  throw last instanceof Error ? last : new Error(`${label} failed`);
}

export function loadForecast(): Promise<ForecastPayload> {
  if (!cache) {
    // No cache:"no-store" -- the server now sets a cache and gzips, and the
    // browser is allowed to keep the response for the same reasons.
    cache = fetchJsonWithRetry(`${BACKEND}/api/traffic/forecast?months=all`, "forecast")
      .then((j) => {
        const d = j?.data ?? {};
        return {
          championModel: d.championModel ?? null,
          mlConfidence: num(d.mlConfidence),
          volumes: Array.isArray(d.volumes) ? d.volumes : [],
          congestion: Array.isArray(d.congestion) ? d.congestion : [],
          events: Array.isArray(d.events) ? d.events : [],
          upcomingEvents: Array.isArray(d.upcomingEvents) ? d.upcomingEvents : [],
          extras: d,
        } as ForecastPayload;
      })
      .catch((e) => {
        // A failed fetch must not be cached, or every later mount replays it.
        cache = null;
        throw e;
      });
  }
  return cache;
}

/* ------------------------------------------------------ server-side ----
 *
 * Staffing priority and congestion response run in the backend against the
 * warehouse (traffic-prescriptive.service.ts); these types mirror its answer.
 * Since 2 Nov 2026 every figure in it is measured: no booth counts, no
 * throughput dial, no hand-set fuzzy thresholds.
 */
export type StaffingLevel = "above" | "likely" | "normal";
export type StaffingHour = {
  hour: number;
  /** Vehicles forecast at this plaza in this hour. */
  forecast: number;
  /** 80% band from the measured held-out error; null where none is measured. */
  low: number | null;
  high: number | null;
  /** The plaza's median for this hour and day type over the latest 12 months, and its 90th percentile. */
  usual: number | null;
  usualPeak: number | null;
  /** forecast / usual; 1 = a usual day. */
  load: number | null;
  /** Measured chance the actual exceeds the usual peak. */
  chance: number | null;
  level: StaffingLevel;
};
export type StaffingPlazaDay = {
  plaza: string;
  sharePct: number;
  peakHour: number;
  /** The hour most likely to exceed its usual peak. */
  top: StaffingHour | null;
  aboveHours: number;
  likelyHours: number;
  /** All 24 hours on the first day only. */
  hours: StaffingHour[];
};
export type StaffingDay = {
  date: string;
  dayType: "weekday" | "weekend";
  corridorForecast: number;
  aboveCells: number;
  likelyCells: number;
  plazas: StaffingPlazaDay[];
};
export type StaffingPriority = StaffingHour & { date: string; dayType: "weekday" | "weekend"; plaza: string };
export type CongestionAdvice = {
  segment: string;
  /** Measured km (Balintawak = 12); show it through fmtKm, never raw. */
  km: number | null;
  /** Highest chance of High in hours 1-12, and its hour. */
  probability: number;
  hoursAhead: number;
  /** First hour at or above the calibrated cut-off. */
  firstAct: number | null;
  label: "Act" | "Monitor";
  action: string;
  /** Of archived forecasts at or above this probability, the share High followed, and how many. */
  hitRate: number | null;
  hitN: number;
};
export type CongestionCalibration = {
  ok: boolean;
  reason: string | null;
  threshold: number | null;
  /** Held out: the last 7 days, which the cut-off never saw. */
  precision: number | null;
  recall: number | null;
  f1: number | null;
  baseRate: number | null;
  fitF1: number | null;
  scored: number;
  scoredHigh: number;
  runs: number;
  fitFrom: string | null;
  fitTo: string | null;
  testFrom: string | null;
  testTo: string | null;
  testRows: number;
};
export type TrafficPrescriptive = {
  champion: { model: string | null; wmapePct: number | null; accepted: boolean };
  basis: {
    usualFrom: string | null;
    usualTo: string | null;
    usualWeekdays: number;
    usualWeekends: number;
    usualPeakPercentile: number;
    plazasProfiled: number;
    forecastFrom: string | null;
    forecastTo: string | null;
    band: { from: string; to: string; days: number; cells: number; wmapePct: number } | null;
    minCellVehicles: number;
  };
  shiftPlan: StaffingDay | null;
  week: StaffingDay[];
  priorities: StaffingPriority[];
  plazasWithoutBand: string[];
  congestion: CongestionAdvice[];
  congestionCalibration: CongestionCalibration | null;
  /** Segments on the exit list with no congestion forecast. */
  congestionMissing: string[];
  /** The congestion forecast could not be read at all (as opposed to read and empty). */
  congestionUnavailable?: boolean;
  /** Manila wall-clock hour the congestion forecast counts from, "YYYY-MM-DD HH:MM". */
  congestionBaseTs?: string | null;
  /** Each segment's chance of High congestion for hours 1-12 (the advisory's timelines). */
  congestionTimeline?: { segment: string; hours: { h: number; pHigh: number }[] }[];
};

/* One answer for both panels: there are no dials, so nothing to key a cache on. */
let prescriptiveCache: Promise<TrafficPrescriptive> | null = null;

export function loadPrescriptive(): Promise<TrafficPrescriptive> {
  if (prescriptiveCache) return prescriptiveCache;
  const req = fetchJsonWithRetry(`${BACKEND}/api/traffic/prescriptive`, "prescriptive")
    .then((j) => {
      if (!j?.success) throw new Error(j?.message ?? "request failed");
      const data = j.data as TrafficPrescriptive;
      /* An answer without congestion rows (the read failed while the server was starting, or the
         hourly model was rewriting its table) is used once but not kept, so the Congestion Response
         panel's retry asks the server again instead of being handed this copy (TR-12). */
      if (!Array.isArray(data?.congestion) || data.congestion.length === 0) prescriptiveCache = null;
      return data;
    })
    .catch((e) => {
      // A failed fetch must not be cached, or every later mount replays it.
      prescriptiveCache = null;
      throw e;
    });
  prescriptiveCache = req;
  return req;
}

/* ------------------------------------------------------ event ranking ----
 *
 * Which exits get event resources first, by the extra vehicles each is SURE
 * to carry: the lower end of the uplift's 95% interval, times the exit's
 * no-event baseline (2 Nov 2026). This replaced a TOPSIS score whose four
 * weights (0.40 / 0.25 / 0.20 / 0.15) were set by hand. Ranking on the lower
 * bound needs no weights and already penalises a loose estimate: a wide
 * interval has a low floor.
 *
 * Only exits with a MATERIAL effect are ranked: the lower bound of the uplift
 * above 1. An exit whose interval reaches 1 has no established event effect.
 */
export type ExitImpact = {
  exit: string;
  /** Extra vehicles over the baseline at the uplift's 95% lower bound, estimate and upper bound. */
  extraLo: number;
  extra: number;
  extraHi: number;
  uplift: number;
  upliftLo: number;
  upliftHi: number;
  nEvents: number;
};
export type RankedExit = ExitImpact & { rank: number };

/** The typical event day, from the event-surge model's per-exit rows. */
export function exitsFromEvents(events: EventRow[]): ExitImpact[] {
  return events.map((e) => {
    const uplift = num(e.uplift) ?? 0;
    const lo = num(e.upliftLo) ?? uplift;
    const hi = num(e.upliftHi) ?? uplift;
    const base = e.baseline ?? 0;
    return {
      exit: e.exit,
      extraLo: Math.round(base * (lo - 1)),
      extra: Math.round((e.surge ?? 0) - base),
      extraHi: Math.round(base * (hi - 1)),
      uplift, upliftLo: lo, upliftHi: hi,
      nEvents: e.nEvents ?? 0,
    };
  });
}

/** One upcoming event: the same uplift applied to that date's weekday-in-month baseline. */
export function exitsFromUpcoming(ev: UpcomingEvent): ExitImpact[] {
  return ev.exits.map((x) => {
    const base = x.baseline || 0;
    return {
      exit: x.exit,
      extraLo: Math.round(x.surgeLo - base),
      extra: Math.round(x.surge - base),
      extraHi: Math.round(x.surgeHi - base),
      uplift: x.uplift,
      upliftLo: base > 0 ? x.surgeLo / base : 0,
      upliftHi: base > 0 ? x.surgeHi / base : 0,
      nEvents: x.nEvents,
    };
  });
}

/** Material exits, most extra vehicles at the lower bound first; ties by the estimate, then name. */
export function rankByLowerBound(rows: ExitImpact[]): RankedExit[] {
  return rows
    .filter((r) => r.upliftLo > 1 && r.extraLo > 0)
    .sort((a, b) => b.extraLo - a.extraLo || b.extra - a.extra || a.exit.localeCompare(b.exit))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}
