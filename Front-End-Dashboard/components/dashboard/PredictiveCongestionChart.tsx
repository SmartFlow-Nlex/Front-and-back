"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import InfoTooltip from "./InfoTooltip";
import CongestionNarrative from "./CongestionNarrative";
import { loadForecast } from "./prescriptiveTraffic.shared";
import { REPLAY_ACTUAL, REPLAY_FORECAST, useMeasuredWidth } from "./replayViz";
import { plazaLabel } from "../../lib/nlex-exits";
import { fmtKm } from "../../lib/km-post";
import { useChartTheme, heatRamp, type ChartTheme } from "../../lib/chart-theme";
import { useTrafficPalette, type TrafficPalette } from "./trafficPalette";
import SignalGlyph from "./SignalGlyph";
import StateNote from "../stage/StateNote";
import EvidenceModal from "./EvidenceModal";

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
                baseTs?: string | null;
                /** The typical jam at this exit, hour and severity, from Waze
                 *  history (gold.congestion_jam_profile). Null where the exit has
                 *  too little near-plaza history to say. */
                jamQueueM?: number | null; jamQueueP75M?: number | null;
                jamDelayS?: number | null; jamDelayP75S?: number | null;
                jamDistM?: number | null; jamSpeedKmh?: number | null;
                jamBasisHours?: number | null; jamBasis?: "hour" | "exit" | "corridor" | null;
                /** Typical vehicles per hour at this exit for the forecast hour,
                 *  2022-2025 toll data, and that relative to the exit's median
                 *  hour (gold.exit_volume_profile). */
                volMedian?: number | null; volP75?: number | null; volRel?: number | null };

/**
 * The state a cell is SHOWN as.
 *
 * The model names the likeliest of three states, so 41% Moving beat 30% Heavy
 * plus 29% Severe and the cell was painted blue beside a tooltip saying 59%
 * chance of congestion -- 244 cells of one run said both. On held-out hours the
 * model's congestion chance is calibrated above 50% (said 55% -> 51% happened,
 * 66% -> 61%, 75% -> 71%, 85% -> 86%), so "jam or not" is decided by that
 * chance, and the severity by whichever of Heavy and Severe is likelier. The
 * live score (Validation evidence) measures both rules on served forecasts.
 */
/* The state the model stored: its own decision rule, which counts the chance of Severe 1.5 times (chosen on the test
   window, 27 Oct 2026). The mobile app shows this state and the published accuracy scores it, so the card does too
   (fix list A25, 2 Nov 2026). It used to repaint cells as a jam whenever heavy + severe reached 50%, so the card,
   the app and the accuracy figure could each describe a different forecast. */
function shownState(d: RawRow): State {
  return d.state;
}

/**
 * A chance, as the card prints it. The model's calibration occasionally lands
 * on exactly 0 or 1, and "100%" is a promise: scored against what happened,
 * the cells it printed as 100% jammed 86% of the time (and its 80-99% cells
 * 92%). Past 95% and under 5% it now says so rather than claiming certainty.
 */
export function fmtChance(p: number): string {
  if (p >= 0.95) return ">95%";
  if (p <= 0.05) return "<5%";
  return `${Math.round(p * 100)}%`;
}

/** "1,880 veh/h" plus how busy that is for this exit. */
const volText = (v: number) => `${Math.round(v / 10) * 10 >= 1000 ? (Math.round(v / 10) * 10).toLocaleString() : Math.round(v / 10) * 10} veh/h`;
const volBusy = (rel: number) =>
  rel >= 1.5 ? "a peak hour here" : rel >= 1.15 ? "busier than usual here" : rel >= 0.85 ? "a usual hour here" : rel >= 0.5 ? "quieter than usual here" : "a quiet hour here";

/** What a jam here typically looks like, in the live map's own terms. */
type Jam = {
  queueM: number; queueP75M: number | null;
  delayS: number; delayP75S: number | null;
  distM: number | null; speedKmh: number | null;
  /** How many past jam-hours the figures rest on. */
  basisHours: number;
  /** "hour": this exit at this hour and day type. "exit": this exit at any
   *  hour, used where that hour has too few past jams to stand alone.
   *  "corridor": the whole corridor, for an exit with no near-plaza history. */
  basis: "hour" | "exit" | "corridor";
};

function jamOf(r: RawRow): Jam | null {
  if (r.jamQueueM == null || r.jamDelayS == null) return null;
  return {
    queueM: Number(r.jamQueueM),
    queueP75M: r.jamQueueP75M == null ? null : Number(r.jamQueueP75M),
    delayS: Number(r.jamDelayS),
    delayP75S: r.jamDelayP75S == null ? null : Number(r.jamDelayP75S),
    distM: r.jamDistM == null ? null : Number(r.jamDistM),
    speedKmh: r.jamSpeedKmh == null ? null : Number(r.jamSpeedKmh),
    basisHours: Number(r.jamBasisHours ?? 0),
    basis: r.jamBasis === "exit" || r.jamBasis === "corridor" ? r.jamBasis : "hour",
  };
}

/* Distances and delays are worded exactly as the live map words them, so a
   forecast jam and a real one read the same: "280 m", "1.2 km", "2 min". The
   tilde marks them as typical rather than measured. */
const fmtM = (m: number) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const fmtDelay = (s: number) => {
  const m = Math.round(s / 60);
  return m < 1 ? "under 1 min" : `${m} min`;
};
/** Where the queue sits relative to the plaza. History records how far a jam
 *  was from the exit but not which carriageway it was on, so it cannot say
 *  "before" or "past" the way the live map can; "from" is what it knows. */
const jamWhere = (exit: string, j: Jam) =>
  j.distM == null ? `near ${plazaLabel(exit)}`
  : j.distM < 80 ? `at ${plazaLabel(exit)}`
  : `~${fmtM(j.distM)} from ${plazaLabel(exit)}`;
/** One line, for the headline and the episode rows' tooltips. */
const jamSummary = (exit: string, j: Jam) =>
  `~${fmtM(j.queueM)} queue ${jamWhere(exit, j)} · ~${fmtDelay(j.delayS)} delay`;
/** The short form for an episode row, whose title already names the exit: queue and delay only. */
const jamBrief = (j: Jam) => `~${fmtM(j.queueM)} queue · ~${fmtDelay(j.delayS)} delay`;

/** Traffic volume for the cell's hour, and what it says about a predicted
 *  jam: a jam in a peak hour is demand; one in a quiet hour is the kind an
 *  incident or roadworks causes, worth checking before planning around. */
function volTooltip(state: State | "Pending", volMedian?: number | null, volRel?: number | null): string {
  if (volMedian == null || volRel == null || state === "Pending") return "";
  const note =
    state !== "Low" && volRel < 0.7
      ? `<div style="margin-top:4px; color:var(--color-warning); font-size:0.8em; line-height:1.4;">A jam in a quiet hour is usually an incident or roadworks rather than demand.</div>`
      : state !== "Low" && volRel >= 1.3
      ? `<div style="margin-top:4px; color:var(--text-secondary); font-size:0.8em; line-height:1.4;">Fits the traffic: this is one of the exit's busiest hours.</div>`
      : "";
  return `
    <div style="margin-top:10px; display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; font-size:0.86em;">
      <span style="font-size:0.85em; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:var(--text-muted);">Traffic</span>
      <b style="color:var(--text-primary); font-variant-numeric:tabular-nums;">~${volText(volMedian)}</b>
      <span style="color:var(--text-muted);">${volRel.toFixed(1)}× · ${volBusy(volRel)}</span>
    </div>${note}`;
}

/** The jam block in a cell's tooltip, laid out like the live map's jam card:
 *  where it sits, then queue length, delay and speed. A cell the model expects
 *  to keep moving still shows it, muted and headed "If a jam forms", because
 *  "what would it look like" is the next question about a 40% hour. */
function jamTooltip(exit: string, state: State, j: Jam | null | undefined): string {
  if (!j) return "";
  const expected = state !== "Low";
  const ink = expected ? "var(--text-primary)" : "var(--text-secondary)";
  // The 75th percentile is only worth a mention when it says something the
  // median does not: a queue that is usually 300 m but often 900 m.
  const queueTail = j.queueP75M != null && j.queueP75M > j.queueM * 1.25 ? `3 in 4 under ${fmtM(j.queueP75M)}` : "";
  const delayTail = j.delayP75S != null && j.delayP75S > j.delayS * 1.25 ? `3 in 4 under ${fmtDelay(j.delayP75S)}` : "";
  const basis = j.basis === "hour"
    ? `Typical for ${exit} at this hour on this kind of day · ${j.basisHours.toLocaleString()} past jam-hours, Waze 2022–2026`
    : j.basis === "exit"
    ? `Typical for ${exit} at any hour; too few past jams at this hour to be specific · ${j.basisHours.toLocaleString()} jam-hours`
    : `Corridor-wide typical: ${exit} has too few past jams near its plaza to describe on its own`;
  const stat = (label: string, value: string, tail = "") => `
    <div style="min-width:0;">
      <div style="font-size:0.72em; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:var(--text-muted);">${label}</div>
      <div style="margin-top:2px; font-weight:700; color:${ink}; font-variant-numeric:tabular-nums; white-space:nowrap;">${value}</div>
      ${tail ? `<div style="margin-top:1px; font-size:0.72em; line-height:1.3; color:var(--text-muted);">${tail}</div>` : ""}
    </div>`;
  const accent = expected ? "var(--color-warning)" : "var(--text-muted)";
  return `
    <div style="margin-top:12px; padding:10px 12px 10px; border-radius:10px;
                background:color-mix(in srgb, ${expected ? "var(--color-warning)" : "var(--text-primary)"} 8%, transparent);
                box-shadow:inset 0 0 0 1px color-mix(in srgb, ${expected ? "var(--color-warning)" : "var(--text-primary)"} 22%, transparent);">
      <div style="font-size:0.74em; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; color:${accent};">${expected ? "Expected jam" : "If a jam forms"}</div>
      <div style="margin-top:3px; font-weight:600; line-height:1.35; color:${ink};">${jamWhere(exit, j)}</div>
      <div style="margin-top:8px; display:grid; grid-template-columns:repeat(${j.speedKmh != null ? 3 : 2}, minmax(0, 1fr)); gap:8px;">
        ${stat("Queue", `~${fmtM(j.queueM)}`, queueTail)}
        ${stat("Delay", `~${fmtDelay(j.delayS)}`, delayTail)}
        ${j.speedKmh != null ? stat("Speed", `~${Math.round(j.speedKmh)} km/h`) : ""}
      </div>
    </div>
    <div style="margin-top:7px; color:var(--text-muted); font-size:0.74em; line-height:1.45;">${basis}</div>`;
}

// Corridor position now arrives per row from the API as MEASURED km (sorting
// and spans use it; every label prints the official post through fmtKm), which
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
type StateMeta = Record<State, { rank: number; color: string; text: string; label: string; speed: string; brief: string }>;
/* Lane Signal: same blue / amber / red encoding, stepped for each theme so a
   cell never glares on the navy dark surface. The labels and bands are
   unchanged. */
const STATE_META_LIGHT: StateMeta = {
  Low: { rank: 0, color: "#d6e6f7", text: "#0d3f73", label: "Moving", speed: "no jam, or over 20 km/h", brief: "no jam / >20" },
  Med: { rank: 1, color: "#f0a63a", text: "#3d2400", label: "Heavy", speed: "10–20 km/h", brief: "10–20" },
  High: { rank: 2, color: "#d12f2f", text: "#ffffff", label: "Severe", speed: "under 10 km/h", brief: "<10" },
};
const STATE_META_DARK: StateMeta = {
  Low: { rank: 0, color: "#1b3866", text: "#cfe2ff", label: "Moving", speed: "no jam, or over 20 km/h", brief: "no jam / >20" },
  Med: { rank: 1, color: "#e0951f", text: "#1d1200", label: "Heavy", speed: "10–20 km/h", brief: "10–20" },
  High: { rank: 2, color: "#ff5c5c", text: "#1a0606", label: "Severe", speed: "under 10 km/h", brief: "<10" },
};

/* The week grid counts congested hours per day rather than naming a state, so
   it needs a scale rather than three labels. It is quantised from the SAME
   colours the hourly grid uses — free-flow blue through heavy amber to severe
   red — so "more red" means the same thing in both views. Each cell also
   prints its number, so the colour is a second reading of the value and never
   the only one. */
type WeekBand = { min: number; max: number; color: string; label: string };
const WEEK_BANDS_LIGHT: WeekBand[] = [
  { min: 0, max: 0, color: "#d6e6f7", label: "none" },
  { min: 1, max: 2, color: "#fde8c8", label: "1-2 h" },
  { min: 3, max: 5, color: "#f9c97f", label: "3-5 h" },
  { min: 6, max: 8, color: "#f0a63a", label: "6-8 h" },
  { min: 9, max: 24, color: "#d12f2f", label: "9 h+" },
];
const WEEK_BANDS_DARK: WeekBand[] = [
  { min: 0, max: 0, color: "#1b3866", label: "none" },
  { min: 1, max: 2, color: "#4d3a17", label: "1-2 h" },
  { min: 3, max: 5, color: "#8a6418", label: "3-5 h" },
  { min: 6, max: 8, color: "#e0951f", label: "6-8 h" },
  { min: 9, max: 24, color: "#ff5c5c", label: "9 h+" },
];
/* Night Corridor: Moving, Heavy and Severe are the road's three states, so
   they wear the three state tokens (--signal-clear / -slow / -congested),
   read as literals for the canvas. Labels, bands and the rule that picks a
   cell's state are unchanged. Cached per palette so the object keeps its
   identity between renders (the grid's memo depends on it). */
const stateMetaCache = new Map<string, StateMeta>();
function stateMetaFor(P: TrafficPalette): StateMeta {
  const key = `${P.isDark}|${P.clear}|${P.slow}|${P.congested}`;
  const hit = stateMetaCache.get(key);
  if (hit) return hit;
  const base = P.isDark ? STATE_META_DARK : STATE_META_LIGHT;
  const onDark = "#03060d";
  const onLight = "#ffffff";
  const meta: StateMeta = {
    Low: { ...base.Low, color: P.clear, text: P.isDark ? onDark : onLight },
    Med: { ...base.Med, color: P.slow, text: P.isDark ? onDark : onLight },
    High: { ...base.High, color: P.congested, text: P.isDark ? onDark : onLight },
  };
  stateMetaCache.set(key, meta);
  return meta;
}

/* The week grid counts expected congested HOURS: a magnitude, not a state.
   Shading the state colours into five steps would put a fourth and fifth
   "state" on the page, so it takes the Traffic accent's heat ramp instead,
   with the number printed in every cell. Bands and labels are unchanged. */
const weekBandsCache = new Map<boolean, { bands: WeekBand[]; ink: string[] }>();
function weekBandsFor(t: ChartTheme) {
  const hit = weekBandsCache.get(t.isDark);
  if (hit) return hit;
  const ramp = heatRamp(t);
  const pick = [0, 2, 3, 5, 6];
  const bands = WEEK_BANDS_LIGHT.map((b, i) => ({ ...b, color: ramp[pick[i]] }));
  // Text on each band, chosen for contrast with that step of the ramp.
  const ink = t.isDark
    ? ["#f4f1ea", "#f4f1ea", "#f4f1ea", "#03060d", "#03060d"]
    : ["#0b1220", "#0b1220", "#ffffff", "#ffffff", "#ffffff"];
  const out = { bands, ink };
  weekBandsCache.set(t.isDark, out);
  return out;
}
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

/** The hour starting `hoursAhead` after the base, in words: "Fri 17 Oct, 3 PM". */
function hourStamp(baseTs: string | null | undefined, hoursAhead: number): string | null {
  if (!baseTs) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(baseTs);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  d.setHours(d.getHours() + hoursAhead);
  const day = d.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" });
  return `${day}, ${d.toLocaleTimeString("en-US", { hour: "numeric", hour12: true })}`;
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
      <div className="nct-key" style={{ justifyContent: "flex-end", marginBottom: 2 }}>
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
              <line x1={padL} x2={w - padR} y1={y(top * f)} y2={y(top * f)} style={{ stroke: "var(--chart-split)" }} strokeWidth={1} />
              <text x={padL - 6} y={y(top * f) + 3} textAnchor="end" fontSize={11} style={{ fill: "var(--text-muted)" }}>{Math.round(top * f)}</text>
            </g>
          ))}
          {dayStarts.map(({ i, d }) => (
            <g key={i}>
              <line x1={x(i)} x2={x(i)} y1={padT} y2={padT + plotH} style={{ stroke: "var(--chart-split)" }} strokeWidth={1} />
              <text x={x(i)} y={H - 5} textAnchor="middle" fontSize={11} style={{ fill: "var(--text-muted)" }}>
                {new Date(d.t.replace(" ", "T")).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </text>
            </g>
          ))}

          {/* Actual is the ground truth, so it carries the fill. */}
          <path d={`${path((d) => d.a)} L${x(series.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill={REPLAY_ACTUAL} opacity={0.09} />
          <path d={path((d) => d.a)} fill="none" stroke={REPLAY_ACTUAL} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d={path((d) => d.e)} fill="none" stroke={REPLAY_FORECAST} strokeWidth={2} strokeDasharray="5 3" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />

          <text x={padL + plotW + 6} y={ends.a + 3} fontSize={11} fontWeight={600} fill={REPLAY_ACTUAL}>Actual</text>
          <text x={padL + plotW + 6} y={ends.e + 3} fontSize={11} fontWeight={600} fill={REPLAY_FORECAST}>Expected</text>

          {hv && (
            <g pointerEvents="none">
              <line x1={x(hover!)} x2={x(hover!)} y1={padT} y2={padT + plotH} style={{ stroke: "var(--text-muted)" }} strokeWidth={1} />
              <circle cx={x(hover!)} cy={y(hv.a)} r={4} fill={REPLAY_ACTUAL} style={{ stroke: "var(--bg-surface)" }} strokeWidth={2} />
              <circle cx={x(hover!)} cy={y(hv.e)} r={4} fill={REPLAY_FORECAST} style={{ stroke: "var(--bg-surface)" }} strokeWidth={2} />
            </g>
          )}
        </svg>
      )}
      {hv && (
        <div style={{
          position: "absolute", left: hvLeft, top: hvTop, transform: "translateX(-50%)", pointerEvents: "none",
          background: "var(--bg-raised)", border: "1px solid var(--border-strong)", borderRadius: 10, padding: "8px 11px",
          boxShadow: "var(--shadow-lg)", fontSize: "var(--fs-body)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", zIndex: 2,
        }}>
          <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 3 }}>
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
 *  over its answer, so a reader can skim the titles and stop at the one they
 *  came for. Each step opens and closes on its number or title (2026-10-26);
 *  the first starts open, so the window opens short. */
function EvBlock({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(n === 1);
  const toggle = () => setOpen((o) => !o);
  return (
    <div className="nct-ev-block">
      <button type="button" className="nct-ev-n" onClick={toggle} aria-expanded={open}
        aria-label={`${open ? "Close" : "Open"} step ${n}`} style={{ cursor: "pointer", border: "none", font: "inherit" }}>
        {n}
      </button>
      <div style={{ minWidth: 0 }}>
        <button type="button" className="nct-ev-title" onClick={toggle} aria-expanded={open}
          style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", background: "none",
                   border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 600, color: "inherit" }}>
          <span>{title}</span>
          <span aria-hidden="true" style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-muted)",
                transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▶</span>
        </button>
        {open && <div className="nct-ev-body">{children}</div>}
      </div>
    </div>
  );
}

const kmLabel = (e?: { km: number | null; est: boolean }) =>
  e?.km == null ? "—" : `${fmtKm(e.km)}${e.est ? "*" : ""}`;

type CellItem = {
  value: [number, number, number];
  /** Chance of congestion (heavy or severe), 0-1, when the row carries it. */
  pCong?: number | null;
  /** The calibrated chance of each state, so the tooltip can show why this
   *  cell is the colour it is rather than asserting a label twice. */
  pLow?: number | null;
  pMed?: number | null;
  pHigh?: number | null;
  /** "Pending" marks an hour inside the frame the stored forecast does not
      reach yet -- drawn blank, filled by the next hourly refresh. */
  state: State | "Pending";
  conf: number;
  /** First cell of a contiguous run of this state — the only one that is labelled. */
  label: { color: string };
  jam?: Jam | null;
  volMedian?: number | null;
  volRel?: number | null;
};

/** `jam` is the typical jam at the run's most confident hour: the one hour of
 *  the episode the model is surest about is the one to describe. */
type Alert = { segment: string; state: State; from: number; to: number; conf: number; jam: Jam | null;
                /** Typical volume relative to the exit's usual hour, at the same hour as `jam`. */
                volRel: number | null };

/** How often a near-plaza jam was reported, by how busy the hour was for the
 *  exit, 2022-2025 (gold.exit_volume_jam_eval). */
type VolumeEval = {
  from: string; to: string;
  bands: { band: number; label: string; exit_hours: number; jam_rate: number; severe_share: number }[];
};

/** Served forecasts scored against what happened (gold.v_congestion_forecast_score). */
type LiveScore = {
  buckets: {
    bucket: string; n: number; runs: number;
    argmax_state_acc: number; argmax_jam_acc: number; shown_jam_acc: number;
    brier: number; jam_rate: number; first_hour: string; last_hour: string;
  }[];
};

/** How the per-cell queue and delay figures held up against live jams the
 *  history never saw. Written by 11-gold-congestion-jam-profile.sql. */
type JamEval = {
  history_from: string; history_to: string; history_exit_hours: number | null;
  test_from: string; test_to: string; test_exit_hours: number; test_exit_hours_total: number;
  actual_queue_median_m: number; actual_delay_median_s: number;
  queue: { profile_median_err_m: number; corridor_median_err_m: number };
  delay: { profile_median_err_s: number; corridor_median_err_s: number };
};

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
  /** Every candidate scored on the same test rows (rank 1 is served). Absent on runs before 2026-10-26. */
  candidates?: { model: string; rank: number; accepted: boolean; accuracy: number; macro_f1: number;
                 severe_recall: number; heavy_recall: number }[];
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
  const [jamEval, setJamEval] = useState<JamEval | null>(null);
  const [volEval, setVolEval] = useState<VolumeEval | null>(null);
  const [liveScore, setLiveScore] = useState<LiveScore | null>(null);

  // One km lookup for the whole component: the heatmap, the alert list and the
  // detail drawer all order by corridor position and must agree on it.
  // Theme-aware literals: ECharts draws on a canvas and cannot read CSS vars.
  const chartTheme = useChartTheme();
  const P = useTrafficPalette();
  const STATE_META = stateMetaFor(P);
  const WEEK = weekBandsFor(chartTheme);
  const WEEK_BANDS = WEEK.bands;
  // Night Corridor literals for the canvas: the card surface for cell gaps,
  // the ink steps, a neutral for "not this", and a blank for pending hours.
  const K = { surface: P.surface, ink: P.ink, ink2: P.ink2, muted: P.muted, faint: P.neutral, faint2: P.neutral, border: P.hairline, hover: P.blank };

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
            setJamEval((fc.extras.congestionJamEval as JamEval | null | undefined) ?? null);
            setVolEval((fc.extras.congestionVolumeEval as VolumeEval | null | undefined) ?? null);
            setLiveScore((fc.extras.congestionLiveScore as LiveScore | null | undefined) ?? null);
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
    // How far the stored run actually reaches, independent of what is shown.
    const availableHours = Math.max(...raw.map((d) => d.hours));
    const storedHours = Math.min(availableHours, hourCap);
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
            availableHours,
            Array.from({ length: availableHours }, (_, i) => i + 1).filter(
              (h) => (startOf(h) as number) < thisHourStart,
            ).length,
          );
    /* The frame is the range the reader picked; the columns in it are filled
       from whatever the run still reaches past the elapsed hours. Only when
       the run genuinely runs out is the tail left blank. */
    const maxHour = Math.max(Math.min(storedHours, availableHours - skippedHours), 0);

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
    const jams: (Jam | null)[][] = segments.map(() => Array(maxHour).fill(null));
    const vols: (number | null)[][] = segments.map(() => Array(maxHour).fill(null));
    const cells: CellItem[] = [];

    raw.forEach((d) => {
      const y = segments.indexOf(d.segment);
      // Shift into now-relative columns; anything before column 0 has passed.
      const x = d.hours - 1 - skippedHours;
      if (y < 0 || x < 0 || x >= maxHour) return;
      const st = shownState(d);
      const pMed = d.pMed == null ? null : Number(d.pMed);
      const pHigh = d.pHigh == null ? null : Number(d.pHigh);
      const pCong = pMed != null && pHigh != null ? pMed + pHigh : null;
      // Confidence in what the cell SHOWS: the chance of a jam for a
      // congested cell, the chance of none for a moving one.
      const conf = pCong == null ? Number(d.probability) : st === "Low" ? 1 - pCong : pCong;
      states[y][x] = st;
      confs[y][x] = conf;
      const meta = STATE_META[st] ?? STATE_META.Low;
      probs[y][x] = pCong;
      const pLow = d.pLow == null ? null : Number(d.pLow);
      const jam = jamOf(d);
      jams[y][x] = jam;
      vols[y][x] = d.volRel == null ? null : Number(d.volRel);
      cells.push({
        value: [x, y, meta.rank], state: st, conf, pCong, pLow, pMed, pHigh, label: { color: meta.text }, jam,
        volMedian: d.volMedian == null ? null : Number(d.volMedian),
        volRel: d.volRel == null ? null : Number(d.volRel),
      });
    });

    // Blank cells for the hours the stored forecast does not reach.
    for (let y = 0; y < segments.length; y++) {
      for (let x = maxHour; x < frameHours; x++) {
        cells.push({ value: [x, y, 3], state: "Pending", conf: 0, label: { color: K.muted } });
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
        const firstCol = known.find((x) => states[y][x] === "Med" || states[y][x] === "High");
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
          if (confs[y][x] > run.conf) {
            run.conf = confs[y][x];
            run.jam = jams[y][x] ?? run.jam;
            run.volRel = vols[y][x] ?? run.volRel;
          }
        } else {
          if (run) alerts.push(run);
          run = on ? { segment: segments[y], state: st as State, from: x + 1, to: x + 1, conf: confs[y][x], jam: jams[y][x], volRel: vols[y][x] } : null;
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
    // Kept with their exit, so a span printed as km posts can also say which exits it runs between.
    const severeKms = [...atRisk]
      .map((seg) => ({ seg, km: KMI.get(seg)?.km }))
      .filter((r): r is { seg: string; km: number } => r.km != null)
      .sort((a, b) => a.km - b.km);
    const kmFrom = severeKms.length ? severeKms[0].km : null;
    const kmTo = severeKms.length ? severeKms[severeKms.length - 1].km : null;
    const kmFromExit = severeKms.length ? severeKms[0].seg : null;
    const kmToExit = severeKms.length ? severeKms[severeKms.length - 1].seg : null;

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
      kmFromExit,
      kmToExit,
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
    };
  }, [raw, KMI, hourCap, STATE_META]);

  if (!model) {
    return (
      <article className="chart-card wide nct-card">
        {loadError ? (
          <>
            <h3 className="nct-title">
              Predictive Congestion State Map
              <InfoTooltip text="Predicted jam state at each exit for the hours the forecast covers (up to 168 hours ahead; choose the range above), from Waze jam reports. Red = crawling under 10 km/h, amber = heavy at 10-20 km/h, blue = moving freely or no jam reported. The cuts are this corridor's own: a generic 30 km/h threshold put every reported jam in one class. Hover a cell for the typical queue length, its distance from the toll plaza and the delay, from four years of Waze jam history at that exit and hour." />
            </h3>
            <StateNote kind="error" role="alert">
              {loadError}
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="btn-muted"
                  onClick={() => { setLoadError(null); setAttempt((a) => a + 1); }}
                >
                  Try again
                </button>
              </div>
            </StateNote>
          </>
        ) : (
          <StateNote kind="loading">Loading ML congestion forecast from AWS…</StateNote>
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
    .map((c) => {
      const band = Math.max(0, WEEK_BANDS.findIndex((b) => c.hours >= b.min && c.hours <= b.max));
      return {
        ...c,
        value: [c.value[0], yMap.get(c.value[1])!, c.value[2]] as [number, number, number],
        label: { color: WEEK.ink[band] ?? K.ink },
      };
    });

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
      backgroundColor: P.tooltipBg,
      borderColor: P.tooltipBorder,
      borderWidth: 1,
      textStyle: { color: P.tooltipText },
      // Kept inside the chart box. Hovering a cell in the first few columns
      // otherwise threw the panel off the left edge of the card and under the
      // sidebar, where half of it could not be read.
      confine: true,
      extraCssText: P.tooltipCss,
      formatter: (params: unknown) => {
        const p = params as { data: DayCell; dataIndex: number };
        const d = p.data;
        const seg = shownSegments[d.value[1]] ?? "";
        const day = (model.dayLabels[d.value[0]] ?? "").replace("\n", " ");
        const km = kmLabel(KMI.get(seg));
        return `
          <div style="padding:2px 4px;">
            <b style="font-size:1.05em; color:var(--text-primary);">${seg}</b>
            <span style="color:var(--text-muted); font-size:0.85em;"> · km ${km}</span>
            <div style="margin-top:2px; color:var(--text-secondary); font-size:0.86em;">${day}</div>
            <div style="margin-top:9px; display:flex; align-items:baseline; justify-content:space-between; gap:14px;
                        padding-bottom:6px; border-bottom:1px solid var(--border-default);">
              <span style="color:var(--text-secondary);">Expected congested hours</span>
              <b style="font-size:1.15em; color:${d.hours >= 9 ? "var(--color-danger)" : K.ink};">${d.estimated ? d.exact.toFixed(1) : d.hours}<span style="font-weight:500; color:var(--text-muted); font-size:0.8em;"> of ${d.known}</span></b>
            </div>
            <div style="margin-top:7px; display:grid; grid-template-columns:auto auto; gap:5px 12px; font-size:0.88em; align-items:baseline;">
              ${d.severeHours > 0 ? `<span style="color:var(--text-secondary);">Of those, crawling</span><span style="font-weight:700; color:var(--color-danger); text-align:right;">${d.severeHours} h</span>` : ""}
              ${d.firstClock ? `<span style="color:var(--text-secondary);">First likely from</span><span style="font-weight:600; text-align:right;">${d.firstClock}</span>` : ""}
            </div>
            ${d.partial ? `<div style="margin-top:8px; color:var(--color-warning); font-size:0.82em; line-height:1.45;">Part of a day — only ${d.known} forecast hours fall on it.</div>` : ""}
            ${d.estimated ? `<div style="margin-top:8px; color:var(--text-muted); font-size:0.82em; line-height:1.45;">Each hour's chance of congestion, added up — not a count of hours.</div>` : ""}
          </div>`;
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
        color: K.ink2, fontWeight: 600, fontSize: 11, lineHeight: 13,
        rich: { a: { fontSize: 11, color: K.muted, fontWeight: 500 } },
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
      axisLabel: { color: K.ink, fontWeight: 600, fontSize: 11 },
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
        fontSize: 11,
        fontWeight: 600,
      },
      itemStyle: { borderColor: K.surface, borderWidth: 3, borderRadius: 4 },
      emphasis: { itemStyle: { borderColor: K.ink, borderWidth: 2, shadowBlur: 10, shadowColor: "rgba(0,0,0,0.35)" } },
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
        { value: 3, color: K.hover },   // pending: not yet forecast
      ],
    },
    tooltip: {
      backgroundColor: P.tooltipBg,
      borderColor: P.tooltipBorder,
      borderWidth: 1,
      textStyle: { color: P.tooltipText },
      // Kept inside the chart box. Hovering a cell in the first few columns
      // otherwise threw the panel off the left edge of the card and under the
      // sidebar, where half of it could not be read.
      confine: true,
      extraCssText: P.tooltipCss,
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
          <div style="padding:2px 4px; max-width:250px; white-space:normal;">
            <b style="font-size:1.05em; color:var(--text-primary);">${shownSegments[d.value[1]]}</b>
            <div style="margin-top:2px; color:var(--text-secondary); font-size:0.86em;">${(frameLabels[d.value[0]] ?? "").replace("\n", " · ")}</div>
            <div style="margin-top:8px; color:var(--text-muted); line-height:1.45;">Not yet forecast — the stored run stops short of this hour. The next hourly refresh fills it.</div>
          </div>`;
        }
        const [x, y] = d.value;
        const meta = STATE_META[d.state];
        const low = d.conf < LOW_CONF;
        const pill = `<span style="flex:none; padding:3px 10px; border-radius:999px; font-size:0.72em; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; color:${meta.text}; background:${meta.color};">${meta.label}</span>`;
        const probs = ([["High", d.pHigh], ["Med", d.pMed], ["Low", d.pLow]] as [State, number | null | undefined][])
          .filter((e): e is [State, number] => e[1] != null);
        return `
          <div style="padding:2px 2px 0; width:296px; max-width:100%; white-space:normal;">
            <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
              <div style="min-width:0;">
                <b style="font-size:1.05em; line-height:1.3; color:var(--text-primary);">${shownSegments[y]}</b>
                <div style="margin-top:2px; color:var(--text-muted); font-size:0.82em; font-variant-numeric:tabular-nums;">km ${kmLabel(KMI.get(shownSegments[y]))} · ${(hourLabels[x] ?? "").replace("\n", " · ")}</div>
              </div>
              ${pill}
            </div>
            ${d.pCong != null ? `
              <div style="margin-top:12px; display:flex; align-items:baseline; gap:8px;">
                <b style="font-size:1.9em; line-height:1; font-weight:600; color:${d.pCong >= 0.5 ? "var(--color-danger)" : K.ink}; font-variant-numeric:tabular-nums;">${fmtChance(d.pCong)}</b>
                <span style="color:var(--text-secondary); font-size:0.9em;">chance of congestion</span>
              </div>
              <div style="margin-top:9px; display:flex; height:8px; border-radius:4px; overflow:hidden; gap:2px;" aria-hidden="true">
                ${probs.map(([st, pr]) => `<span style="flex:${Math.max(0.0001, pr)} 1 0; background:${STATE_META[st].color};"></span>`).join("")}
              </div>
              <div style="margin-top:8px; display:grid; grid-template-columns:repeat(${probs.length}, minmax(0, 1fr)); gap:8px;">
                ${probs.map(([st, pr]) => {
                  const m = STATE_META[st];
                  const win = st === d.state;
                  return `<div style="min-width:0;">
                    <div style="display:flex; align-items:center; gap:5px; font-size:0.74em; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:${win ? "var(--text-primary)" : "var(--text-secondary)"};">
                      <span style="width:8px; height:8px; border-radius:2px; background:${m.color}; flex:none;"></span>${m.label}
                    </div>
                    <div style="margin-top:2px; font-size:1.02em; font-weight:${win ? 700 : 500}; color:var(--text-primary); font-variant-numeric:tabular-nums;">${fmtChance(pr)}</div>
                    <div style="margin-top:1px; font-size:0.72em; line-height:1.3; color:var(--text-muted);">${m.speed}</div>
                  </div>`;
                }).join("")}
              </div>
              ${(() => {
                /* Amber only for a near-tie, where the colour could as easily
                   have been the other state; a quiet grey line otherwise to
                   explain the asterisk the legend mentions. */
                const ranked = [...probs].sort((a, b) => b[1] - a[1]);
                if (ranked.length > 1) {
                  const gap = ranked[0][1] - ranked[1][1];
                  if (gap < 0.12) {
                    return `<div style="margin-top:9px; color:var(--color-warning); font-size:0.8em; line-height:1.45;">Close call: ${STATE_META[ranked[0][0]].label} and ${STATE_META[ranked[1][0]].label} are within ${Math.round(gap * 100)} points.</div>`;
                  }
                }
                return low ? `<div style="margin-top:9px; color:var(--text-muted); font-size:0.8em;">* the leading state is under 80% sure</div>` : "";
              })()}
            ` : `
              <div style="margin-top:10px; display:grid; grid-template-columns:auto 1fr; gap:5px 12px; font-size:0.9em;">
                <span style="color:var(--text-secondary);">Meaning</span><span style="font-weight:500;">${meta.speed}</span>
                <span style="color:var(--text-secondary);">Confidence</span><span style="font-weight:600; color:${low ? "var(--color-warning)" : K.ink};">${(d.conf * 100).toFixed(0)}%${low ? " · indicative" : ""}</span>
              </div>
            `}
            ${volTooltip(d.state, d.volMedian, d.volRel)}
            ${jamTooltip(shownSegments[y], d.state, d.jam)}
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
          // 11 px, the floor for chart text (A11Y-1); hideOverlap drops a label rather than smear two.
          color: K.ink2, fontWeight: 600, fontSize: 11, lineHeight: 13, hideOverlap: true,
          // Second line is the clock time, deliberately quieter than the horizon.
          // An elapsed column printed "10AM" in the same weight as a future
          // one, which is what let a stale forecast read as upcoming. Past
          // hours are greyed so the boundary between done and due is visible.
          rich: {
            a: { fontSize: 11, color: K.muted, fontWeight: 500 },
            /* Elapsed hours: muted italic. The 24% neutral they used was 2:1 on the card, below any
               reading floor; italic and the lighter ink still set them apart from the hours to come. */
            past: { fontSize: 11, color: K.muted, fontWeight: 500, fontStyle: "italic" },
            pastc: { fontSize: 11, color: K.muted, fontWeight: 400, fontStyle: "italic" },
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
        axisLine: { lineStyle: { color: K.border } },
        // The reader read these bars as a running total. It is a total
        // ACROSS EXITS at one hour, never a total across the 12 hours -
        // so the title says "at each hour ahead" rather than just "total".
        name: `Exits congested at each hour ahead, of ${segments.length}`,
        nameLocation: "middle",
        nameGap: 38,
        nameTextStyle: { color: K.ink2, fontSize: 11, fontWeight: 600 },
        // Was dropping the clock line to save height, which left the bars
        // labelled only by horizon while the grid above showed the hour.
        // Same two-line format in both, so a column reads the same
        // wherever the eye lands.
        axisLabel: {
          show: true, color: K.ink2, fontSize: 11, fontWeight: 600, lineHeight: 13, hideOverlap: true,
          // An elapsed column printed "10AM" in the same weight as a future
          // one, which is what let a stale forecast read as upcoming. Past
          // hours are greyed so the boundary between done and due is visible.
          rich: {
            a: { fontSize: 11, color: K.muted, fontWeight: 500 },
            past: { fontSize: 11, color: K.muted, fontWeight: 500, fontStyle: "italic" },
            pastc: { fontSize: 11, color: K.muted, fontWeight: 400, fontStyle: "italic" },
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
        axisLabel: { color: K.ink, fontWeight: 600, fontSize: 11 },
      },
      {
        gridIndex: 1,
        type: "value",
        min: 0,
        max: segments.length,
        // Only 0 and the corridor total are labelled: enough to fix the scale,
        // without a ladder of numbers competing with the bar values themselves.
        interval: segments.length,
        splitLine: { show: true, lineStyle: { color: K.hover } },
        axisLabel: { show: true, color: K.muted, fontSize: 11,
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
        /* No text in the cells. "SEVERE*" is about 45px of bold type and a
           cell here is roughly 19px wide, so the word never fitted: it spilled
           across its neighbours and read as a rendering fault rather than a
           label. Nothing is lost by dropping it. The colour carries the state
           with the legend directly above, the tooltip gives the full
           distribution for one cell, and the episode list below names every
           severe and heavy stretch with its exit, window and confidence. */
        label: { show: false },
        itemStyle: { borderColor: K.surface, borderWidth: 3, borderRadius: 4 },
        // Nothing on the grid is in the past now, so there is nothing to grey.
        emphasis: { itemStyle: { borderColor: K.ink, borderWidth: 2, shadowBlur: 10, shadowColor: "rgba(0,0,0,0.35)" } },
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
            itemStyle: { color: n === maxPerHour && n > 0 ? K.ink2 : K.faint, borderRadius: [4, 4, 0, 0] },
            label: { color: n === maxPerHour && n > 0 ? K.ink : K.muted },
          };
        }),
        barMaxWidth: 40,
        label: {
          show: true,
          position: "top",
          formatter: (p: unknown) => String((p as { value: number }).value || ""),
          fontSize: 11,
          fontWeight: 600,
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
      <div key={key} className={`nct-episode ${severe ? "is-severe" : "is-heavy"}`}>
        <span className={`pill ${severe ? "red" : "amber"} nct-episode-tag`}>
          <SignalGlyph state={severe ? "congested" : "slow"} size={16} plate={false} title="" />
          {severe ? "SEVERE" : "HEAVY"}
        </span>
        <span className="nct-episode-main">
          <span className="nct-episode-where">
            <b>{a.segment}</b> <span className="nct-dim">km {kmLabel(KMI.get(a.segment))}</span>
          </span>
          {/* The same three things the live map's jam card leads with, as
              typical figures for this exit at the episode's surest hour. */}
          {a.jam && (
            <span title={`${jamSummary(a.segment, a.jam)}. Typical for this exit at this hour, from four years of Waze jam history.`}
                  className="nct-episode-jam">
              {jamBrief(a.jam)}
              {a.volRel != null && (
                <span className={a.volRel < 0.7 ? "nct-warn" : "nct-dim"}>
                  {" · "}{a.volRel < 0.7 ? "quiet hour, check for incidents" : `${a.volRel.toFixed(1)}× usual`}
                </span>
              )}
            </span>
          )}
        </span>
        <span className="nct-episode-when">
          {/* Columns are now-relative: column 1 is the hour in progress, so it
              is "now" and column n is "+(n-1)h". */}
          {(() => {
            const rel = model.relHours;
            const lbl = (col: number) => {
              const n = rel[col - 1];
              return n == null ? `+${col}h` : n <= 0 ? "now" : `+${n}h`;
            };
            return a.from === a.to ? lbl(a.from) : `${lbl(a.from)} → ${lbl(a.to)}`;
          })()} <span className="nct-dim">· {span}h</span>
        </span>
        <span className={`nct-episode-conf${a.conf < LOW_CONF ? " nct-warn" : ""}`}>{(a.conf * 100).toFixed(0)}%</span>
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
      ? `${nCongested} neighbouring exits over about ${kmSpan} km, km ${fmtKm(model.kmFrom)} (${model.kmFromExit}) to km ${fmtKm(model.kmTo)} (${model.kmToExit})`
      : `${nCongested} of ${segments.length} exits (${model.congestedSegments.join(", ")})`;

  /* Presentation of the same "who": the variant is picked by exactly the
     conditions above; only the exit list moves out of the sentence into a
     labelled chip row under it. */
  const whoShort =
    nCongested === segments.length
      ? `every exit on the corridor`
      : nCongested > segments.length * 0.6
      ? `all but ${clear.length} exit${clear.length === 1 ? "" : "s"}`
      : model.contiguous && kmSpan != null
      ? whoText
      : `${nCongested} of ${segments.length} exits`;
  const whoList: { label: string; exits: string[] } | null =
    nCongested === segments.length
      ? null
      : nCongested > segments.length * 0.6
      ? { label: clear.length === 1 ? "Keeps moving" : "Keep moving", exits: clear }
      : model.contiguous && kmSpan != null
      ? null
      : { label: "Congested", exits: model.congestedSegments };

  // The grade to name: severe if any hour crawls, otherwise heavy.
  const worstWord = nSevere > 0 ? "severe" : "heavy";

  const headline = !model.firstAlert
    ? `Traffic is forecast to keep moving at every exit for the next ${hourLabels.length} hours.`
    : firstCount < peakCount
    ? `Congestion builds: ${firstCount} of ${segments.length} exit${firstCount === 1 ? "" : "s"} congested at +1h, rising to ${peakCount} by +${peakAt}h. By the peak it is ${whoShort}${nSevere > 0 ? `, with ${nSevere} crawling under 10 km/h` : ""}.`
    : `${whoShort.charAt(0).toUpperCase()}${whoShort.slice(1)} — congested from the first hour${model.allHours ? ` and holding for the whole ${model.maxHour}-hour window` : ""}${nSevere > 0 ? `, ${nSevere} of them crawling under 10 km/h at some point` : ", none of it severe"}.`;

  /* The worst episode, said the way the live map says a real jam: which
     plaza, how long a queue, how many minutes. Alerts are already ranked
     severe-first, then longest, then surest, so the first with a profile is
     the one to name. */
  const lead = alerts.find((a) => a.jam) ?? null;
  const leadText = (() => {
    if (!lead?.jam) return null;
    const n = model.relHours[lead.from - 1];
    const clock = hourClock(model.baseTs, model.skippedHours + lead.from);
    const when = n != null && n <= 0 ? "from now" : clock ? `from ${clock}` : `from +${n ?? lead.from}h`;
    return `${lead.state === "High" ? "Worst" : "Heaviest"}: ${lead.segment} ${when}, typically a ${jamSummary(lead.segment, lead.jam)}.`;
  })();
  // The same lead, as a labelled row: the label, then where and when, then the jam.
  const leadRow = (() => {
    if (!lead?.jam || !leadText) return null;
    const label = lead.state === "High" ? "Worst" : "Heaviest";
    const rest = leadText.slice(label.length + 2);
    const cut = rest.indexOf(", typically a ");
    return cut < 0
      ? { label, where: rest, jam: null as string | null }
      : { label, where: rest.slice(0, cut), jam: rest.slice(cut + 2) };
  })();

  const stat = (value: string, label: string, tone?: string, title?: string) => (
    <div title={title} className="nct-stat">
      <span className="nct-stat-value" style={tone ? { color: tone } : undefined}>{value}</span>
      <span className="nct-stat-label">{label}</span>
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
    <article className="chart-card wide nct-card">
      {/* Row 1: title left, provenance right, anchor time beneath. */}
      <div>
        <div className="nct-card-head-split">
          <h3 className="nct-title">
            Predictive Congestion State Map
            <InfoTooltip text="Predicted jam state at each exit for the hours the forecast covers (up to 168 hours ahead; choose the range above), from Waze jam reports. Red = crawling under 10 km/h, amber = heavy at 10-20 km/h, blue = moving freely or no jam reported. The cuts are this corridor's own: a generic 30 km/h threshold put every reported jam in one class. Hover a cell for the typical queue length, its distance from the toll plaza and the delay, from four years of Waze jam history at that exit and hour." />
          </h3>
          <div className="nct-pill-row">
            <span
              title={modelInfo && !modelInfo.accepted && modelInfo.rejectedReason ? modelInfo.rejectedReason : undefined}
              className={`pill${modelInfo?.accepted ? " green" : ""}`}
            >
              {modelInfo?.model ?? "—"}{modelInfo?.accuracy != null && ` · ${(modelInfo.accuracy * 100).toFixed(1)}%`}{modelInfo && !modelInfo.accepted && " · not accepted"}
            </span>
            {!expired && ageHours != null && ageHours > 2 && (
              <span
                title={`The hourly refresh has not published since ${model.baseTs}. Check the Scheduled Task "SmartFlow congestion refresh" and All_Scripts/Predictive_Modeling/refresh_congestion.log.`}
                className="pill amber"
                style={{ cursor: "help" }}
              >
                {`⚠ refresh overdue · ${Math.round(ageHours)}h old`}
              </span>
            )}
            {expired && (
              <span
                title={`This forecast was generated from data ending ${model.baseTs} and its whole ${model.storedHours}-hour window has now passed. The hourly refresh task should replace it; see All_Scripts/Predictive_Modeling/README_congestion.md.`}
                className="pill red"
                style={{ cursor: "help" }}
              >
                {`⚠ expired · ${Math.round(ageHours ?? 0)}h old`}
              </span>
            )}
          </div>
        </div>
        <p className="nct-sub">
          {expired
            ? <>No hours left in this forecast · last covered <b>{baseLabel(model.baseTs) ?? "the last reading"}</b></>
            : <>Forecast made <b>{baseLabel(model.baseTs) ?? "at the last reading"}</b>,
                {isWeek ? <> next {model.dayCount} days</> : <> next {frameHours} hours</>}
                {" "}· renews every hour
                {!isWeek && frameHours > hourLabels.length && (
                  <span className="nct-warn"> · {frameHours - hourLabels.length} hour{frameHours - hourLabels.length === 1 ? "" : "s"} not yet forecast</span>
                )}</>}
          <span style={{ cursor: "help" }} title="Rows are exits ordered north-bound by km-post. Hover any cell for the model's confidence. The base time is the last complete hour of Waze ingestion."></span>
        </p>
      </div>

      {/* How far ahead this whole card describes. It governs the finding and
          the four numbers below it, so it sits above them rather than under
          the grid -- and it lands where the event card beside this one puts
          its own SHOWING control, so the two read in the same order. The exit
          picker stays with the grid, which is the only thing it changes. */}
      <div className="nct-toolbar">
        <div className="nct-group">
          <span className="nct-group-label">Range</span>
          <div role="group" aria-label="Forecast range" className="nct-pills">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                title={r.help}
                aria-pressed={range === r.key}
                className={`nct-pill-btn${range === r.key ? " is-on" : ""}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Row 2: the finding. */}
      {/* The answer: the corridor's state in one sentence, with the road's own
          signal beside it, then the worst episode. */}
      <div className="nct-finding" data-tone={nSevere > 0 ? "congested" : model.firstAlert ? "slow" : "clear"}>
        <SignalGlyph state={nSevere > 0 ? "congested" : model.firstAlert ? "slow" : "clear"} size={26} />
        <div className="nct-finding-text">
          <p>{headline}</p>
          {whoList && whoList.exits.length > 0 && (
            <div className="nct-finding-chips">
              <span className="nct-kv-k">{whoList.label}</span>
              {whoList.exits.map((x) => <span key={x} className="nct-tiny-chip">{x}</span>)}
            </div>
          )}
          {leadRow && !isWeek && (
            <div className="nct-finding-kv">
              <span className="nct-kv-k">{leadRow.label}</span>
              <span><b>{leadRow.where}</b>{leadRow.jam && <span className="nct-soft"> · {leadRow.jam}</span>}</span>
            </div>
          )}
        </div>
      </div>

      {/* Row 3: how many, where, how long, how sure — once each.
          Two by two, matching the event card beside it. Four across fitted in a
          half-width card but gave the two panels stat blocks of different
          heights, so everything below them — the charts, the Generate report
          button, the evidence header — sat at a different level on each. */}
      <div className="nct-stats">
        {stat(`${nCongested} of ${segments.length}`, nCongested > 0 ? "exits with a jam" : "all moving",
              nCongested > 0 ? (nSevere > 0 ? "var(--color-danger)" : "var(--color-warning)") : "var(--color-success)",
              nCongested > 0 ? `${nCongested} of ${segments.length} exits are expected to carry a jam somewhere in this window` : undefined)}
        {stat(kmSpan != null ? `km ${fmtKm(model.kmFrom)}–${fmtKm(model.kmTo)}` : "—",
              // The exits at either end beside the posts, so the span is a place and not only two numbers.
              kmSpan != null
                ? model.kmFromExit === model.kmToExit ? `${model.kmFromExit} only` : `${model.kmFromExit} to ${model.kmToExit}, ${kmSpan} km`
                : "none predicted", undefined,
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
                          worstY && worstY[1] / days >= 12 ? "var(--color-danger)" : undefined,
                          worstY ? `${segments[worstY[0]]} — the most congested hours per day of any exit` : undefined);
            })()
          : stat(model.allHours ? `all ${model.maxHour}h` : model.worstSegment ? `${model.worstSegmentCount} of ${hourLabels.length}h` : "—", model.flatHours ? "same every hour" : "at the worst exit")}
        {(() => {
          const pc = cells.filter((c) => c.state !== "Pending" && c.pCong != null).map((c) => c.pCong as number);
          if (pc.length) {
            const mean = pc.reduce((a, b) => a + b, 0) / pc.length;
            return stat(`${Math.round(mean * 100)}%`, "average jam chance", mean >= 0.5 ? "var(--color-danger)" : undefined,
                        "The mean chance of heavy or severe traffic across every cell on the grid");
          }
          return stat(model.confLo != null && model.confHi != null ? `${Math.round(model.confLo * 100)}–${Math.round(model.confHi * 100)}%` : "—",
              model.confLo != null && model.confLo < LOW_CONF ? "confidence · some cells under 80%" : "confidence across congested cells",
              model.confLo != null && model.confLo < LOW_CONF ? "var(--color-warning)" : undefined);
        })()}
      </div>

      {/* Rows 4 and 5 side by side on a wide card: the grid on the left, what to act on beside it. */}
      <div className="nct-split">
      {/* Row 4: the grid, with its legend and its exit picker attached to it. */}
      <div>
        <div className="nct-grid-bar">
          {/* Which exits are drawn. A select instead of fifteen chips: the
              reader pulls in the two or three they are responsible for. */}
          <div className="nct-exit-picker">
            <span><b>{shownSegments.length}</b> of {segments.length} exits</span>
            {hiddenCount > 0 && (
              <select
                value=""
                onChange={(e) => { if (e.target.value) setExtraExits((cur) => [...cur, e.target.value]); }}
                title={urgentHidden ? "Some hidden exits turn severe sooner than any shown" : undefined}
                aria-label="Add exit"
                className={`nct-select${urgentHidden ? " is-warn" : ""}`}
              >
                <option value="">{urgentHidden ? "⚠ Add exit…" : "Add exit…"}</option>
                {hiddenSorted.map((sg) => {
                  const f = firstSevere(sg);
                  return <option key={sg} value={sg}>{sg}{f != null ? ` — severe at +${f}h` : " — stays clear"}</option>;
                })}
              </select>
            )}
            {hiddenCount > 0 && (
              <button type="button" onClick={() => setExtraExits(hiddenSegments)} className="nct-pill-btn">
                All {segments.length}
              </button>
            )}
            {extraExits.length > 0 && (
              <button type="button" onClick={() => setExtraExits([])} className="nct-link-btn">
                reset
              </button>
            )}
          </div>
        </div>

        {/* The legend belongs to the grid, not to the controls: sitting in the
            control row it wrapped onto a line of its own and read as a third
            bank of settings. Speeds are abbreviated here and spelled out on
            hover, so the whole key fits one line at this card width. */}
        <div className="nct-key nct-grid-key">
          {isWeek ? (
            <>
              {WEEK_BANDS.map((b) => (
                <span key={b.label} className="nct-key-item">
                  <i style={{ background: b.color }} />
                  {b.label}
                </span>
              ))}
              <span className="nct-key-dim">expected congested hours per day</span>
            </>
          ) : (
            <>
              {(["Low", "Med", "High"] as State[]).map((st) => {
                const absent = st === "Med" && !model.everHeavy;
                return (
                  <span key={st}
                        title={absent ? "No exit-hour in this forecast falls in the 10-20 km/h band" : STATE_META[st].speed}
                        className={`nct-key-item${absent ? " is-absent" : ""}`}>
                    <i style={{ background: STATE_META[st].color }} />
                    <b>{STATE_META[st].label}</b>
                    <span className="nct-key-dim">{STATE_META[st].brief}</span>
                  </span>
                );
              })}
              <span className="nct-key-dim">km/h</span>
              {/* Two different asterisks used to share this card: one on cells
                  for low confidence, one on row labels for an estimated
                  km-post. The cell one is gone with the cell text, so this is
                  the only one left and it finally gets named. */}
              {shownSegments.some((sg) => KMI.get(sg)?.est) && (
                <span className="nct-key-dim" style={{ whiteSpace: "nowrap" }}
                      title="No surveyed km-post for this exit; the distance is interpolated from its neighbours.">
                  <b>*</b> est. km
                </span>
              )}
            </>
          )}
        </div>

        <div style={{ width: "100%", height: `${isWeek ? weekChartHeight : chartHeight}px` }}>
          <DashboardChart key={range} option={isWeek ? weekOption : option} height={isWeek ? weekChartHeight : chartHeight} />
        </div>
      </div>

      {/* Row 5: what to act on. Four rows; the rest in the dialog. */}
      <div>
        <div className="nct-subhead-row">
          <h4 className="nct-subhead">
            What to act on <span className="nct-subhead-dim">
              · {alerts.length} episode{alerts.length === 1 ? "" : "s"}
              {(model.severeCount > 0 || model.heavyCount > 0) && <>
                {" · "}
                {[model.severeCount > 0 ? `${model.severeCount} severe` : null,
                  model.heavyCount > 0 ? `${model.heavyCount} heavy` : null].filter(Boolean).join(", ")}
              </>}
            </span>
          </h4>
          {alerts.length > VISIBLE_ALERTS && (
            <button type="button" onClick={() => setAlertsOpen(true)} className="btn-muted">
              View all {alerts.length}
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          )}
        </div>
        <div className="nct-episodes">
          {alerts.length === 0 ? (
            <div className="nct-finding" data-tone="clear">
              <SignalGlyph state="clear" size={22} />
              <p className="nct-finding-text">No heavy or severe congestion predicted in the next {hourLabels.length} hours.</p>
            </div>
          ) : (
            shown.map((a, i) => alertRow(a, `${a.segment}-${a.from}-${i}`))
          )}
        </div>
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
        /* Only the hours ahead this view shows (TR-9, 19 Oct 2026): sending all 48 measured rows to +168h
           had the 12-hour view described with week-ahead figures. The first row is kept if nothing fits. */
        horizons={(() => {
          const reach = model.skippedHours + model.maxHour;
          const inView = hzAcc.filter((a) => a.horizon <= reach);
          return (inView.length ? inView : hzAcc.slice(0, 1)).map((a) => ({
            horizon: a.horizon,
            accuracy: a.accuracy,
            persistenceAccuracy: a.persistenceAccuracy,
          }));
        })()}
        severeBelowKmh={evalInfo?.thresholds_kmh?.severe_below ?? null}
        heavyBelowKmh={evalInfo?.thresholds_kmh?.heavy_below ?? null}
        exitsTotal={segments.length}
        exitsSevere={nSevere}
        hoursCovered={hourLabels.length}
        neverPredictsHeavy={!model.everHeavy}
        windowStart={hourStamp(model.baseTs, model.skippedHours + 1)}
        windowEnd={hourStamp(model.baseTs, model.skippedHours + model.maxHour + 1)}
      />

      {/* Row 7: model evidence, one strip that opens it in a modal. */}
      {hzAcc.length > 1 && hzFirst && hzLast && (
        <EvidenceModal
          subtitle="Congestion forecast: how it was tested, how far ahead it holds, and how it compares with no-change."
          strip={
            <span className="nct-trust-pill" style={{ order: 4 }}>
              {(() => {
                const a0 = hzFirst.accuracy ?? 0; const a1 = hzLast.accuracy ?? 0;
                return a1 < a0 - 0.03 ? "fades" : a1 > a0 + 0.03 ? "improves" : "holds";
              })()}: {pct(hzFirst.accuracy)} at +1h → {pct(hzLast.accuracy)} at +{hzLast.horizon}h
              {" · "}{beatsFrom ? "beats no-change" : "no better than no-change"}
            </span>
          }
        >

          <div className="nct-evidence nct-ev-blocks">
            {/* 1. How it was tested. One sentence, because everything below
                   is meaningless without knowing the numbers come from hours
                   the model never saw. */}
            <EvBlock n={1} title="How it was tested">
              {evalInfo ? (
                <>Trained on the earlier Waze weeks, scored only on the <b>last {evalInfo.test_days} days it never saw</b> —
                {" "}{evalInfo.test_rows.toLocaleString()} exit-hours.</>
              ) : (
                <>Trained on the earlier Waze weeks, scored only on the final days it never saw.</>
              )}
            </EvBlock>

            {/* 2. The proof a stakeholder can see: the same week, replayed. */}
            {evalInfo?.replay && evalInfo.replay.series.length > 1 && (
              <EvBlock n={2} title="Did past predictions match what really happened?">
                <p style={{ margin: "0 0 4px" }}>
                  That unseen week, hour by hour, forecast{" "}
                  <b>{evalInfo.replay.horizon} hours in advance</b> — how many of the {evalInfo.replay.exits} exits were congested
                  <InfoTooltip text="The expected line adds up each exit's individual chance of being congested in that hour, so it is a sum of probabilities rather than a count of exits the model labelled congested." />
                </p>
                <ReplayChart series={evalInfo.replay.series} exits={evalInfo.replay.exits} />
                <div style={{
                  display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8, marginTop: 8,
                  padding: "8px 10px", borderRadius: 8, background: "color-mix(in srgb, var(--text-primary) 4%, transparent)", border: "1px solid var(--border-default)",
                }}>
                  {[[`${evalInfo.replay.mae_exits.toFixed(1)} exits`, "average gap between the lines"],
                    [evalInfo.replay.corr.toFixed(2), "correlation \u00b7 1.00 traces perfectly"],
                    [pct(evalInfo.replay.match_rate), "exit-hours with the exact state right"]].map(([v, l]) => (
                    <div key={l} style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                      <span style={{ fontSize: "var(--fs-title)", fontWeight: 600, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{v}</span>
                      <span style={{ fontSize: "var(--fs-label)", color: "var(--text-secondary)" }}>{l}</span>
                    </div>
                  ))}
                </div>
                {evalInfo.replay.examples.length > 0 && (
                  <div style={{ display: "grid", gap: 3, marginTop: 7, fontSize: "var(--fs-label)", color: "var(--text-secondary)" }}>
                    {evalInfo.replay.examples.map((ex) => (
                      <div key={ex.kind}>
                        <span>{ex.kind.charAt(0).toUpperCase() + ex.kind.slice(1)}</span> —
                        {" "}<b style={{ color: "var(--text-primary)" }}>{new Date(ex.t.replace(" ", "T")).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", hour12: true })}</b>:
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
                <b>{modelInfo?.accuracy != null ? Math.round(modelInfo.accuracy * 100) : "—"}</b> of every 100 exit-hours
                got the right state — against what you would score with no model at all:
              </p>
              <div style={{ display: "grid", gap: 5 }}>
                {[
                  { label: `${modelInfo?.model ?? "Model"} (this card)`, v: modelInfo?.accuracy ?? null, tone: "var(--color-success)", bold: true },
                  { label: `Assume each exit does what it usually does at this hour`, v: modelInfo?.baseline?.accuracy ?? null, tone: "var(--text-muted)" },
                  { label: `Assume nothing changes from now (+1h)`, v: hzFirst?.persistenceAccuracy ?? null, tone: "var(--text-muted)" },
                  { label: `Assume nothing changes from now (+${hzLast?.horizon ?? 12}h)`, v: hzLast?.persistenceAccuracy ?? null, tone: "var(--text-muted)" },
                  { label: `Always say "Moving"`, v: evalInfo ? Math.max(...Object.values(evalInfo.class_share)) : null, tone: "var(--text-muted)" },
                ].filter((r) => r.v != null).map((r) => (
                  <div key={r.label} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 44px", alignItems: "center", gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: "var(--fs-label)", color: r.bold ? "var(--text-primary)" : "var(--text-secondary)", fontWeight: r.bold ? 700 : 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</div>
                      <div style={{ height: 6, borderRadius: 3, background: "color-mix(in srgb, var(--text-primary) 4%, transparent)", overflow: "hidden", marginTop: 3 }}>
                        <div style={{ width: `${Math.round((r.v as number) * 100)}%`, height: "100%", background: r.tone, borderRadius: 3 }} />
                      </div>
                    </div>
                    <span style={{ fontWeight: r.bold ? 800 : 600, color: r.bold ? "var(--text-primary)" : "var(--text-secondary)", fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{pct(r.v as number)}</span>
                  </div>
                ))}
              </div>
              {/* Every model the run tested, on the same exit-hours: the served one is the best severe-jam catcher
                  among those within half a point of the most accurate (train_congestion_horizon.py). */}
              {(evalInfo?.candidates?.length ?? 0) > 1 && (() => {
                const c = evalInfo!.candidates!;
                const bestAcc = Math.max(...c.map((m) => m.accuracy));
                const bestSev = Math.max(...c.map((m) => m.severe_recall));
                return (
                  <>
                    <p style={{ margin: "12px 0 6px" }}>
                      <b>Every model tested</b> on the same exit-hours (best in each column in bold):
                    </p>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "var(--fs-body)", fontVariantNumeric: "tabular-nums" }}>
                        <thead>
                          <tr style={{ color: "var(--text-secondary)", textAlign: "left" }}>
                            <th style={{ padding: "4px 6px 6px 0", fontWeight: 600 }}>Model</th>
                            <th style={{ padding: "4px 6px 6px", fontWeight: 600 }} title="Exit-hours given the right state (Moving, Heavy or Severe)">Accuracy</th>
                            <th style={{ padding: "4px 6px 6px", fontWeight: 600 }} title="Of the real severe hours (under 10 km/h), the share the model called severe">Severe jams caught</th>
                            <th style={{ padding: "4px 0 6px 6px", fontWeight: 600 }} title="Of the real heavy hours, the share the model called heavy">Heavy caught</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.map((m) => (
                            <tr key={m.model} style={{ borderTop: "1px solid var(--border-default)" }}>
                              <td style={{ padding: "6px 6px 6px 0", whiteSpace: "nowrap", color: "var(--text-primary)" }}>
                                {m.model}
                                {m.rank === 1 && <span className="pill purple" style={{ marginLeft: 8, padding: "1px 8px" }}>used</span>}
                                {!m.accepted && <span style={{ marginLeft: 8, color: "var(--color-danger)", fontSize: "var(--fs-label)" }}>below baseline</span>}
                              </td>
                              <td style={{ padding: "6px", fontWeight: m.accuracy === bestAcc ? 700 : 400 }}>{(m.accuracy * 100).toFixed(1)}%</td>
                              <td style={{ padding: "6px", fontWeight: m.severe_recall === bestSev ? 700 : 400 }}>{(m.severe_recall * 100).toFixed(1)}%</td>
                              <td style={{ padding: "6px 0 6px 6px" }}>{(m.heavy_recall * 100).toFixed(1)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                );
              })()}
            </EvBlock>

            {/* 3. Per state: how much to trust each colour. */}
            {evalInfo && (
              <EvBlock n={evalInfo.replay ? 4 : 3} title="How much to trust each colour">
                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "var(--fs-body)", fontVariantNumeric: "tabular-nums" }}>
                    <thead>
                      <tr style={{ color: "var(--text-secondary)", textAlign: "left" }}>
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
                          <tr key={st} style={{ borderTop: "1px solid var(--border-default)" }}>
                            <td style={{ padding: "6px 6px 6px 0", whiteSpace: "nowrap" }}>
                              <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: meta.color, marginRight: 6, verticalAlign: -1 }} />
                              <b style={{ color: "var(--text-primary)" }}>{meta.label}</b>
                            </td>
                            <td style={{ padding: "6px" }}>{share != null ? pct(share) : "—"}</td>
                            <td style={{ padding: "6px", fontWeight: 600, color: pc.precision >= 0.6 ? "var(--color-success)" : pc.precision >= 0.4 ? "var(--color-warning)" : "var(--color-danger)" }}>{pct(pc.precision)}</td>
                            <td style={{ padding: "6px 0 6px 6px", fontWeight: 600, color: pc.recall >= 0.6 ? "var(--color-success)" : pc.recall >= 0.4 ? "var(--color-warning)" : "var(--color-danger)" }}>{pct(pc.recall)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {evalInfo.per_class.High && evalInfo.per_class.High.recall < 0.3 && (
                  <p style={{ margin: "8px 0 0", fontSize: "var(--fs-label)", color: "var(--color-warning)" }}>
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
                  Yes — calibrated on held-back hours, like a rain forecast. Each chip is what the card said,
                  next to what actually happened:
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {evalInfo.calibration.filter((c) => c.n >= 200).map((c) => {
                    const gap = Math.abs(c.predicted - c.observed);
                    return (
                      <span key={c.lo} title={`${c.n.toLocaleString()} unseen exit-hours`} style={{
                        display: "inline-flex", alignItems: "baseline", gap: 4, padding: "3px 8px", borderRadius: 6,
                        background: gap <= 0.05 ? "var(--color-success-bg)" : gap <= 0.1 ? "var(--color-warning-bg)" : "var(--color-danger-bg)",
                        border: `1px solid ${gap <= 0.05 ? "var(--color-success-border)" : gap <= 0.1 ? "var(--color-warning-border)" : "var(--color-danger-border)"}`,
                        fontSize: "var(--fs-label)", fontVariantNumeric: "tabular-nums",
                      }}>
                        <span style={{ color: "var(--text-secondary)" }}>said</span> <b>{Math.round(c.predicted * 100)}%</b>
                        <span style={{ color: "var(--text-muted)" }}>→</span>
                        <span style={{ color: "var(--text-secondary)" }}>happened</span> <b>{Math.round(c.observed * 100)}%</b>
                      </span>
                    );
                  })}
                </div>
                <p style={{ margin: "8px 0 0", fontSize: "var(--fs-label)", color: "var(--text-secondary)" }}>
                  Green: within 5 points · Brier {evalInfo.brier.toFixed(3)}
                  <InfoTooltip text="Brier score is the average squared error of the probabilities themselves, not of the state the card names: 0 is perfect and 0.667 is a coin toss between the three states." />
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
                          style={{ width: 14, borderRadius: 2, background: beats ? "var(--color-success)" : "var(--border-strong)", height: `${Math.max(4, ((a.accuracy ?? 0) - 0.5) * 110)}px` }} />
                  );
                })}
              </div>
              <p style={{ margin: "6px 0 0", fontSize: "var(--fs-label)", color: "var(--text-secondary)" }}>
                  {pct(hzFirst.accuracy)} at +1h → {pct(hzLast.accuracy)} at +{hzLast.horizon}h · green where it beats assuming nothing changes
                  {hzLast.persistenceAccuracy != null && <>, which falls to {pct(hzLast.persistenceAccuracy)} by +{hzLast.horizon}h</>}
              </p>
            </EvBlock>

            {/* 6. The queue, distance and delay figures are a second model on
                   top of the state, so they get their own check. */}
            {jamEval && (
              <EvBlock n={(evalInfo ? (evalInfo.replay ? 6 : 5) : 3) + 1} title="How exact are the queue and delay figures?">
                <p style={{ margin: "0 0 8px" }}>
                  They are what jams at that exit, hour and day type typically looked like over{" "}
                  <b>{jamEval.history_exit_hours != null ? `${jamEval.history_exit_hours.toLocaleString()} past jam-hours` : "four years of Waze history"}</b>{" "}
                  ({new Date(jamEval.history_from).getFullYear()}–{new Date(jamEval.history_to).toLocaleDateString(undefined, { month: "short", year: "numeric" })}).
                  Checked against <b>{jamEval.test_exit_hours.toLocaleString()} live jam-hours</b> since{" "}
                  {new Date(jamEval.test_from).toLocaleDateString(undefined, { month: "short", day: "numeric" })} that the history never saw:
                </p>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "var(--fs-body)", fontVariantNumeric: "tabular-nums" }}>
                    <thead>
                      <tr style={{ color: "var(--text-secondary)", textAlign: "left" }}>
                        <th style={{ padding: "4px 6px 6px 0", fontWeight: 600 }}>Typical error</th>
                        <th style={{ padding: "4px 6px 6px", fontWeight: 600 }}>This card</th>
                        <th style={{ padding: "4px 0 6px 6px", fontWeight: 600 }}>One corridor-wide figure</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr style={{ borderTop: "1px solid var(--border-default)" }}>
                        <td style={{ padding: "6px 6px 6px 0" }}>Queue length <span style={{ color: "var(--text-muted)" }}>· real median {fmtM(jamEval.actual_queue_median_m)}</span></td>
                        <td style={{ padding: "6px", fontWeight: 600, color: "var(--color-success)" }}>{fmtM(jamEval.queue.profile_median_err_m)}</td>
                        <td style={{ padding: "6px 0 6px 6px", color: "var(--text-secondary)" }}>{fmtM(jamEval.queue.corridor_median_err_m)}</td>
                      </tr>
                      <tr style={{ borderTop: "1px solid var(--border-default)" }}>
                        <td style={{ padding: "6px 6px 6px 0" }}>Delay <span style={{ color: "var(--text-muted)" }}>· real median {Math.round(jamEval.actual_delay_median_s)} s</span></td>
                        <td style={{ padding: "6px", fontWeight: 600, color: "var(--text-primary)" }}>{Math.round(jamEval.delay.profile_median_err_s)} s</td>
                        <td style={{ padding: "6px 0 6px 6px", color: "var(--text-secondary)" }}>{Math.round(jamEval.delay.corridor_median_err_s)} s</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p style={{ margin: "8px 0 0", fontSize: "var(--fs-label)", color: "var(--text-secondary)" }}>
                  The queue length is specific to the exit and hour, and that detail more than halves the error. The delay is
                  not: jams on this corridor cost about two minutes almost everywhere, so read it as &ldquo;about 2 min&rdquo; rather
                  than to the second.
                  {jamEval.test_exit_hours < jamEval.test_exit_hours_total && <>
                    {" "}{(jamEval.test_exit_hours_total - jamEval.test_exit_hours).toLocaleString()} live hours fall at exits with too few
                    near-plaza jams in the history and were left out of this check; those cells show the corridor-wide typical, labelled as such.
                  </>}
                </p>
              </EvBlock>
            )}

            {/* 7. Coordination with traffic volume. The model has never seen
                   a vehicle count, so whether its jams fall in the busy hours is
                   an independent check, not something it was fitted to. */}
            {volEval && volEval.bands.length > 0 && (() => {
              const live = cells.filter((c) => c.state !== "Pending" && c.pCong != null && c.volRel != null);
              const grp = (lo: number, hi: number) => {
                const g = live.filter((c) => (c.volRel as number) >= lo && (c.volRel as number) < hi);
                return g.length ? { n: g.length, p: g.reduce((t, c) => t + (c.pCong as number), 0) / g.length } : null;
              };
              const rows = [
                { label: "Quiet hours (under 0.7×)", g: grp(0, 0.7) },
                { label: "Usual hours (0.7–1.3×)", g: grp(0.7, 1.3) },
                { label: "Busy hours (1.3× and over)", g: grp(1.3, 99) },
              ];
              const peak = Math.max(...volEval.bands.map((b) => b.jam_rate));
              return (
                <EvBlock n={(evalInfo ? (evalInfo.replay ? 6 : 5) : 3) + (jamEval ? 2 : 1)} title="Does it line up with traffic volume?">
                  <p style={{ margin: "0 0 8px" }}>
                    The model only sees Waze jam reports, never a vehicle count, so this is an outside check. In the toll data
                    ({new Date(volEval.from).getFullYear()}–{new Date(volEval.to).getFullYear()}), jams get more common as an exit gets busier:
                  </p>
                  <div style={{ display: "grid", gap: 5 }}>
                    {volEval.bands.map((b) => (
                      <div key={b.band} style={{ display: "grid", gridTemplateColumns: "150px minmax(0,1fr) 44px", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: "var(--fs-label)", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{b.label} usual volume</span>
                        <div style={{ height: 6, borderRadius: 3, background: "color-mix(in srgb, var(--text-primary) 4%, transparent)", overflow: "hidden" }}>
                          <div style={{ width: `${(b.jam_rate / peak) * 100}%`, height: "100%", background: "var(--text-secondary)", borderRadius: 3 }} />
                        </div>
                        <span style={{ fontWeight: 600, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{pct(b.jam_rate)}</span>
                      </div>
                    ))}
                  </div>
                  <p style={{ margin: "6px 0 10px", fontSize: "var(--fs-label)", color: "var(--text-secondary)" }}>
                    Share of exit-hours with a jam at the plaza. It peaks at 1.5–2× and eases at the very busiest hours, which
                    usually run heavy but moving.
                  </p>
                  {live.length > 0 && (
                    <>
                      <p style={{ margin: "0 0 6px" }}>This forecast, by the same measure — average chance of a jam it gives:</p>
                      <div style={{ display: "grid", gap: 4, fontSize: "var(--fs-body)" }}>
                        {rows.filter((r) => r.g).map((r) => (
                          <div key={r.label} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                            <span style={{ color: "var(--text-secondary)" }}>{r.label} <span style={{ color: "var(--text-muted)" }}>· {r.g!.n} cells</span></span>
                            <b style={{ color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{pct(r.g!.p)}</b>
                          </div>
                        ))}
                      </div>
                      <p style={{ margin: "6px 0 0", fontSize: "var(--fs-label)", color: "var(--text-secondary)" }}>
                        Rising from quiet to busy hours is what the traffic says should happen. A forecast that put its jams in
                        the quiet hours would be one to doubt. Hover a cell for its typical volume.
                      </p>
                    </>
                  )}
                </EvBlock>
              );
            })()}

            {/* 8. The map as served, scored. The figures above come from tests
                   inside training; this is the forecasts people actually saw. */}
            <EvBlock
              n={(evalInfo ? (evalInfo.replay ? 6 : 5) : 3) + (jamEval ? 1 : 0) + (volEval ? 1 : 0) + 1}
              title="Checked against what happened"
            >
              {liveScore && liveScore.buckets.length > 0 ? (
                <>
                  <p style={{ margin: "0 0 8px" }}>
                    Every forecast this card serves is now kept and scored once its hours have passed. So far{" "}
                    <b>{liveScore.buckets.reduce((t, b) => t + b.n, 0).toLocaleString()} exit-hours</b> from{" "}
                    {Math.max(...liveScore.buckets.map((b) => b.runs))} hourly runs:
                  </p>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "var(--fs-body)", fontVariantNumeric: "tabular-nums" }}>
                      <thead>
                        <tr style={{ color: "var(--text-secondary)", textAlign: "left" }}>
                          <th style={{ padding: "4px 6px 6px 0", fontWeight: 600 }}>Hours ahead</th>
                          <th style={{ padding: "4px 6px 6px", fontWeight: 600 }}>Jam / no jam right</th>
                          <th style={{ padding: "4px 6px 6px", fontWeight: 600 }}>Old colouring</th>
                          <th style={{ padding: "4px 0 6px 6px", fontWeight: 600 }}>Exact state right</th>
                        </tr>
                      </thead>
                      <tbody>
                        {liveScore.buckets.map((b) => (
                          <tr key={b.bucket} style={{ borderTop: "1px solid var(--border-default)" }}>
                            <td style={{ padding: "6px 6px 6px 0" }}>{b.bucket} <span style={{ color: "var(--text-muted)" }}>· {b.n.toLocaleString()}</span></td>
                            <td style={{ padding: "6px", fontWeight: 600, color: "var(--text-primary)" }}>{pct(b.shown_jam_acc)}</td>
                            <td style={{ padding: "6px", color: "var(--text-secondary)" }}>{pct(b.argmax_jam_acc)}</td>
                            <td style={{ padding: "6px 0 6px 6px", color: "var(--text-secondary)" }}>{pct(b.argmax_state_acc)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p style={{ margin: "8px 0 0", fontSize: "var(--fs-label)", color: "var(--text-secondary)" }}>
                    &ldquo;Old colouring&rdquo; is the likeliest-of-three rule this card used before; the current one colours a cell
                    congested when the chance of a jam is 50% or more. Early figures rest on few hours and will steady as runs accumulate.
                  </p>
                </>
              ) : (
                <p style={{ margin: 0 }}>
                  Every forecast this card serves is now kept (next 24 hours of each hourly run) and will be scored against the jams
                  Waze reports once those hours pass. The first scores appear here within a few hours.
                </p>
              )}
            </EvBlock>

            <p style={{ margin: 0, fontSize: "var(--fs-label)", color: "var(--text-muted)" }}>
              States from Waze jam speeds · Severe under {evalInfo?.thresholds_kmh.severe_below ?? 10}, Heavy{" "}
              {evalInfo?.thresholds_kmh.severe_below ?? 10}–{evalInfo?.thresholds_kmh.heavy_below ?? 20}, Moving above that or no jam
              <InfoTooltip text="The cuts are this corridor's own speed distribution, not a national standard, so they describe what counts as a jam on NLEX rather than anywhere else." />
              {!model.everHeavy && <> · no Heavy hour in the current forecast</>}
            </p>
          </div>
        </EvidenceModal>
      )}

      {/* Full list in a dialog — the inline expander pushed the rest of the
          page down and trapped 29 cards in a small scroll box. */}
      {/* Rendered into <body> so no animated ancestor can trap it under the
          sticky filter bar; it keeps the page's accent through .viz-traffic. */}
      {alertsOpen && typeof document !== "undefined" && createPortal(
        <div role="dialog" aria-modal="true" aria-label="All predicted congestion episodes" onClick={() => setAlertsOpen(false)}
             className="nct-modal-backdrop viz-traffic">
          <div onClick={(e) => e.stopPropagation()} className="nct-modal">
            <div className="nct-modal-head">
              <div>
                <h3>Predicted congestion · next {hourLabels.length} hours</h3>
                <p>
                  {alerts.length} episodes across {bySegment.length} segments · <b className="nct-bad">{model.severeCount} severe</b>, <b className="nct-warn">{alerts.length - model.severeCount} heavy</b> · grouped by location
                </p>
              </div>
              <button type="button" onClick={() => setAlertsOpen(false)} aria-label="Close" className="nct-modal-close">
                ✕
              </button>
            </div>
            <div className="nct-modal-body">
              {bySegment.map(({ seg, runs }) => (
                <div key={seg}>
                  <div className="nct-modal-group">
                    <span className="nct-modal-group-name">{seg}</span>
                    <span className="nct-dim">km {kmLabel(KMI.get(seg))}</span>
                    <span className="nct-modal-group-rule" />
                    <span className="nct-dim">{runs.length} {runs.length === 1 ? "episode" : "episodes"}</span>
                  </div>
                  <div className="nct-episodes">
                    {runs.map((a, i) => alertRow(a, `modal-${seg}-${a.from}-${i}`))}
                  </div>
                </div>
              ))}
            </div>
            <div className="nct-modal-foot">
              Confidence is the model&apos;s certainty in its classification, not the probability of congestion. Press Esc to close.
            </div>
          </div>
        </div>,
        document.body,
      )}
    </article>
  );
}
