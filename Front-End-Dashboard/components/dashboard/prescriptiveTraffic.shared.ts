/* Shared data access and decision logic for the Traffic Prescriptive tab.
 *
 * All three panels are solutions FOR the Predictive tab's own numbers, so they
 * read the one payload that tab already produces -- /api/traffic/forecast
 * carries volumes, congestion and events together -- rather than each modelling
 * its own view of the future. A panel that disagreed with the forecast printed
 * one row above it would be worse than no panel.
 *
 * The fetch is shared and cached at module scope so mounting three panels costs
 * one request, not three.
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

export function loadForecast(): Promise<ForecastPayload> {
  if (!cache) {
    cache = fetch(`${BACKEND}/api/traffic/forecast?months=all`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`forecast ${r.status}`);
        return r.json();
      })
      .then((j) => {
        const d = j?.data ?? {};
        return {
          championModel: d.championModel ?? null,
          mlConfidence: num(d.mlConfidence),
          volumes: Array.isArray(d.volumes) ? d.volumes : [],
          congestion: Array.isArray(d.congestion) ? d.congestion : [],
          events: Array.isArray(d.events) ? d.events : [],
          upcomingEvents: Array.isArray(d.upcomingEvents) ? d.upcomingEvents : [],
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

/* ------------------------------------------------------------------ LP ----
 *
 * Staffing allocation, as a linear program:
 *
 *   minimise    sum_d  u_d                                (unmet peak demand)
 *   subject to  u_d >= demand_d - (base + x_d) * rate     for each day d
 *               u_d >= 0
 *               sum_d x_d <= pool                         (staff available)
 *               0 <= x_d <= maxExtra                      (lanes per plaza)
 *
 * Every extra lane retires exactly `rate` vehicles of unmet demand until that
 * day's unmet reaches zero, so the constraint matrix is an interval matrix and
 * the greedy assignment -- give the next lane to whichever day still has the
 * most unmet demand -- reaches the LP optimum exactly. That is what runs here:
 * no simplex library, but not an approximation either.
 */
export type StaffDay = {
  date: string;
  forecast: number;
  peakDemand: number;
  lanes: number;      // extra lanes assigned
  unmetBefore: number;
  unmetAfter: number;
};

export function allocateStaff(
  days: { date: string; forecast: number }[],
  opts: { peakShare: number; baseLanes: number; rate: number; pool: number; maxExtra: number },
): { schedule: StaffDay[]; unmetBefore: number; unmetAfter: number } {
  const { peakShare, baseLanes, rate, pool, maxExtra } = opts;
  const rows: StaffDay[] = days.map((d) => {
    const peakDemand = d.forecast * peakShare;
    const unmet = Math.max(0, peakDemand - baseLanes * rate);
    return { date: d.date, forecast: d.forecast, peakDemand, lanes: 0, unmetBefore: unmet, unmetAfter: unmet };
  });

  let left = pool;
  while (left > 0) {
    let best = -1;
    let bestUnmet = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].lanes >= maxExtra) continue;
      if (rows[i].unmetAfter > bestUnmet) {
        bestUnmet = rows[i].unmetAfter;
        best = i;
      }
    }
    if (best < 0) break; // nothing left that a lane would help
    rows[best].lanes += 1;
    rows[best].unmetAfter = Math.max(0, rows[best].unmetAfter - rate);
    left -= 1;
  }

  return {
    schedule: rows,
    unmetBefore: rows.reduce((s, r) => s + r.unmetBefore, 0),
    unmetAfter: rows.reduce((s, r) => s + r.unmetAfter, 0),
  };
}

/* --------------------------------------------------------------- fuzzy ----
 *
 * A Mamdani controller over two inputs -- how likely congestion is, and how
 * soon -- producing one urgency score.
 *
 * Crisp thresholds are the wrong tool here: 0.61 and 0.59 probability describe
 * the same road, and a rule that fires an operator alert at one and stays
 * silent at the other invites exactly the mistrust that makes people stop
 * reading alerts. Triangular memberships overlap, so urgency moves smoothly
 * and a segment sitting near a boundary reads as "near a boundary".
 */
const tri = (x: number, a: number, b: number, c: number): number => {
  if (x <= a || x >= c) return 0;
  if (x === b) return 1;
  return x < b ? (x - a) / (b - a) : (c - x) / (c - b);
};

export type Urgency = { score: number; label: "Monitor" | "Prepare" | "Act" };

export function fuzzyUrgency(probability: number, hoursAhead: number): Urgency {
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
  const label = score >= 0.7 ? "Act" : score >= 0.4 ? "Prepare" : "Monitor";
  return { score, label };
}

/* -------------------------------------------------------------- TOPSIS ----
 *
 * Ranks exits for event-day intervention by their distance to an ideal option.
 *
 *   1. build the decision matrix, one row per exit
 *   2. normalise each criterion by its vector norm
 *   3. weight the columns
 *   4. find the ideal best and ideal worst per criterion
 *   5. score each option by  d- / (d+ + d-)
 *
 * Criteria and their direction:
 *   extraVehicles  benefit  - the vehicles an intervention would actually move
 *   uplift         benefit  - how far above baseline the exit runs
 *   evidence       benefit  - events observed, so a big uplift seen twice does
 *                             not outrank a smaller one seen fifty times
 *   uncertainty    cost     - width of the uplift interval; a wide band means
 *                             the number it is built on is not settled
 */
export type TopsisRow = {
  exit: string;
  extraVehicles: number;
  uplift: number;
  evidence: number;
  uncertainty: number;
  closeness: number;
  rank: number;
};

export function topsisRank(events: EventRow[], weights = [0.4, 0.25, 0.2, 0.15]): TopsisRow[] {
  const rows = events
    .map((e) => {
      const uplift = num(e.uplift) ?? 0;
      const lo = num(e.upliftLo) ?? uplift;
      const hi = num(e.upliftHi) ?? uplift;
      return {
        exit: e.exit,
        extraVehicles: Math.max(0, (e.surge ?? 0) - (e.baseline ?? 0)),
        uplift,
        evidence: e.nEvents ?? 0,
        uncertainty: Math.max(0, hi - lo),
      };
    })
    .filter((r) => r.extraVehicles > 0 || r.uplift > 1);

  if (rows.length === 0) return [];

  const cols: (keyof Omit<TopsisRow, "exit" | "closeness" | "rank">)[] = [
    "extraVehicles", "uplift", "evidence", "uncertainty",
  ];
  const benefit = [true, true, true, false];

  // Vector normalisation, then weights.
  const norms = cols.map((c) => Math.sqrt(rows.reduce((s, r) => s + r[c] ** 2, 0)) || 1);
  const matrix = rows.map((r) => cols.map((c, j) => (r[c] / norms[j]) * weights[j]));

  const best = cols.map((_, j) => {
    const vals = matrix.map((m) => m[j]);
    return benefit[j] ? Math.max(...vals) : Math.min(...vals);
  });
  const worst = cols.map((_, j) => {
    const vals = matrix.map((m) => m[j]);
    return benefit[j] ? Math.min(...vals) : Math.max(...vals);
  });

  const scored = rows.map((r, i) => {
    const dPlus = Math.sqrt(matrix[i].reduce((s, v, j) => s + (v - best[j]) ** 2, 0));
    const dMinus = Math.sqrt(matrix[i].reduce((s, v, j) => s + (v - worst[j]) ** 2, 0));
    return { ...r, closeness: dPlus + dMinus === 0 ? 0 : dMinus / (dPlus + dMinus), rank: 0 };
  });

  scored.sort((a, b) => b.closeness - a.closeness);
  scored.forEach((r, i) => (r.rank = i + 1));
  return scored;
}
