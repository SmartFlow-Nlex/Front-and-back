"use client";

import { useEffect, useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import InfoTooltip from "./InfoTooltip";
import CongestionNarrative from "./CongestionNarrative";
import { ShieldCheck, ChevronRight } from "lucide-react";
import { loadForecast } from "./prescriptiveTraffic.shared";
import { REPLAY_ACTUAL, REPLAY_FORECAST, useMeasuredWidth } from "./replayViz";

type State = "Low" | "Med" | "High";

/** How far ahead the grid is showing. The model forecasts 168 hours; a reader
 *  wants either the next few hours in detail or the shape of the week, never
 *  168 hourly columns. */
type RangeKey = "12h" | "24h" | "week";
const RANGES: { key: RangeKey; label: string; hours: number; help: string }[] = [
  { key: "12h", label: "Next 12 h", hours: 12, help: "Hour by hour, the rest of this shift." },
  { key: "24h", label: "Next 24 h", hours: 24, help: "Hour by hour, a full day ahead." },
  { key: "week", label: "Next 7 days", hours: 168, help: "One column per day: how many hours each exit is expected to spend congested." },
];

type RawRow = { segment: string; hours: number; state: State; probability: number | string;
                /** Per-state probabilities, calibrated. pMed + pHigh is the chance of congestion. */
                pLow?: number | string | null; pMed?: number | string | null; pHigh?: number | string | null;
                km?: number | null; kmEstimated?: boolean;
                /** Manila wall-clock "YYYY-MM-DD HH:MM" the horizons count from. */
                baseTs?: string | null };

// Corridor position now arrives per row from the API (gold.exit_km_post), which
// carries all 20 exits. The hardcoded table here held only 10, so half the
// corridor rendered "km —" AND sorted to the end — and congestion propagates
// between NEIGHBOURS, so a wrong row order hides the one pattern worth seeing.

// Solid fills only. Confidence used to be encoded as opacity, which made a
// low-confidence SEVERE cell look calmer than a solid HEAVY one — the opacity
// channel fought the colour channel. Free flow is deliberately muted so the
// eye lands on the problems; label colours are chosen for contrast on the fill.
// PALETTE — two deliberate departures from the obvious traffic-light scheme.
//
// 1. Free flow is BLUE, not green. Red/green is the single most common
//    accessibility failure (~8% of men cannot separate them), and on this grid
//    the green cells are the rare, important exception — precisely what a
//    colour-blind reader would lose. Blue-amber-red survives every common form
//    of colour vision deficiency.
//
// 2. Severe stays RED. Red is the correct signal here — severe congestion is
//    the hazard, and muting it to a dusty brick made the worst state look
//    tentative. "Use red properly" is not a rule against red for danger; it is
//    a rule against red as decoration. What was actually wrong was pairing it
//    with green (point 1) and printing "SEVERE" on every cell so the exceptions
//    had nothing to stand out against — both fixed elsewhere, without needing
//    to weaken the colour that carries the warning.
//
// WHAT THE STATES MEAN. train_congestion_horizon.py labels each exit-hour from
// the length-weighted average speed of the Waze jams reported there: under 30
// km/h is High, 30-60 is Med, and an hour with NO jam report at all is Low.
// Jams are slow by definition -- the training table averages 7.6 km/h and
// never exceeds 56 -- so Med is all but impossible and any hour that has a
// report is High. The map is therefore "will Waze carry a jam report at this
// exit this hour", not a corridor speed. The legend used to promise "Free flow
// > 60 km/h", a speed the data cannot contain; the blue cell means the model
// expects no report, which is what it says now.
const STATE_META: Record<State, { rank: number; color: string; text: string; label: string; short: string; speed: string; brief: string }> = {
  Low: { rank: 0, color: "#cfe4f7", text: "#12507e", label: "Moving", short: "MOVING", speed: "no jam, or over 20 km/h", brief: "no jam / >20" },
  Med: { rank: 1, color: "#f0a63a", text: "#5c3208", label: "Heavy", short: "HEAVY", speed: "10–20 km/h", brief: "10–20" },
  High: { rank: 2, color: "#dc2626", text: "#ffffff", label: "Severe", short: "SEVERE", speed: "under 10 km/h", brief: "<10" },
};

/* The week grid counts congested hours per day rather than naming a state, so
   it needs a scale rather than three labels. It is quantised from the SAME
   colours the hourly grid uses — free-flow blue through heavy amber to severe
   red — so "more red" means the same thing in both views. Each cell also
   prints its number, so the colour is a second reading of the value and never
   the only one. */
const WEEK_BANDS: { min: number; max: number; color: string; label: string }[] = [
  { min: 0, max: 0, color: "#cfe4f7", label: "none" },
  { min: 1, max: 2, color: "#fde8c8", label: "1-2 h" },
  { min: 3, max: 5, color: "#f9c97f", label: "3-5 h" },
  { min: 6, max: 8, color: "#f0a63a", label: "6-8 h" },
  { min: 9, max: 24, color: "#dc2626", label: "9 h+" },
];
const LOW_CONF = 0.8;

/** "+1h" is meaningless without an anchor, so every hour label carries the
 *  clock time it refers to. baseTs is wall-clock text (see the service): parsing
 *  it by hand avoids Date() re-interpreting it in the viewer's zone. */
function hourClock(baseTs: string | null | undefined, hoursAhead: number): string | null {
  if (!baseTs) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(baseTs);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  d.setHours(d.getHours() + hoursAhead);
  return d.toLocaleTimeString("en-US", { hour: "numeric", hour12: true }).replace(" ", "");
}

function baseLabel(baseTs: string | null | undefined): string | null {
  if (!baseTs) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(baseTs);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return d.toLocaleString("en-US", { weekday: "short", day: "numeric", month: "short",
                                     hour: "numeric", hour12: true }).replace(" ", " ");
}

type ModelInfo = {
  model: string; accuracy: number | null; accepted: boolean;
  rejectedReason: string | null;
  baseline: { model: string; accuracy: number | null } | null;
};

/** km lookup built from whatever the API returned, so it always covers every
 *  segment actually present rather than a fixed list. */
function kmIndex(rows: { segment: string; km?: number | null; kmEstimated?: boolean }[]) {
  const m = new Map<string, { km: number | null; est: boolean }>();
  for (const r of rows) {
    if (!m.has(r.segment)) m.set(r.segment, { km: r.km ?? null, est: Boolean(r.kmEstimated) });
  }
  return m;
}

/** The held-out week, replayed: the model's expected count of congested exits
 *  against the count that actually happened, hour by hour. */
function ReplayChart({ series, exits }: { series: { t: string; e: number; a: number; n: number }[]; exits: number }) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const padL = 26, padR = 62, padT = 10, padB = 18;
  const H = 150;
  const w = Math.max(width, 240);
  const plotW = Math.max(w - padL - padR, 10);
  const plotH = H - padT - padB;
  const top = Math.max(exits, ...series.map((d) => Math.max(d.a, d.e)), 1);
  const x = (i: number) => padL + (series.length < 2 ? plotW / 2 : (i / (series.length - 1)) * plotW);
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const path = (pick: (d: { e: number; a: number }) => number) =>
    series.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(pick(d)).toFixed(1)}`).join(" ");

  // Midnight boundaries, for the day ticks.
  const dayStarts = series.map((d, i) => ({ i, d })).filter(({ d }) => d.t.slice(11, 13) === "00");
  // Each line is named at its own end, in the gutter: on 164 crossing points
  // a label placed among the marks always lands on data. If the two ends are
  // too close to read, they part just enough to clear each other.
  const last = series[series.length - 1];
  const ends = (() => {
    let a = y(last.a), e = y(last.e);
    if (Math.abs(a - e) < 11) { const mid = (a + e) / 2; a = mid - 6; e = mid + 6; }
    const clamp = (v: number) => Math.min(Math.max(v, padT + 4), padT + plotH);
    return { a: clamp(a), e: clamp(e) };
  })();

  const hv = hover != null ? series[hover] : null;
  const hvLeft = hover != null ? Math.min(Math.max(x(hover), 70), w - 70) : 0;
  const hvTop = hv && Math.max(hv.a, hv.e) > top * 0.55 ? H - 48 : 4;

  return (
    // A 164-hour line needs a floor width to stay legible; below that the
    // chart scrolls inside its own box rather than widening the page.
    <div ref={ref} style={{ position: "relative", width: "100%", overflowX: "auto" }}>
      <div style={{ display: "flex", gap: 14, justifyContent: "flex-end", fontSize: "0.7rem", color: "#64748b", marginBottom: 2 }}>
        {[{ c: REPLAY_ACTUAL, dash: false, label: "Actually congested" },
          { c: REPLAY_FORECAST, dash: true, label: "Model expected" }].map((l) => (
          <span key={l.label} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <svg width={16} height={8} aria-hidden="true">
              <line x1={0} y1={4} x2={16} y2={4} stroke={l.c} strokeWidth={2} strokeDasharray={l.dash ? "5 3" : undefined} />
            </svg>
            {l.label}
          </span>
        ))}
      </div>
      {width > 0 && (
        <svg width={w} height={H} role="img"
             aria-label={`Model's expected congested exits against the actual count, ${series.length} hours of held-out data`}
             onMouseLeave={() => setHover(null)}
             onMouseMove={(ev) => {
               const box = ev.currentTarget.getBoundingClientRect();
               const i = Math.round(((ev.clientX - box.left - padL) / plotW) * (series.length - 1));
               setHover(Math.min(Math.max(i, 0), series.length - 1));
             }}>
          {/* Recessive frame: a few gridlines, day ticks, no chart junk. */}
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={padL} x2={w - padR} y1={y(top * f)} y2={y(top * f)} stroke="#eef2f7" strokeWidth={1} />
              <text x={padL - 6} y={y(top * f) + 3} textAnchor="end" fontSize={9} fill="#94a3b8">{Math.round(top * f)}</text>
            </g>
          ))}
          {dayStarts.map(({ i, d }) => (
            <g key={i}>
              <line x1={x(i)} x2={x(i)} y1={padT} y2={padT + plotH} stroke="#f1f5f9" strokeWidth={1} />
              <text x={x(i)} y={H - 5} textAnchor="middle" fontSize={9} fill="#94a3b8">
                {new Date(d.t.replace(" ", "T")).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </text>
            </g>
          ))}

          {/* Actual is the ground truth, so it carries the fill. */}
          <path d={`${path((d) => d.a)} L${x(series.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill={REPLAY_ACTUAL} opacity={0.09} />
          <path d={path((d) => d.a)} fill="none" stroke={REPLAY_ACTUAL} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d={path((d) => d.e)} fill="none" stroke={REPLAY_FORECAST} strokeWidth={2} strokeDasharray="5 3" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />

          <text x={padL + plotW + 6} y={ends.a + 3} fontSize={10} fontWeight={700} fill={REPLAY_ACTUAL}>Actual</text>
          <text x={padL + plotW + 6} y={ends.e + 3} fontSize={10} fontWeight={700} fill={REPLAY_FORECAST}>Expected</text>

          {hv && (
            <g pointerEvents="none">
              <line x1={x(hover!)} x2={x(hover!)} y1={padT} y2={padT + plotH} stroke="#94a3b8" strokeWidth={1} />
              <circle cx={x(hover!)} cy={y(hv.a)} r={4} fill={REPLAY_ACTUAL} stroke="#fff" strokeWidth={2} />
              <circle cx={x(hover!)} cy={y(hv.e)} r={4} fill={REPLAY_FORECAST} stroke="#fff" strokeWidth={2} />
            </g>
          )}
        </svg>
      )}
      {hv && (
        <div style={{
          position: "absolute", left: hvLeft, top: hvTop, transform: "translateX(-50%)", pointerEvents: "none",
          background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "6px 9px",
          boxShadow: "0 6px 16px rgba(15,23,42,0.12)", fontSize: "0.72rem", whiteSpace: "nowrap", zIndex: 2,
        }}>
          <div style={{ fontWeight: 700, color: "#0f172a", marginBottom: 3 }}>
            {new Date(hv.t.replace(" ", "T")).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", hour12: true })}
          </div>
          <div style={{ color: REPLAY_FORECAST, fontWeight: 600 }}>Model expected {hv.e.toFixed(1)} of {hv.n}</div>
          <div style={{ color: REPLAY_ACTUAL, fontWeight: 600 }}>Actually congested {hv.a} of {hv.n}</div>
        </div>
      )}
    </div>
  );
}

/** One numbered step of the Validation evidence: a bold question-style title
 *  over its answer, so a reader can skim the five titles and stop at the one
 *  they came for. */
function EvBlock({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "22px minmax(0,1fr)", gap: 10, alignItems: "start" }}>
      <span style={{
        display: "grid", placeItems: "center", width: 22, height: 22, borderRadius: 999, fontSize: "0.7rem", fontWeight: 800,
        background: "var(--bg-surface-hover)", border: "1px solid var(--border-default)", color: "var(--text-secondary)",
      }}>{n}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: "0.82rem", fontWeight: 800, color: "var(--text-primary)", letterSpacing: "-0.01em", marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: "0.76rem" }}>{children}</div>
      </div>
    </div>
  );
}

const kmLabel = (e?: { km: number | null; est: boolean }) =>
  e?.km == null ? "—" : `${e.km}${e.est ? "*" : ""}`;

type CellItem = {
  value: [number, number, number];
  /** Chance of congestion (heavy or severe), 0-1, when the row carries it. */
  pCong?: number | null;
  pHigh?: number | null;
  /** "Pending" marks an hour inside the frame the stored forecast does not
      reach yet -- drawn blank, filled by the next hourly refresh. */
  state: State | "Pending";
  conf: number;
  /** First cell of a contiguous run of this state — the only one that is labelled. */
  runStart?: boolean;
  label: { color: string };
};

type Alert = { segment: string; state: State; from: number; to: number; conf: number };

/** Accuracy at each forecast horizon, with the "nothing changes" benchmark. */
/** One exit-day in the week view: how many of that day's forecast hours are
 *  congested, and when the first of them starts. */
type DayCell = {
  value: [number, number, number];
  /** Expected congested hours, rounded for display. */
  hours: number;
  /** The unrounded sum of hourly chances. */
  exact: number;
  /** False only for a stored forecast written before per-state chances existed. */
  estimated: boolean;
  severeHours: number;
  known: number;
  partial: boolean;
  firstClock: string | null;
};

type HzAcc = { horizon: number; accuracy: number | null; persistenceAccuracy: number | null };

/** How the served model was scored; written by the training run, one row. */
type CongestionEval = {
  model: string;
  test_rows: number;
  test_days: number;
  class_share: Record<string, number>;
  per_class: Record<string, { precision: number; recall: number; support: number }>;
  brier: number;
  macro_f1: number;
  calibration: { lo: number; hi: number; n: number; predicted: number; observed: number }[];
  /** The held-out week replayed hour by hour: what the model expected against
   *  what actually happened. Absent on forecasts written before Sep 2026. */
  replay?: {
    horizon: number; exits: number; match_rate: number; mae_exits: number; corr: number;
    series: { t: string; e: number; a: number; n: number }[];
    examples: { kind: string; t: string; expected: number; actual: number; exits: number }[];
  } | null;
  thresholds_kmh: { severe_below: number; heavy_below: number };
  features: string[];
};

export default function PredictiveCongestionChart() {
  const [raw, setRaw] = useState<RawRow[] | null>(null);
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  // Show the southern end first — 20 rows is a lot to land on. Expanding is one
  // click, and the SUMMARY above the grid always covers all 20 regardless, so
  // the collapsed view never changes what the panel reports.
  // Which exits beyond the default five are on screen. A set rather than a
  // boolean, so a reader can pull in the two or three exits they care about
  // instead of choosing between five rows and twenty.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [extraExits, setExtraExits] = useState<string[]>([]);
  const COLLAPSED_EXITS = 5;
  const [hzAcc, setHzAcc] = useState<HzAcc[]>([]);
  const [range, setRange] = useState<RangeKey>("12h");
  const [evalInfo, setEvalInfo] = useState<CongestionEval | null>(null);

  // One km lookup for the whole component: the heatmap, the alert list and the
  // detail drawer all order by corridor position and must agree on it.
  const KMI = useMemo(() => kmIndex(raw ?? []), [raw]);

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    // Reads the shared, cached forecast rather than fetching the ~600 KB
    // payload again: the volume and event cards on this tab want the same
    // response in the same second. A failure is not cached by the loader, so
    // each retry here is a real retry. Previously a failure left the card
    // stuck on "Loading…" with no way to recover.
    (async () => {
      const MAX_TRIES = 3;
      for (let tryNo = 1; tryNo <= MAX_TRIES; tryNo++) {
        try {
          const fc = await loadForecast();
          if (cancelled) return;
          if (fc.congestion.length > 0) {
            setRaw(fc.congestion as unknown as RawRow[]);
            setModelInfo((fc.extras.congestionModel as ModelInfo | undefined) ?? null);
            setEvalInfo((fc.extras.congestionEval as CongestionEval | null | undefined) ?? null);
            if (Array.isArray(fc.extras.congestionHorizonAccuracy)) {
              setHzAcc(fc.extras.congestionHorizonAccuracy as HzAcc[]);
            }
            setLoadError(null);
            return;
          }
          if (tryNo === MAX_TRIES) {
            setLoadError("No congestion forecast in the payload");
            return;
          }
        } catch (e) {
          if (cancelled) return;
          if (tryNo === MAX_TRIES) {
            setLoadError(e instanceof Error ? e.message : "Forecast unavailable");
            return;
          }
        }
        await new Promise<void>((r) => timers.push(setTimeout(r, tryNo * 2000 - 1000)));
        if (cancelled) return;
      }
    })();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [attempt]);

  useEffect(() => {
    if (!alertsOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAlertsOpen(false);
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [alertsOpen]);

  const rangeDef = RANGES.find((r) => r.key === range) ?? RANGES[0];
  const hourCap = rangeDef.hours;

  const model = useMemo(() => {
    if (!raw || raw.length === 0) return null;

    const byKm = Array.from(new Set(raw.map((d) => d.segment))).sort(
      (a, b) => (KMI.get(a)?.km ?? 9999) - (KMI.get(b)?.km ?? 9999)
    );
    // Never more than the selected range, and never more than was stored.
    const storedHours = Math.min(Math.max(...raw.map((d) => d.hours)), hourCap);
    const baseTs = raw.find((r) => r.baseTs)?.baseTs ?? null;

    /* The forecast counts from the last COMPLETE hour of Waze ingestion, which
       is always at least an hour behind the clock: the 11:00 hour is only
       complete at noon. So by the time anyone reads the card, its first column
       or two describe hours that have already finished.
       Those are history, not forecast. Drop every hour whose window has fully
       passed and start the grid at the hour we are actually in, so "what
       happens next" is the first thing on screen rather than the third. */
    const baseMsForTrim = (() => {
      const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(baseTs ?? "");
      if (!m) return null;
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
    })();
    /* Everything below is measured against the CLOCK, never against the first
       column. Column h covers the hour starting at base + h, so:
         - it is past once that hour has ended, i.e. it starts before this hour
         - it is "now" only when it IS this hour
       Anchoring "now" to the first surviving column instead was wrong whenever
       the data was fully fresh: with base at 2 PM the first column is the 3 PM
       hour, and the card called 3 PM "now" at 2:26 PM. */
    const hourMs = 3.6e6;
    const thisHourStart = (() => {
      const d = new Date();
      d.setMinutes(0, 0, 0);
      return d.getTime();
    })();
    const startOf = (h: number) => (baseMsForTrim == null ? null : baseMsForTrim + h * hourMs);

    const skippedHours =
      baseMsForTrim == null
        ? 0
        : Math.min(
            storedHours,
            Array.from({ length: storedHours }, (_, i) => i + 1).filter(
              (h) => (startOf(h) as number) < thisHourStart,
            ).length,
          );
    const maxHour = storedHours - skippedHours;

    // Hours between this one and the column: 0 is the hour in progress.
    const relHours = Array.from({ length: maxHour }, (_, i) => {
      const t = startOf(skippedHours + i + 1);
      return t == null ? i + 1 : Math.round((t - thisHourStart) / hourMs);
    });
    const relLabel = (n: number) => (n <= 0 ? "now" : `+${n}h`);

    const hourLabels = Array.from({ length: maxHour }, (_, i) => {
      const clock = hourClock(baseTs, skippedHours + i + 1);
      const rel = relLabel(relHours[i]);
      return clock ? `${rel}\n${clock}` : rel;
    });

    /* The frame is always the stored width, like a weather strip that always
       shows the same number of hours. Dropping past hours used to shrink the
       grid -- twelve columns at 3 PM, four by 11 PM -- which read as the
       forecast "deducting" itself. Hours the stored run does not reach are
       kept as blank columns labelled with their clock time, so the frame holds
       still and the gap says plainly that a refresh is due. */
    const frameHours = storedHours;
    const frameLabels = Array.from({ length: frameHours }, (_, i) => {
      const clock = hourClock(baseTs, skippedHours + i + 1);
      const t = startOf(skippedHours + i + 1);
      const rel = relLabel(t == null ? i + 1 : Math.round((t - thisHourStart) / hourMs));
      return clock ? `${rel}\n${clock}` : rel;
    });

    // ECharts draws a category y-axis bottom-up, so reverse to read north-bound
    // down the page (Balintawak on top).
    const segments = [...byKm].reverse();

    const states: (State | null)[][] = segments.map(() => Array(maxHour).fill(null));
    const confs: number[][] = segments.map(() => Array(maxHour).fill(0));
    // The calibrated chance of congestion per cell, kept beside the label
    // because the week view has to add chances rather than count labels.
    const probs: (number | null)[][] = segments.map(() => Array(maxHour).fill(null));
    const cells: CellItem[] = [];

    raw.forEach((d) => {
      const y = segments.indexOf(d.segment);
      // Shift into now-relative columns; anything before column 0 has passed.
      const x = d.hours - 1 - skippedHours;
      if (y < 0 || x < 0 || x >= maxHour) return;
      const conf = Number(d.probability);
      states[y][x] = d.state;
      confs[y][x] = conf;
      const meta = STATE_META[d.state] ?? STATE_META.Low;
      const pMed = d.pMed == null ? null : Number(d.pMed);
      const pHigh = d.pHigh == null ? null : Number(d.pHigh);
      const pCong = pMed != null && pHigh != null ? pMed + pHigh : null;
      probs[y][x] = pCong;
      cells.push({ value: [x, y, meta.rank], state: d.state, conf, pCong, pHigh, label: { color: meta.text } });
    });

    // Flag the first cell of each run so the label formatter can print the state
    // once per run instead of once per cell.
    cells.forEach((c) => {
      const [x, y] = c.value;
      c.runStart = x === 0 || states[y][x - 1] !== c.state;
    });

    // Blank cells for the hours the stored forecast does not reach.
    for (let y = 0; y < segments.length; y++) {
      for (let x = maxHour; x < frameHours; x++) {
        cells.push({ value: [x, y, 3], state: "Pending", conf: 0, label: { color: "#94a3b8" } });
      }
    }

    /* Week view. 168 hourly columns cannot be read, so the week is shown a day
       at a time: each cell is how many hours that exit is expected to spend
       congested on that day. That keeps the thing a planner actually asks —
       "how bad is Thursday at Marilao?" — as a single number, and it varies
       across the grid in a way a worst-state-of-the-day summary would not
       (every day has a rush hour, so worst-state would paint the whole week
       red and say nothing). */
    const dayBuckets: { key: string; label: string; sub: string; cols: number[] }[] = [];
    for (let x = 0; x < maxHour; x++) {
      const t = startOf(skippedHours + x + 1);
      if (t == null) continue;
      const dt = new Date(t);
      const key = `${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}`;
      let b = dayBuckets.find((z) => z.key === key);
      if (!b) {
        b = {
          key,
          label: dt.toLocaleDateString(undefined, { weekday: "short" }),
          sub: dt.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
          cols: [],
        };
        dayBuckets.push(b);
      }
      b.cols.push(x);
    }
    const dayLabels = dayBuckets.map((b) => `${b.label}\n${b.sub}`);
    const dayCells: DayCell[] = [];
    let dayMax = 0;
    segments.forEach((_seg, y) => {
      dayBuckets.forEach((b, i) => {
        const known = b.cols.filter((x) => states[y][x] != null);
        /* Expected congested hours = the sum of each hour's calibrated chance,
           NOT a count of hours whose most-likely label is congested.
           Counting labels saturates: taking the winner in every cell collapses
           an exit toward whichever class it usually is, so Marilao (congested
           80% of hours in the record) predicts 100% and Balintawak (54%)
           predicts 4%. Measured against each exit's real base rate, counting
           labels is off by 22.9 points on average and adding chances by 8.0.
           The chances are calibrated — in held-out hours where the model said
           55%, congestion happened 55% of the time — so they can be added. */
        const haveProbs = known.some((x) => probs[y][x] != null);
        const expected = haveProbs
          ? known.reduce((t, x) => t + (probs[y][x] ?? 0), 0)
          : known.filter((x) => states[y][x] === "Med" || states[y][x] === "High").length;
        const severe = known.filter((x) => states[y][x] === "High");
        // The first hour more likely congested than not is the one to plan around.
        const firstCol = known.find((x) =>
          haveProbs ? (probs[y][x] ?? 0) >= 0.5 : states[y][x] === "Med" || states[y][x] === "High");
        const rounded = Math.round(expected);
        dayMax = Math.max(dayMax, rounded);
        dayCells.push({
          value: [i, y, rounded],
          hours: rounded,
          exact: expected,
          estimated: haveProbs,
          severeHours: severe.length,
          known: known.length,
          // A partial first or last day is a real thing to say, not a gap to hide.
          partial: known.length < 24,
          firstClock: firstCol == null ? null : hourClock(baseTs, skippedHours + firstCol + 1),
        });
      });
    });

    // ---- Operational summary ----
    const atRisk = new Set<string>();
    const severeSegments = new Set<string>();
    let severeCells = 0;
    const perHour = Array(maxHour).fill(0) as number[];
    const severePerHour = Array(maxHour).fill(0) as number[];
    const perSegment = segments.map(() => 0);

    states.forEach((row, y) =>
      row.forEach((st, x) => {
        if (!st) return;
        if (st === "High") {
          severeCells++;
          severeSegments.add(segments[y]);
          severePerHour[x]++;
        }
        if (st !== "Low") {
          atRisk.add(segments[y]);
          perHour[x]++;
          perSegment[y]++;
        }
      })
    );

    // One alert per contiguous run of the same state — "Bocaue severe +4h→+6h"
    // instead of three near-identical cards.
    const alerts: Alert[] = [];
    states.forEach((row, y) => {
      let run: Alert | null = null;
      row.forEach((st, x) => {
        const on = st !== null && st !== "Low";
        if (on && run && run.state === st && run.to === x) {
          run.to = x + 1;
          run.conf = Math.max(run.conf, confs[y][x]);
        } else {
          if (run) alerts.push(run);
          run = on ? { segment: segments[y], state: st as State, from: x + 1, to: x + 1, conf: confs[y][x] } : null;
        }
      });
      if (run) alerts.push(run);
    });
    alerts.sort((a, b) => {
      const r = STATE_META[b.state].rank - STATE_META[a.state].rank;
      if (r !== 0) return r;
      const span = b.to - b.from - (a.to - a.from);
      return span !== 0 ? span : b.conf - a.conf;
    });

    // The grid's real message is usually not "cell (3,7) is red" but "a run of
    // neighbouring exits is bad for a long stretch". Congestion propagates
    // between neighbours, so a CONTIGUOUS block is the meaningful shape - and it
    // is far quicker to read as one sentence than as 240 coloured cells.
    // Measured over every CONGESTED exit, heavy or severe: a window can be busy
    // end to end without one hour crawling under 10 km/h, and reading the span
    // off severe alone then printed "no congestion predicted" beside a grid
    // that was amber from end to end.
    const severeIdx = segments
      .map((seg, i) => (atRisk.has(seg) ? i : -1))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    const contiguous =
      severeIdx.length > 1 && severeIdx[severeIdx.length - 1] - severeIdx[0] === severeIdx.length - 1;
    const severeKms = [...atRisk]
      .map((seg) => KMI.get(seg)?.km)
      .filter((k): k is number => k != null)
      .sort((a, b) => a - b);
    const kmFrom = severeKms.length ? severeKms[0] : null;
    const kmTo = severeKms.length ? severeKms[severeKms.length - 1] : null;

    // Every hour identical means the 12 columns carry no information, and a
    // "peak window" label would invent a worst hour that does not exist.
    const flatHours = perHour.length > 1 && perHour.every((n) => n === perHour[0]);

    // How long the worst segments stay bad, and how sure the model is.
    //
    // These used to look at Severe alone, which was the only congested class
    // the old 30 km/h cut ever produced. With the classes re-cut at this
    // corridor's own speeds, Heavy is the common state and a window can be
    // busy for twelve hours without one Severe hour in it — so "congested"
    // has to mean Heavy or Severe, or the card reports zero on a red day.
    const allHours = alerts.length > 0 && alerts.every((a) => a.from === 1 && a.to === maxHour);
    /* Over every congested CELL, not over episode peaks. An episode carries the
       highest confidence in its run, so taking the range across episodes
       reported a floor of 44% while the least confident cell on the grid was
       38% — a tile labelled "confidence on severe cells" that no cell had. */
    const severeConfs = cells
      .filter((c) => c.state !== "Low")
      .map((c) => c.conf)
      .sort((x, y) => x - y);

    const peakIdx = perHour.indexOf(Math.max(...perHour));
    const worstIdx = perSegment.indexOf(Math.max(...perSegment));
    // The first congested run of any grade, and separately the first severe
    // one, so the card can say "heavy from +1h, severe from +4h".
    const firstAlert = alerts[0] ?? null;
    const firstSevere = alerts.find((a) => a.state === "High") ?? null;

    return {
      segments,
      hourLabels,
      cells,
      perHour,
      alerts,
      severeCount: alerts.filter((a) => a.state === "High").length,
      atRisk: atRisk.size,
      congestedSegments: [...atRisk],
      severeSegments: [...severeSegments],
      severeCells,
      peakHour: perHour[peakIdx] > 0 ? peakIdx + 1 : null,
      peakHourCount: perHour[peakIdx],
      worstSegment: perSegment[worstIdx] > 0 ? segments[worstIdx] : null,
      worstSegmentCount: perSegment[worstIdx],
      firstAlert,
      firstSevere,
      contiguous,
      baseTs,
      severePerHour,
      kmFrom,
      kmTo,
      flatHours,
      allHours,
      maxHour,
      storedHours,
      skippedHours,
      dayLabels,
      dayCells,
      dayMax,
      dayCount: dayBuckets.length,
      relHours,
      frameHours,
      frameLabels,
      confLo: severeConfs.length ? severeConfs[0] : null,
      confHi: severeConfs.length ? severeConfs[severeConfs.length - 1] : null,
      // Whether the model EVER predicts Heavy. It does not, and a legend entry
      // for a state that never appears reads as a gap in the data rather than a
      // property of the model.
      heavyCount: alerts.filter((a) => a.state === "Med").length,
      everHeavy: cells.some((c) => c.state === "Med"),
      lowConfCount: cells.filter((c) => c.state !== "Low" && c.conf < LOW_CONF).length,
    };
  }, [raw, KMI, hourCap]);

  if (!model) {
    return (
      <article className="chart-card wide" style={{ padding: "24px", marginTop: "24px", display: "flex", flexDirection: "column", gap: 12 }}>
        {loadError ? (
          <>
            <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>
              Predictive Congestion State Map
              <InfoTooltip text="Predicted jam state at each exit for the next 12 hours, from Waze jam reports. Red = crawling under 10 km/h, amber = heavy at 10-20 km/h, blue = moving freely or no jam reported. The cuts are this corridor's own: a generic 30 km/h threshold put every reported jam in one class." />
            </h3>
            <div style={{ color: "var(--color-danger, #ef4444)", fontSize: "0.88rem" }}>{loadError}</div>
            <div>
              <button
                onClick={() => { setLoadError(null); setAttempt((a) => a + 1); }}
                style={{
                  padding: "6px 16px", borderRadius: 999, cursor: "pointer", border: "1px solid transparent",
                  background: "linear-gradient(135deg, #6366f1, #4f46e5)", color: "#fff",
                  fontSize: "0.78rem", fontWeight: 600,
                }}
              >
                Try again
              </button>
            </div>
          </>
        ) : (
          <div style={{ color: "#64748b" }}>Loading ML congestion forecast from AWS…</div>
        )}
      </article>
    );
  }

  const { segments, hourLabels, cells, perHour, alerts, frameLabels, frameHours } = model;
  const maxPerHour = Math.max(...perHour, 1);

  // A stored forecast does not know it has aged. base_ts only advances when the
  // training script is re-run, so without this the panel keeps printing clock
  // times ("+1h · 10AM") for hours that finished yesterday — the one way this
  // card can actively mislead rather than merely omit.
  const baseMs = (() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(model.baseTs ?? "");
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
                    Number(m[4]), Number(m[5])).getTime();
  })();
  const ageHours = baseMs == null ? null : (Date.now() - baseMs) / 3.6e6;
  /* Hours that had already finished are dropped before the grid is built (see
     skippedHours in the memo), so nothing on screen is in the past. What is
     left to say is whether anything remains at all: when every stored hour has
     run out the card has no forecast to show and says so. */
  const expired = model.maxHour === 0;
  const skippedHours = model.skippedHours;
  // A state earns a text label only while it is the exception. Free flow is
  // included: when the corridor is mostly severe, the clear cells are the news.
  // Shares are over the FORECAST cells only. Counting the blank not-yet-
  // forecast columns in the denominator made every real state look like a
  // minority, and the grid labelled "SEVERE" on all forty of its red cells.
  const forecastCells = cells.filter((c) => c.state !== "Pending");
  const stateShare = (["Low", "Med", "High"] as State[]).map((st) => ({
    st, share: forecastCells.filter((c) => c.state === st).length / Math.max(forecastCells.length, 1),
  }));
  const minorityStates = new Set(stateShare.filter((x) => x.share > 0 && x.share < 0.25).map((x) => x.st));
  // 20 segments at 34px was a 680px grid, and with the header, banner, KPI row
  // and the panel below it the card ran well past a screen. The cells carry no
  // text - only colour - so their height buys nothing above the point where the
  // row label is comfortably readable, which is around 22px.
  const ROW_H = 22;
  const heatTop = 44;
  // Display slice only: `segments` is reversed for ECharts (index 0 draws at
  // the bottom), so the first exits by km-post are the tail of the array.
  const defaultShown = segments.slice(-COLLAPSED_EXITS);
  const shownSegments = segments.filter(
    (sg) => defaultShown.includes(sg) || extraExits.includes(sg));
  const hiddenSegments = segments.filter((sg) => !shownSegments.includes(sg));
  const hiddenCount = hiddenSegments.length;

  // Arbitrary subsets, so cells are remapped through an index table rather than
  // shifted by a fixed offset.
  const yMap = new Map(shownSegments.map((sg, i) => [segments.indexOf(sg), i]));
  const shownCells = cells
    .filter((c) => yMap.has(c.value[1]))
    .map((c) => ({ ...c, value: [c.value[0], yMap.get(c.value[1])!, c.value[2]] as [number, number, number] }));

  const shownDayCells = model.dayCells
    .filter((c) => yMap.has(c.value[1]))
    .map((c) => ({ ...c, value: [c.value[0], yMap.get(c.value[1])!, c.value[2]] as [number, number, number] }));

  // When does each hidden exit first turn severe? Drives the chip ordering and
  // the warning, so the reader can see which are worth pulling in.
  const firstSevere = (sg: string) => {
    const y = segments.indexOf(sg);
    const hrs = cells.filter((c) => c.value[1] === y && c.state === "High").map((c) => c.value[0] + 1);
    return hrs.length ? Math.min(...hrs) : null;
  };
  // Exits dropped from the view that turn severe SOONER than anything shown —
  // hiding an earlier problem silently would be the one real risk here.
  const earliestShown = Math.min(
    ...shownCells.filter((c) => c.state === "High").map((c) => c.value[0] + 1),
    Number.POSITIVE_INFINITY);
  const urgentHidden = hiddenSegments.some((sg) => {
    const f = firstSevere(sg);
    return f != null && f < earliestShown;
  });

  const heatHeight = shownSegments.length * ROW_H;
  // The strip needs its own axis and hour labels, so it gets real height. It
  // was 34px of unlabelled bars floating under the grid, which is why it read
  // as a mystery total rather than a count per hour.
  const stripTop = heatTop + heatHeight + 34;
  const stripHeight = 52;
  const chartHeight = stripTop + stripHeight + 50;

  const isWeek = range === "week";

  // The week view has no per-hour strip under it — a count of congested exits
  // per DAY would double-count the same exit across its hours — so it ends at
  // the grid.
  const weekChartHeight = heatTop + heatHeight + 14;

  const weekOption: EChartsOption = {
    visualMap: {
      show: false,
      type: "piecewise",
      dimension: 2,
      seriesIndex: 0,
      pieces: WEEK_BANDS.map((b) => ({ min: b.min, max: b.max, color: b.color })),
    },
    tooltip: {
      backgroundColor: "rgba(255,255,255,0.97)",
      borderColor: "#e2e8f0",
      borderWidth: 1,
      textStyle: { color: "#334155" },
      extraCssText: "box-shadow: 0 6px 16px rgba(15,23,42,0.12); border-radius: 8px;",
      formatter: (params: unknown) => {
        const p = params as { data: DayCell; dataIndex: number };
        const d = p.data;
        const seg = shownSegments[d.value[1]] ?? "";
        const day = (model.dayLabels[d.value[0]] ?? "").replace("\n", " ");
        return `<div style="font-weight:700; margin-bottom:4px;">${seg} \u00b7 ${day}</div>
          <div style="display:grid; grid-template-columns:auto auto; gap:2px 14px; font-size:12px;">
            <span style="color:#64748b;">Expected congested hours</span><span style="font-weight:700;">${d.estimated ? d.exact.toFixed(1) : d.hours} of ${d.known}</span>
            ${d.severeHours > 0 ? `<span style="color:#64748b;">Of those, crawling</span><span style="font-weight:700; color:#b91c1c;">${d.severeHours} h</span>` : ""}
            ${d.firstClock ? `<span style="color:#64748b;">First likely from</span><span style="font-weight:600;">${d.firstClock}</span>` : ""}
          </div>
          ${d.estimated ? `<div style="margin-top:6px; color:#94a3b8; font-size:11px;">Each hour's chance of congestion, added up \u2014 not a count of hours.</div>` : ""}
          ${d.partial ? `<div style="margin-top:6px; color:#94a3b8; font-size:11px;">Part of a day \u2014 only ${d.known} forecast hours fall on it.</div>` : ""}`;
      },
    },
    grid: [{ left: 150, right: 24, top: heatTop, height: heatHeight }],
    xAxis: [{
      gridIndex: 0,
      type: "category",
      data: model.dayLabels,
      position: "top",
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        interval: 0,
        color: "#64748b", fontWeight: 600, fontSize: 11, lineHeight: 13,
        rich: { a: { fontSize: 10, color: "#94a3b8", fontWeight: 500 } },
        formatter: (v: string) => {
          const [dow, date] = v.split("\n");
          return date ? `${dow}\n{a|${date}}` : dow;
        },
      },
    }],
    yAxis: [{
      gridIndex: 0,
      type: "category",
      data: shownSegments.map((sg) => `${sg}  \u00b7  km ${kmLabel(KMI.get(sg))}`),
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: "#334155", fontWeight: 600, fontSize: 11 },
    }],
    series: [{
      name: "Congested hours per day",
      type: "heatmap",
      xAxisIndex: 0,
      yAxisIndex: 0,
      data: shownDayCells,
      // The number is the value; the colour repeats it. Neither alone.
      label: {
        show: true,
        formatter: (params: unknown) => {
          const d = (params as { data: DayCell }).data;
          return d.hours > 0 ? String(d.hours) : "";
        },
        color: "inherit",
        fontSize: 11,
        fontWeight: 700,
      },
      itemStyle: { borderColor: "#fff", borderWidth: 3, borderRadius: 4 },
      emphasis: { itemStyle: { borderColor: "#0f172a", borderWidth: 2, shadowBlur: 10, shadowColor: "rgba(15,23,42,0.3)" } },
    }],
  };

  const option: EChartsOption = {
    // A cartesian heatmap throws "Heatmap must use with visualMap" without
    // this — it is what drives the cell fill from the third data value.
    visualMap: {
      show: false,
      type: "piecewise",
      dimension: 2,
      seriesIndex: 0,
      pieces: [
        { value: 0, color: STATE_META.Low.color },
        { value: 1, color: STATE_META.Med.color },
        { value: 2, color: STATE_META.High.color },
        { value: 3, color: "#f1f5f9" },   // pending: not yet forecast
      ],
    },
    tooltip: {
      backgroundColor: "rgba(255,255,255,0.97)",
      borderColor: "#e2e8f0",
      borderWidth: 1,
      textStyle: { color: "#334155" },
      extraCssText: "box-shadow: 0 6px 16px rgba(15,23,42,0.12); border-radius: 8px;",
      formatter: (params: unknown) => {
        const p = params as { seriesIndex: number; data: CellItem | number; dataIndex: number };
        if (p.seriesIndex === 1) {
          const n = (p as { value?: number | null }).value;
          if (n == null) return `<b>${frameLabels[p.dataIndex]}</b><br/>Not yet forecast — filled by the next hourly refresh`;
          return `<b>${frameLabels[p.dataIndex]}</b><br/>${n} of ${segments.length} segments congested`;
        }
        const d = p.data as CellItem;
        if (d.state === "Pending") {
          return `
          <div style="padding:2px 4px; min-width:215px;">
            <b style="font-size:1.05em; color:#0f172a;">${shownSegments[d.value[1]]}</b>
            <div style="margin-top:6px; color:#64748b;">${frameLabels[d.value[0]]?.replace("\n", " · ")}: not yet forecast. The stored run does not reach this hour; the hourly refresh will fill it.</div>
          </div>`;
        }
        const [x, y] = d.value;
        const meta = STATE_META[d.state];
        const low = d.conf < LOW_CONF;
        return `
          <div style="padding:2px 4px; min-width:215px;">
            <b style="font-size:1.05em; color:#0f172a;">${shownSegments[y]}</b>
            <span style="color:#94a3b8; font-size:0.85em;"> · km ${kmLabel(KMI.get(shownSegments[y]))}</span>
            <div style="margin-top:8px; display:grid; grid-template-columns:112px 1fr; gap:5px 8px; font-size:0.9em;">
              <span style="color:#64748b;">Horizon</span><span style="font-weight:600;">${hourLabels[x]}</span>
              <span style="color:#64748b;">Predicted state</span><span style="color:${d.state === "Low" ? STATE_META.Low.text : d.state === "Med" ? STATE_META.Med.text : STATE_META.High.color}; font-weight:700;">${meta.label}</span>
              <span style="color:#64748b;">Meaning</span><span style="font-weight:500;">${meta.speed}</span>
              ${d.pCong != null ? `<span style="color:#64748b;">Chance of congestion</span><span style="font-weight:700; color:${d.pCong >= 0.5 ? "#b91c1c" : "#334155"};">${Math.round(d.pCong * 100)}%${d.pHigh != null ? ` <span style="font-weight:500; color:#64748b;">(severe ${Math.round(d.pHigh * 100)}%)</span>` : ""}</span>` : ""}
              <span style="color:#64748b;">Most likely state</span><span style="font-weight:600; color:${low ? "#b45309" : "#334155"};">${meta.label} · ${(d.conf * 100).toFixed(0)}%${low ? " · under 80%, indicative" : ""}</span>
            </div>
          </div>`;
      },
    },
    grid: [
      { left: 150, right: 24, top: heatTop, height: heatHeight },
      { left: 150, right: 24, top: stripTop, height: stripHeight },
    ],
    xAxis: [
      {
        gridIndex: 0,
        type: "category",
        data: frameLabels,
        position: "top",
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: {
          /* Every hour gets a header while they fit. Past about fourteen
             columns the two-line "+12h / 4PM" labels collide into a smear, so
             the day view labels every other column; the cells are still one
             per hour and the tooltip names each one. */
          interval: frameHours > 20 ? 2 : frameHours > 14 ? 1 : 0,
          color: "#64748b", fontWeight: 600, fontSize: 10, lineHeight: 12,
          // Second line is the clock time, deliberately quieter than the horizon.
          // An elapsed column printed "10AM" in the same weight as a future
          // one, which is what let a stale forecast read as upcoming. Past
          // hours are greyed so the boundary between done and due is visible.
          rich: {
            a: { fontSize: 10, color: "#94a3b8", fontWeight: 500 },
            past: { fontSize: 11, color: "#cbd5e1", fontWeight: 600 },
            pastc: { fontSize: 10, color: "#dfe5ec", fontWeight: 500 },
          },
          formatter: (v: string, idx: number) => {
            const [hz, clock] = v.split("\n");
            const gone = baseMs != null && baseMs + (idx + 1) * 3.6e6 < Date.now();
            if (gone) return clock ? `{past|${hz}}\n{pastc|${clock}}` : `{past|${hz}}`;
            return clock ? `${hz}\n{a|${clock}}` : hz;
          },
        },
      },
      {
        gridIndex: 1,
        type: "category",
        data: frameLabels,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: "#e2e8f0" } },
        // The reader read these bars as a running total. It is a total
        // ACROSS EXITS at one hour, never a total across the 12 hours -
        // so the title says "at each hour ahead" rather than just "total".
        name: `Exits congested at each hour ahead, of ${segments.length}`,
        nameLocation: "middle",
        nameGap: 38,
        nameTextStyle: { color: "#64748b", fontSize: 11, fontWeight: 700 },
        // Was dropping the clock line to save height, which left the bars
        // labelled only by horizon while the grid above showed the hour.
        // Same two-line format in both, so a column reads the same
        // wherever the eye lands.
        axisLabel: {
          show: true, color: "#64748b", fontSize: 10, fontWeight: 600, lineHeight: 12,
          // An elapsed column printed "10AM" in the same weight as a future
          // one, which is what let a stale forecast read as upcoming. Past
          // hours are greyed so the boundary between done and due is visible.
          rich: {
            a: { fontSize: 10, color: "#94a3b8", fontWeight: 500 },
            past: { fontSize: 11, color: "#cbd5e1", fontWeight: 600 },
            pastc: { fontSize: 10, color: "#dfe5ec", fontWeight: 500 },
          },
          formatter: (v: string, idx: number) => {
            const [hz, clock] = v.split("\n");
            const gone = baseMs != null && baseMs + (idx + 1) * 3.6e6 < Date.now();
            if (gone) return clock ? `{past|${hz}}\n{pastc|${clock}}` : `{past|${hz}}`;
            return clock ? `${hz}\n{a|${clock}}` : hz;
          },
        },
      },
    ],
    yAxis: [
      {
        gridIndex: 0,
        type: "category",
        data: shownSegments.map((s) => `${s}  ·  km ${kmLabel(KMI.get(s))}`),
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { color: "#334155", fontWeight: 600, fontSize: 11 },
      },
      {
        gridIndex: 1,
        type: "value",
        min: 0,
        max: segments.length,
        // Only 0 and the corridor total are labelled: enough to fix the scale,
        // without a ladder of numbers competing with the bar values themselves.
        interval: segments.length,
        splitLine: { show: true, lineStyle: { color: "#eef2f7" } },
        axisLabel: { show: true, color: "#94a3b8", fontSize: 10,
                     formatter: (v: number) => (v === 0 ? "0" : `${v} exits`) },
        axisLine: { show: false },
        axisTick: { show: false },
      },
    ],
    series: [
      {
        name: "Predicted congestion state",
        type: "heatmap",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: shownCells,
        // Only states that need action carry text; free-flow cells stay quiet.
        // A trailing * flags predictions the model is less sure about.
        label: {
          show: true,
          // The word was printed in EVERY cell of a run, so a segment that is
          // severe for twelve straight hours rendered "SEVERE*" twelve times.
          // Sixty repetitions of one word is noise, and it buried the thing that
          // matters - WHERE the bad stretch starts. Now only the first cell of a
          // run is labelled; the colour already carries the state, and the
          // tooltip carries the confidence.
          // Labelling every severe run when severe IS the corridor's state adds
          // 20 repetitions of the word the colour already carries. The useful
          // marks are the MINORITY states — the cells that break the pattern.
          // So a state is labelled only while it stays under a quarter of the
          // grid, which flips automatically if the forecast flips.
          formatter: (params: unknown) => {
            const d = (params as { data: CellItem }).data;
            if (d.state === "Pending") return "";
            if (!d.runStart || !minorityStates.has(d.state as State)) return "";
            return d.conf < LOW_CONF ? `${STATE_META[d.state].short}*` : STATE_META[d.state].short;
          },
          fontSize: 9,
          fontWeight: 700,
        },
        itemStyle: { borderColor: "#fff", borderWidth: 3, borderRadius: 4 },
        // Nothing on the grid is in the past now, so there is nothing to grey.
        emphasis: { itemStyle: { borderColor: "#0f172a", borderWidth: 2, shadowBlur: 10, shadowColor: "rgba(15,23,42,0.3)" } },
      },
      {
        name: "Segments congested",
        type: "bar",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: Array.from({ length: frameHours }, (_, i) => {
          if (i >= perHour.length) return { value: null, itemStyle: { color: "transparent" }, label: { show: false } };
          const n = perHour[i];
          return {
            value: n,
            itemStyle: { color: n === maxPerHour && n > 0 ? "#475569" : "#e2e8f0", borderRadius: [3, 3, 0, 0] },
            label: { color: n === maxPerHour && n > 0 ? "#334155" : "#94a3b8" },
          };
        }),
        barMaxWidth: 40,
        label: {
          show: true,
          position: "top",
          formatter: (p: unknown) => String((p as { value: number }).value || ""),
          fontSize: 11,
          fontWeight: 700,
        },
      },
    ],
  };

  const VISIBLE_ALERTS = 4;
  const shown = alerts.slice(0, VISIBLE_ALERTS);

  // Grouped by location for the full list — scanning "what happens at Bocaue"
  // beats scrolling 29 loose cards.
  const bySegment = segments
    .map((seg) => ({ seg, runs: alerts.filter((a) => a.segment === seg).sort((a, b) => a.from - b.from) }))
    .filter((g) => g.runs.length > 0)
    .sort((a, b) => (KMI.get(a.seg)?.km ?? 9999) - (KMI.get(b.seg)?.km ?? 9999));

  /* One row per episode. The cards each restated a heatmap row in three
     lines; a row does it in one and four of them fit where two cards did. */
  const alertRow = (a: Alert, key: string) => {
    const severe = a.state === "High";
    const span = a.to - a.from + 1;
    return (
      <div key={key} style={{ display: "grid", gridTemplateColumns: "64px 1fr auto auto", alignItems: "center", gap: 10, padding: "7px 10px", borderRadius: 8, background: severe ? "#fef2f2" : "#fffbeb", border: `1px solid ${severe ? "#fecaca" : "#fde68a"}`, fontSize: "0.8rem" }}>
        <span style={{ padding: "2px 7px", borderRadius: 999, textAlign: "center", background: severe ? STATE_META.High.color : STATE_META.Med.color, color: severe ? "#fff" : STATE_META.Med.text, fontSize: "0.62rem", fontWeight: 800, letterSpacing: "0.04em" }}>
          {severe ? "SEVERE" : "HEAVY"}
        </span>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <b style={{ color: "#0f172a" }}>{a.segment}</b> <span style={{ color: "#94a3b8" }}>km {kmLabel(KMI.get(a.segment))}</span>
        </span>
        <span style={{ color: "#475569", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          {/* Columns are now-relative: column 1 is the hour in progress, so it
              is "now" and column n is "+(n-1)h". */}
          {(() => {
            const rel = model.relHours;
            const lbl = (col: number) => {
              const n = rel[col - 1];
              return n == null ? `+${col}h` : n <= 0 ? "now" : `+${n}h`;
            };
            return a.from === a.to ? lbl(a.from) : `${lbl(a.from)} → ${lbl(a.to)}`;
          })()} <span style={{ color: "#94a3b8" }}>· {span}h</span>
        </span>
        <span style={{ color: a.conf < LOW_CONF ? "#b45309" : "#94a3b8", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{(a.conf * 100).toFixed(0)}%</span>
      </div>
    );
  };

  // A one-sentence read of the whole card, for stakeholders who will not
  // decode a 108-cell grid. The shape of the problem - one unbroken stretch of
  // road, bad for the whole window - is the thing to say.
  const nCongested = model.congestedSegments.length;
  const nSevere = model.severeSegments.length;
  const kmSpan =
    model.kmFrom != null && model.kmTo != null ? Math.round(model.kmTo - model.kmFrom) : null;

  const spH = model.perHour as number[];
  const firstCount = spH[0] ?? 0;
  const peakCount = Math.max(...spH);
  const peakAt = spH.indexOf(peakCount) + 1;
  const clear = segments.filter((sg) => !model.congestedSegments.includes(sg));

  const whoText =
    nCongested === segments.length
      ? `every exit on the corridor`
      : nCongested > segments.length * 0.6
      ? `all but ${clear.length} exit${clear.length === 1 ? "" : "s"} (${clear.join(", ")} keep${clear.length === 1 ? "s" : ""} moving)`
      : model.contiguous && kmSpan != null
      ? `${nCongested} neighbouring exits over about ${kmSpan} km, km ${model.kmFrom} to ${model.kmTo}`
      : `${nCongested} of ${segments.length} exits (${model.congestedSegments.join(", ")})`;

  // The grade to name: severe if any hour crawls, otherwise heavy.
  const worstWord = nSevere > 0 ? "severe" : "heavy";

  const headline = !model.firstAlert
    ? `Traffic is forecast to keep moving at every exit for the next ${hourLabels.length} hours.`
    : firstCount < peakCount
    ? `Congestion builds: ${firstCount} of ${segments.length} exit${firstCount === 1 ? "" : "s"} congested at +1h, rising to ${peakCount} by +${peakAt}h. By the peak it is ${whoText}${nSevere > 0 ? `, with ${nSevere} crawling under 10 km/h` : ""}.`
    : `${whoText.charAt(0).toUpperCase()}${whoText.slice(1)} — congested from the first hour${model.allHours ? ` and holding for the whole ${model.maxHour}-hour window` : ""}${nSevere > 0 ? `, ${nSevere} of them crawling under 10 km/h at some point` : ", none of it severe"}.`;

  const stat = (value: string, label: string, tone?: string, title?: string) => (
    <div title={title} style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      <span style={{ fontSize: "1.02rem", fontWeight: 800, color: tone ?? "#0f172a", letterSpacing: "-0.01em", fontVariantNumeric: "tabular-nums", lineHeight: 1.1, whiteSpace: "nowrap" }}>{value}</span>
      <span style={{ fontSize: "0.68rem", color: "#64748b" }}>{label}</span>
    </div>
  );

  const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(0)}%`);
  const hzFirst = hzAcc[0];
  const hzLast = hzAcc[hzAcc.length - 1];
  const beatsFrom = hzAcc.find(
    (a) => a.accuracy != null && a.persistenceAccuracy != null && a.accuracy > a.persistenceAccuracy);
  const hiddenSorted = [...hiddenSegments].sort((a, b) => (firstSevere(a) ?? 99) - (firstSevere(b) ?? 99));

  /* Layout, top to bottom: what am I looking at -> the finding -> four numbers
     -> the grid, with its own legend directly above it -> what to act on ->
     everything a reviewer wants behind one disclosure. The previous card put
     the accuracy strip between the title and the finding, the legend in the
     header far from the grid it explains, fifteen chips of exit names, and
     four three-line cards that each restated a heatmap row. */
  return (
    <article className="chart-card wide" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: "14px", marginTop: "24px" }}>
      {/* Row 1: title left, provenance right, anchor time beneath. */}
      <div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
            Predictive Congestion State Map
            <InfoTooltip text="Predicted jam state at each exit for the next 12 hours, from Waze jam reports. Red = crawling under 10 km/h, amber = heavy at 10-20 km/h, blue = moving freely or no jam reported. The cuts are this corridor's own: a generic 30 km/h threshold put every reported jam in one class." />
          </h3>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <span
              title={modelInfo && !modelInfo.accepted && modelInfo.rejectedReason ? modelInfo.rejectedReason : undefined}
              style={{
                fontSize: "0.7rem", padding: "2px 8px", borderRadius: "999px", fontWeight: 600, whiteSpace: "nowrap",
                background: modelInfo?.accepted ? "#ecfdf5" : "#f1f5f9",
                border: `1px solid ${modelInfo?.accepted ? "#a7f3d0" : "#dce2ef"}`,
                color: modelInfo?.accepted ? "#047857" : "#475569",
              }}
            >
              {modelInfo?.model ?? "—"}{modelInfo?.accuracy != null && ` · ${(modelInfo.accuracy * 100).toFixed(1)}%`}{modelInfo && !modelInfo.accepted && " · not accepted"}
            </span>
            {!expired && ageHours != null && ageHours > 2 && (
              <span
                title={`The hourly refresh has not published since ${model.baseTs}. Check the Scheduled Task "SmartFlow congestion refresh" and All_Scripts/Predictive_Modeling/refresh_congestion.log.`}
                style={{
                  fontSize: "0.7rem", padding: "2px 8px", borderRadius: 999, fontWeight: 700, cursor: "help", whiteSpace: "nowrap",
                  background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e",
                }}
              >
                {`⚠ refresh overdue · ${Math.round(ageHours)}h old`}
              </span>
            )}
            {expired && (
              <span
                title={`This forecast was generated from data ending ${model.baseTs} and its whole ${model.storedHours}-hour window has now passed. The hourly refresh task should replace it; see All_Scripts/Predictive_Modeling/README_congestion.md.`}
                style={{
                  fontSize: "0.7rem", padding: "2px 8px", borderRadius: 999, fontWeight: 700, cursor: "help", whiteSpace: "nowrap",
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  color: "#b91c1c",
                }}
              >
                {`⚠ expired · ${Math.round(ageHours ?? 0)}h old`}
              </span>
            )}
          </div>
        </div>
        <p style={{ color: "#64748b", fontSize: "0.82rem", margin: "4px 0 0 0" }}>
          {expired
            ? <>No hours left in this forecast · last covered <b style={{ color: "#334155" }}>{baseLabel(model.baseTs) ?? "the last reading"}</b></>
            : <>Forecast made <b style={{ color: "#334155" }}>{baseLabel(model.baseTs) ?? "at the last reading"}</b>,
                {isWeek ? <> next {model.dayCount} days</> : <> next {frameHours} hours</>}
                {" "}· renews every hour
                {!isWeek && frameHours > hourLabels.length && (
                  <span style={{ color: "#b45309" }}> · {frameHours - hourLabels.length} hour{frameHours - hourLabels.length === 1 ? "" : "s"} not yet forecast</span>
                )}</>}
          <span style={{ cursor: "help" }} title="Rows are exits ordered north-bound by km-post. Hover any cell for the model's confidence. The base time is the last complete hour of Waze ingestion."></span>
        </p>
      </div>

      {/* Row 2: the finding. */}
      <div style={{
        padding: "12px 14px", borderRadius: "10px", fontSize: "0.88rem", lineHeight: 1.5,
        background: nSevere > 0 ? "#fef2f2" : model.firstAlert ? "#fffbeb" : "#f0fdf4",
        border: `1px solid ${nSevere > 0 ? "#fecaca" : model.firstAlert ? "#fde68a" : "#bbf7d0"}`,
        color: nSevere > 0 ? "#991b1b" : model.firstAlert ? "#92400e" : "#166534",
      }}>
        {headline}
      </div>

      {/* Row 3: how many, where, how long, how sure — once each, one line. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "12px 18px", padding: "12px 16px", background: "var(--bg-surface-hover)", borderRadius: "10px" }}>
        {stat(`${nCongested} of ${segments.length}`, nCongested > 0 ? "exits with a jam" : "all moving",
              nCongested > 0 ? (nSevere > 0 ? "#b91c1c" : "#b45309") : "#15803d",
              nCongested > 0 ? `${nCongested} of ${segments.length} exits are expected to carry a jam somewhere in this window` : undefined)}
        {stat(kmSpan != null ? `km ${model.kmFrom}–${model.kmTo}` : "—",
              kmSpan != null ? `${kmSpan} km affected` : "none predicted", undefined,
              kmSpan != null ? (model.contiguous ? "One continuous stretch" : "Not contiguous — clear exits sit between the affected ones") : undefined)}
        {isWeek
          ? (() => {
              // Expected hours per day at the exit with the most of them. The
              // label count saturates over a week ("168 of 168h"); the summed
              // chances do not.
              const perExit = new Map<number, number>();
              model.dayCells.forEach((c) => perExit.set(c.value[1], (perExit.get(c.value[1]) ?? 0) + c.exact));
              const worstY = [...perExit.entries()].sort((a, b) => b[1] - a[1])[0];
              const days = Math.max(model.dayCount, 1);
              return stat(worstY ? `${(worstY[1] / days).toFixed(0)} h/day` : "—",
                          "at the worst exit",
                          worstY && worstY[1] / days >= 12 ? "#b91c1c" : undefined,
                          worstY ? `${segments[worstY[0]]} — the most congested hours per day of any exit` : undefined);
            })()
          : stat(model.allHours ? `all ${model.maxHour}h` : model.worstSegment ? `${model.worstSegmentCount} of ${hourLabels.length}h` : "—", model.flatHours ? "same every hour" : "at the worst exit")}
        {(() => {
          const pc = cells.filter((c) => c.state !== "Pending" && c.pCong != null).map((c) => c.pCong as number);
          if (pc.length) {
            const mean = pc.reduce((a, b) => a + b, 0) / pc.length;
            return stat(`${Math.round(mean * 100)}%`, "average jam chance", mean >= 0.5 ? "#b91c1c" : undefined,
                        "The mean chance of heavy or severe traffic across every cell on the grid");
          }
          return stat(model.confLo != null && model.confHi != null ? `${Math.round(model.confLo * 100)}–${Math.round(model.confHi * 100)}%` : "—",
              model.confLo != null && model.confLo < LOW_CONF ? "confidence · some cells under 80%" : "confidence across congested cells",
              model.confLo != null && model.confLo < LOW_CONF ? "#b45309" : undefined);
        })()}
      </div>

      {/* Row 4: the grid, with its legend and its exit picker attached to it. */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 2 }}>
          {/* How far ahead. The model forecasts a week either way; this picks
              how much of it the grid draws, and at what granularity. The help
              text lives on the buttons rather than in the layout: at this card
              width a sentence here pushed the exit picker onto its own row. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div role="group" aria-label="Forecast range" style={{ display: "inline-flex", background: "#f1f5f9", border: "1px solid #dce2ef", borderRadius: 999, padding: 2, gap: 2 }}>
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => setRange(r.key)}
                  title={r.help}
                  aria-pressed={range === r.key}
                  style={{
                    font: "inherit", fontSize: "0.72rem", fontWeight: 700, cursor: "pointer",
                    padding: "3px 11px", borderRadius: 999, border: "1px solid transparent", whiteSpace: "nowrap",
                    background: range === r.key ? "#fff" : "transparent",
                    borderColor: range === r.key ? "#c7d2fe" : "transparent",
                    color: range === r.key ? "#1d4ed8" : "#64748b",
                    boxShadow: range === r.key ? "0 1px 2px rgba(15,23,42,0.08)" : "none",
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>


          {/* Which exits are drawn. A select instead of fifteen chips: the
              reader pulls in the two or three they are responsible for. */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.72rem", color: "#64748b", flexWrap: "wrap" }}>
            <span><b style={{ color: "#475569" }}>{shownSegments.length}</b> of {segments.length} exits</span>
            {hiddenCount > 0 && (
              <select
                value=""
                onChange={(e) => { if (e.target.value) setExtraExits((cur) => [...cur, e.target.value]); }}
                title={urgentHidden ? "Some hidden exits turn severe sooner than any shown" : undefined}
                style={{ font: "inherit", fontWeight: 600, color: urgentHidden ? "#b45309" : "#475569", background: "#fff", border: `1px solid ${urgentHidden ? "#fcd9a4" : "#dce2ef"}`, borderRadius: 8, padding: "3px 8px", cursor: "pointer" }}
              >
                <option value="">{urgentHidden ? "⚠ Add exit…" : "Add exit…"}</option>
                {hiddenSorted.map((sg) => {
                  const f = firstSevere(sg);
                  return <option key={sg} value={sg}>{sg}{f != null ? ` — severe at +${f}h` : " — stays clear"}</option>;
                })}
              </select>
            )}
            {hiddenCount > 0 && (
              <button onClick={() => setExtraExits(hiddenSegments)} style={{ padding: "3px 9px", borderRadius: 999, cursor: "pointer", fontSize: "0.71rem", fontWeight: 700, background: "#fff", border: "1px solid #dce2ef", color: "#475569" }}>
                All {segments.length}
              </button>
            )}
            {extraExits.length > 0 && (
              <button onClick={() => setExtraExits([])} style={{ padding: "3px 6px", borderRadius: 999, cursor: "pointer", fontSize: "0.71rem", fontWeight: 600, background: "transparent", border: "none", color: "#94a3b8" }}>
                reset
              </button>
            )}
          </div>
        </div>

        {/* The legend belongs to the grid, not to the controls: sitting in the
            control row it wrapped onto a line of its own and read as a third
            bank of settings. Speeds are abbreviated here and spelled out on
            hover, so the whole key fits one line at this card width. */}
        <div style={{
          display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
          fontSize: "0.71rem", color: "#64748b",
          padding: "6px 2px", borderTop: "1px solid #f1f5f9", marginTop: 8,
        }}>
          {isWeek ? (
            <>
              {WEEK_BANDS.map((b) => (
                <span key={b.label} style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                  <span style={{ width: 10, height: 10, background: b.color, borderRadius: 3 }} />
                  {b.label}
                </span>
              ))}
              <span style={{ color: "#94a3b8" }}>expected congested hours per day</span>
            </>
          ) : (
            <>
              {(["Low", "Med", "High"] as State[]).map((st) => {
                const absent = st === "Med" && !model.everHeavy;
                return (
                  <span key={st}
                        title={absent ? "No exit-hour in this forecast falls in the 10-20 km/h band" : STATE_META[st].speed}
                        style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", opacity: absent ? 0.45 : 1 }}>
                    <span style={{ width: 10, height: 10, background: STATE_META[st].color, borderRadius: 3 }} />
                    <b style={{ fontWeight: 600, color: "#475569" }}>{STATE_META[st].label}</b>
                    <span style={{ color: "#94a3b8" }}>{STATE_META[st].brief}</span>
                  </span>
                );
              })}
              <span style={{ color: "#94a3b8" }}>km/h</span>
              {model.lowConfCount > 0 && <span style={{ color: "#94a3b8", whiteSpace: "nowrap" }}><b>*</b> under 80% sure</span>}
            </>
          )}
        </div>

        <div style={{ width: "100%", height: `${isWeek ? weekChartHeight : chartHeight}px` }}>
          <DashboardChart key={range} option={isWeek ? weekOption : option} height={isWeek ? weekChartHeight : chartHeight} />
        </div>
      </div>

      {/* Row 5: what to act on. Four rows; the rest in the dialog. */}
      <div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
          <h4 style={{ margin: 0, fontSize: "0.88rem", color: "#0f172a", fontWeight: 700 }}>
            What to act on <span style={{ color: "#94a3b8", fontWeight: 500 }}>
              · {alerts.length} episode{alerts.length === 1 ? "" : "s"}
              {(model.severeCount > 0 || model.heavyCount > 0) && <>
                {" · "}
                {[model.severeCount > 0 ? `${model.severeCount} severe` : null,
                  model.heavyCount > 0 ? `${model.heavyCount} heavy` : null].filter(Boolean).join(", ")}
              </>}
            </span>
          </h4>
          {alerts.length > VISIBLE_ALERTS && (
            <button onClick={() => setAlertsOpen(true)} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid #dce2ef", background: "#fff", borderRadius: 999, padding: "4px 12px", fontSize: "0.74rem", fontWeight: 600, color: "#475569", cursor: "pointer" }}>
              View all {alerts.length}
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          )}
        </div>
        <div style={{ display: "grid", gap: 6 }}>
          {alerts.length === 0 ? (
            <div style={{ padding: "10px 12px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, fontSize: "0.84rem", color: "#166534" }}>
              No heavy or severe congestion predicted in the next {hourLabels.length} hours.
            </div>
          ) : (
            shown.map((a, i) => alertRow(a, `${a.segment}-${a.from}-${i}`))
          )}
        </div>
      </div>

      {/* Row 6: the model's own read-out, in the open. The control that asks
          for it has to be visible, and the panel is the same one the forecast
          cards carry so the tab reads as one system. */}
      <CongestionNarrative
        modelInfo={
          modelInfo
            ? {
                model: modelInfo.model,
                accuracy: modelInfo.accuracy ?? null,
                accepted: Boolean(modelInfo.accepted),
                rejectedReason: modelInfo.rejectedReason ?? null,
                baseline: modelInfo.baseline ?? null,
              }
            : null
        }
        horizons={hzAcc.map((a) => ({
          horizon: a.horizon,
          accuracy: a.accuracy,
          persistenceAccuracy: a.persistenceAccuracy,
        }))}
        exitsTotal={segments.length}
        exitsSevere={nSevere}
        hoursCovered={hourLabels.length}
        neverPredictsHeavy={!model.everHeavy}
      />

      {/* Row 7: model evidence, behind one disclosure. */}
      {hzAcc.length > 1 && hzFirst && hzLast && (
        <details style={{ fontSize: "0.76rem", color: "#64748b", borderTop: "1px solid #eef2f7", paddingTop: 10 }}>
          <summary
            className="evidence-summary"
            style={{ cursor: "pointer", listStyle: "none", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}
          >
            <span style={{
              display: "grid", placeItems: "center", width: 28, height: 28, borderRadius: 8,
              background: "color-mix(in srgb, var(--color-success) 14%, transparent)", color: "var(--color-success)", flex: "none",
            }}>
              <ShieldCheck size={16} strokeWidth={2.4} />
            </span>
            <span style={{ fontSize: "0.98rem", fontWeight: 800, letterSpacing: "-0.01em", color: "var(--text-primary)" }}>
              Validation evidence
            </span>
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 999,
              background: "var(--bg-surface-hover)", border: "1px solid var(--border-default)",
              fontSize: "0.74rem", fontWeight: 600, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums",
            }}>
              {(() => {
                const a0 = hzFirst.accuracy ?? 0; const a1 = hzLast.accuracy ?? 0;
                return a1 < a0 - 0.03 ? "accuracy fades with distance" : a1 > a0 + 0.03 ? "accuracy improves with distance" : "accuracy holds across the horizon";
              })()} · {pct(hzFirst.accuracy)} at +1h → {pct(hzLast.accuracy)} at +{hzLast.horizon}h
              {" · "}{beatsFrom ? "beats no-change" : "no better than no-change"}
            </span>
            <span className="evidence-chevron" style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, fontSize: "0.74rem", fontWeight: 600, color: "var(--text-secondary)" }}>
              <span className="evidence-open-label">Show</span>
              <span className="evidence-close-label">Hide</span>
              <ChevronRight size={15} strokeWidth={2.4} />
            </span>
          </summary>

          <div style={{ display: "grid", gap: 14, marginTop: 12, color: "#475569", lineHeight: 1.55 }}>
            {/* 1. How it was tested. One sentence, because everything below
                   is meaningless without knowing the numbers come from hours
                   the model never saw. */}
            <EvBlock n={1} title="How it was tested">
              {evalInfo ? (
                <>The model learned from the earlier weeks of Waze data, then had to forecast the <b>last {evalInfo.test_days} days it had never seen</b> —
                {" "}{evalInfo.test_rows.toLocaleString()} exit-hours. Every number here is scored on those unseen hours only.</>
              ) : (
                <>The model learned from the earlier weeks of Waze data and is scored only on the final days it never saw.</>
              )}
            </EvBlock>

            {/* 2. The proof a stakeholder can see: the same week, replayed. */}
            {evalInfo?.replay && evalInfo.replay.series.length > 1 && (
              <EvBlock n={2} title="Did past predictions match what really happened?">
                <p style={{ margin: "0 0 4px" }}>
                  Below is that unseen week, hour by hour, as the model would have forecast it
                  {" "}<b>{evalInfo.replay.horizon} hours in advance</b>. The dashed line is how many of the {evalInfo.replay.exits} exits it
                  expected to be congested (adding up each exit&apos;s chance); the solid line is how many actually were.
                </p>
                <ReplayChart series={evalInfo.replay.series} exits={evalInfo.replay.exits} />
                <div style={{
                  display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8, marginTop: 8,
                  padding: "8px 10px", borderRadius: 8, background: "var(--bg-surface-hover)", border: "1px solid var(--border-default)",
                }}>
                  {[[`${evalInfo.replay.mae_exits.toFixed(1)} exits`, "average gap between the lines"],
                    [evalInfo.replay.corr.toFixed(2), "correlation \u00b7 1.00 traces perfectly"],
                    [pct(evalInfo.replay.match_rate), "exit-hours with the exact state right"]].map(([v, l]) => (
                    <div key={l} style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                      <span style={{ fontSize: "0.95rem", fontWeight: 800, color: "#0f172a", fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{v}</span>
                      <span style={{ fontSize: "0.68rem", color: "#64748b" }}>{l}</span>
                    </div>
                  ))}
                </div>
                {evalInfo.replay.examples.length > 0 && (
                  <div style={{ display: "grid", gap: 3, marginTop: 7, fontSize: "0.72rem", color: "#64748b" }}>
                    {evalInfo.replay.examples.map((ex) => (
                      <div key={ex.kind}>
                        <span>{ex.kind.charAt(0).toUpperCase() + ex.kind.slice(1)}</span> —
                        {" "}<b style={{ color: "#0f172a" }}>{new Date(ex.t.replace(" ", "T")).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", hour12: true })}</b>:
                        {" "}expected {ex.expected} of {ex.exits} congested, actually {ex.actual}.
                      </div>
                    ))}
                  </div>
                )}
              </EvBlock>
            )}

            {/* 3. What the headline percentage means, against the guesses a
                   person could make without a model. */}
            <EvBlock n={evalInfo?.replay ? 3 : 2} title={`What ${modelInfo?.accuracy != null ? (modelInfo.accuracy * 100).toFixed(1) + "%" : "the accuracy"} means`}>
              <p style={{ margin: "0 0 8px" }}>
                Out of every 100 exit-hours in that unseen window, the model named the right state (Moving, Heavy or Severe) for about
                {" "}<b>{modelInfo?.accuracy != null ? Math.round(modelInfo.accuracy * 100) : "—"}</b>. That only means something next to what you would score without a model:
              </p>
              <div style={{ display: "grid", gap: 5 }}>
                {[
                  { label: `${modelInfo?.model ?? "Model"} (this card)`, v: modelInfo?.accuracy ?? null, tone: "#16a34a", bold: true },
                  { label: `Assume each exit does what it usually does at this hour`, v: modelInfo?.baseline?.accuracy ?? null, tone: "#94a3b8" },
                  { label: `Assume nothing changes from now (+1h)`, v: hzFirst?.persistenceAccuracy ?? null, tone: "#94a3b8" },
                  { label: `Assume nothing changes from now (+${hzLast?.horizon ?? 12}h)`, v: hzLast?.persistenceAccuracy ?? null, tone: "#94a3b8" },
                  { label: `Always say "Moving"`, v: evalInfo ? Math.max(...Object.values(evalInfo.class_share)) : null, tone: "#94a3b8" },
                ].filter((r) => r.v != null).map((r) => (
                  <div key={r.label} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 44px", alignItems: "center", gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: "0.72rem", color: r.bold ? "#0f172a" : "#64748b", fontWeight: r.bold ? 700 : 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</div>
                      <div style={{ height: 6, borderRadius: 3, background: "#eef2f7", overflow: "hidden", marginTop: 3 }}>
                        <div style={{ width: `${Math.round((r.v as number) * 100)}%`, height: "100%", background: r.tone, borderRadius: 3 }} />
                      </div>
                    </div>
                    <span style={{ fontWeight: r.bold ? 800 : 600, color: r.bold ? "#0f172a" : "#64748b", fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{pct(r.v as number)}</span>
                  </div>
                ))}
              </div>
            </EvBlock>

            {/* 3. Per state: how much to trust each colour. */}
            {evalInfo && (
              <EvBlock n={evalInfo.replay ? 4 : 3} title="How much to trust each colour">
                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.74rem", fontVariantNumeric: "tabular-nums" }}>
                    <thead>
                      <tr style={{ color: "#64748b", textAlign: "left" }}>
                        <th style={{ padding: "4px 6px 6px 0", fontWeight: 600 }}>State</th>
                        <th style={{ padding: "4px 6px 6px", fontWeight: 600 }}>Share of real hours</th>
                        <th style={{ padding: "4px 6px 6px", fontWeight: 600 }}>When the card shows it, it is right</th>
                        <th style={{ padding: "4px 0 6px 6px", fontWeight: 600 }}>Of the real hours, it catches</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(["Low", "Med", "High"] as State[]).map((st) => {
                        const meta = STATE_META[st];
                        const pc = evalInfo.per_class[st];
                        const share = evalInfo.class_share[st];
                        if (!pc) return null;
                        return (
                          <tr key={st} style={{ borderTop: "1px solid #eef2f7" }}>
                            <td style={{ padding: "6px 6px 6px 0", whiteSpace: "nowrap" }}>
                              <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: meta.color, marginRight: 6, verticalAlign: -1 }} />
                              <b style={{ color: "#0f172a" }}>{meta.label}</b>
                            </td>
                            <td style={{ padding: "6px" }}>{share != null ? pct(share) : "—"}</td>
                            <td style={{ padding: "6px", fontWeight: 700, color: pc.precision >= 0.6 ? "#15803d" : pc.precision >= 0.4 ? "#b45309" : "#b91c1c" }}>{pct(pc.precision)}</td>
                            <td style={{ padding: "6px 0 6px 6px", fontWeight: 700, color: pc.recall >= 0.6 ? "#15803d" : pc.recall >= 0.4 ? "#b45309" : "#b91c1c" }}>{pct(pc.recall)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {evalInfo.per_class.High && evalInfo.per_class.High.recall < 0.3 && (
                  <p style={{ margin: "8px 0 0", fontSize: "0.72rem", color: "#b45309" }}>
                    Severe hours are rare and the model names them cautiously, so it misses most of them as a label — check the <b>severe %</b> in each cell&apos;s tooltip rather than waiting for a red cell.
                  </p>
                )}
              </EvBlock>
            )}

            {/* 4. The chance is a real chance. This is the one that makes the
                   card a forecast rather than a colour. */}
            {evalInfo && evalInfo.calibration.length > 0 && (
              <EvBlock n={evalInfo.replay ? 5 : 4} title="Is a 60% chance really 60%?">
                <p style={{ margin: "0 0 8px" }}>
                  Yes — the probabilities are calibrated on held-back hours, like a rain forecast. Each chip below is a group of unseen hours where the card would have shown roughly that chance of congestion, next to how often congestion actually happened:
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {evalInfo.calibration.filter((c) => c.n >= 200).map((c) => {
                    const gap = Math.abs(c.predicted - c.observed);
                    return (
                      <span key={c.lo} title={`${c.n.toLocaleString()} unseen exit-hours`} style={{
                        display: "inline-flex", alignItems: "baseline", gap: 4, padding: "3px 8px", borderRadius: 6,
                        background: gap <= 0.05 ? "#f0fdf4" : gap <= 0.1 ? "#fffbeb" : "#fef2f2",
                        border: `1px solid ${gap <= 0.05 ? "#bbf7d0" : gap <= 0.1 ? "#fde68a" : "#fecaca"}`,
                        fontSize: "0.72rem", fontVariantNumeric: "tabular-nums",
                      }}>
                        <span style={{ color: "#64748b" }}>said</span> <b>{Math.round(c.predicted * 100)}%</b>
                        <span style={{ color: "#94a3b8" }}>→</span>
                        <span style={{ color: "#64748b" }}>happened</span> <b>{Math.round(c.observed * 100)}%</b>
                      </span>
                    );
                  })}
                </div>
                <p style={{ margin: "8px 0 0", fontSize: "0.72rem", color: "#64748b" }}>
                  Green: within 5 points. Brier score {evalInfo.brier.toFixed(3)} — the average squared error of the probabilities, where 0 is perfect and 0.667 is a coin toss between the three states.
                </p>
              </EvBlock>
            )}

            {/* 5. Accuracy by hour ahead (the original bars). */}
            <EvBlock n={evalInfo ? (evalInfo.replay ? 6 : 5) : 3} title="Does it hold up 12 hours out?">
              <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 34 }}>
                {hzAcc.map((a) => {
                  const beats = a.accuracy != null && a.persistenceAccuracy != null && a.accuracy > a.persistenceAccuracy;
                  return (
                    <span key={a.horizon} title={`+${a.horizon}h — model ${pct(a.accuracy)}, "nothing changes" ${pct(a.persistenceAccuracy)}`}
                          style={{ width: 14, borderRadius: 2, background: beats ? "#16a34a" : "#cbd5e1", height: `${Math.max(4, ((a.accuracy ?? 0) - 0.5) * 110)}px` }} />
                  );
                })}
              </div>
              <p style={{ margin: "6px 0 0", fontSize: "0.72rem", color: "#64748b" }}>
                  {pct(hzFirst.accuracy)} at +1h → {pct(hzLast.accuracy)} at +{hzLast.horizon}h · green where it beats assuming nothing changes
                  {hzLast.persistenceAccuracy != null && <>, which falls to {pct(hzLast.persistenceAccuracy)} by +{hzLast.horizon}h</>}
              </p>
            </EvBlock>

            <p style={{ margin: 0, fontSize: "0.72rem", color: "#94a3b8" }}>
              States are cut from Waze jam speeds at this corridor&apos;s own distribution — Severe under {evalInfo?.thresholds_kmh.severe_below ?? 10} km/h, Heavy {evalInfo?.thresholds_kmh.severe_below ?? 10}–{evalInfo?.thresholds_kmh.heavy_below ?? 20} km/h, Moving above that or no jam reported.
              {!model.everHeavy && <> The current forecast has no Heavy hour.</>}
            </p>
          </div>
        </details>
      )}

      {/* Full list in a dialog — the inline expander pushed the rest of the
          page down and trapped 29 cards in a small scroll box. */}
      {alertsOpen && (
        <div role="dialog" aria-modal="true" aria-label="All predicted congestion episodes" onClick={() => setAlertsOpen(false)}
             style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(15, 23, 42, 0.55)", display: "grid", placeItems: "center", padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()}
               style={{ width: "min(980px, 100%)", maxHeight: "84vh", display: "flex", flexDirection: "column", background: "#fff", borderRadius: 14, boxShadow: "0 24px 60px rgba(15,23,42,0.3)", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, padding: "18px 22px", borderBottom: "1px solid #e2e8f0" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>Predicted congestion · next {hourLabels.length} hours</h3>
                <p style={{ margin: "4px 0 0 0", fontSize: "0.8rem", color: "#64748b" }}>
                  {alerts.length} episodes across {bySegment.length} segments · <b style={{ color: "#b91c1c" }}>{model.severeCount} severe</b>, <b style={{ color: "#b45309" }}>{alerts.length - model.severeCount} heavy</b> · grouped by location
                </p>
              </div>
              <button onClick={() => setAlertsOpen(false)} aria-label="Close"
                      style={{ flex: "none", width: 32, height: 32, borderRadius: 8, border: "1px solid #e2e8f0", background: "#fff", color: "#475569", cursor: "pointer", display: "grid", placeItems: "center", fontSize: "1rem", lineHeight: 1 }}>
                ✕
              </button>
            </div>
            <div style={{ overflowY: "auto", padding: "18px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
              {bySegment.map(({ seg, runs }) => (
                <div key={seg}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: "0.88rem", fontWeight: 700, color: "#0f172a" }}>{seg}</span>
                    <span style={{ fontSize: "0.74rem", color: "#94a3b8" }}>km {kmLabel(KMI.get(seg))}</span>
                    <span style={{ flex: 1, borderBottom: "1px solid #eef2f7" }} />
                    <span style={{ fontSize: "0.74rem", color: "#94a3b8" }}>{runs.length} {runs.length === 1 ? "episode" : "episodes"}</span>
                  </div>
                  <div style={{ display: "grid", gap: 6 }}>
                    {runs.map((a, i) => alertRow(a, `modal-${seg}-${a.from}-${i}`))}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ padding: "12px 22px", borderTop: "1px solid #e2e8f0", background: "#f8fafc", fontSize: "0.75rem", color: "#94a3b8" }}>
              Confidence is the model&apos;s certainty in its classification, not the probability of congestion. Press Esc to close.
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
