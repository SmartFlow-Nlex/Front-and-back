"use client";

import { useEffect, useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import InfoTooltip from "./InfoTooltip";
import { loadForecast } from "./prescriptiveTraffic.shared";

type State = "Low" | "Med" | "High";

type RawRow = { segment: string; hours: number; state: State; probability: number | string;
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
const STATE_META: Record<State, { rank: number; color: string; text: string; label: string; short: string; speed: string }> = {
  Low: { rank: 0, color: "#cfe4f7", text: "#12507e", label: "Clear", short: "CLEAR", speed: "no jam reported" },
  Med: { rank: 1, color: "#f0a63a", text: "#5c3208", label: "Heavy", short: "HEAVY", speed: "jams at 30–60 km/h" },
  High: { rank: 2, color: "#dc2626", text: "#ffffff", label: "Severe", short: "SEVERE", speed: "jams under 30 km/h" },
};

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
const kmLabel = (e?: { km: number | null; est: boolean }) =>
  e?.km == null ? "—" : `${e.km}${e.est ? "*" : ""}`;

type CellItem = {
  value: [number, number, number];
  state: State;
  conf: number;
  /** First cell of a contiguous run of this state — the only one that is labelled. */
  runStart?: boolean;
  label: { color: string };
};

type Alert = { segment: string; state: State; from: number; to: number; conf: number };

/** Accuracy at each forecast horizon, with the "nothing changes" benchmark. */
type HzAcc = { horizon: number; accuracy: number | null; persistenceAccuracy: number | null };

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

  const model = useMemo(() => {
    if (!raw || raw.length === 0) return null;

    const byKm = Array.from(new Set(raw.map((d) => d.segment))).sort(
      (a, b) => (KMI.get(a)?.km ?? 9999) - (KMI.get(b)?.km ?? 9999)
    );
    const maxHour = Math.max(...raw.map((d) => d.hours));
    const baseTs = raw.find((r) => r.baseTs)?.baseTs ?? null;
    // Two lines per column: the horizon and the hour it lands on.
    const hourLabels = Array.from({ length: maxHour }, (_, i) => {
      const clock = hourClock(baseTs, i + 1);
      return clock ? `+${i + 1}h\n${clock}` : `+${i + 1}h`;
    });

    // ECharts draws a category y-axis bottom-up, so reverse to read north-bound
    // down the page (Balintawak on top).
    const segments = [...byKm].reverse();

    const states: (State | null)[][] = segments.map(() => Array(maxHour).fill(null));
    const confs: number[][] = segments.map(() => Array(maxHour).fill(0));
    const cells: CellItem[] = [];

    raw.forEach((d) => {
      const y = segments.indexOf(d.segment);
      const x = d.hours - 1;
      if (y < 0 || x < 0 || x >= maxHour) return;
      const conf = Number(d.probability);
      states[y][x] = d.state;
      confs[y][x] = conf;
      const meta = STATE_META[d.state] ?? STATE_META.Low;
      cells.push({ value: [x, y, meta.rank], state: d.state, conf, label: { color: meta.text } });
    });

    // Flag the first cell of each run so the label formatter can print the state
    // once per run instead of once per cell.
    cells.forEach((c) => {
      const [x, y] = c.value;
      c.runStart = x === 0 || states[y][x - 1] !== c.state;
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
    const severeIdx = segments
      .map((seg, i) => (severeSegments.has(seg) ? i : -1))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    const contiguous =
      severeIdx.length > 1 && severeIdx[severeIdx.length - 1] - severeIdx[0] === severeIdx.length - 1;
    const severeKms = [...severeSegments]
      .map((seg) => KMI.get(seg)?.km)
      .filter((k): k is number => k != null)
      .sort((a, b) => a - b);
    const kmFrom = severeKms.length ? severeKms[0] : null;
    const kmTo = severeKms.length ? severeKms[severeKms.length - 1] : null;

    // Every hour identical means the 12 columns carry no information, and a
    // "peak window" label would invent a worst hour that does not exist.
    const flatHours = perHour.length > 1 && perHour.every((n) => n === perHour[0]);

    // How long the worst segments stay bad, and how sure the model is.
    const severeAlerts = alerts.filter((a) => a.state === "High");
    const allHours =
      severeAlerts.length > 0 &&
      severeAlerts.every((a) => a.from === 1 && a.to === maxHour);
    const severeConfs = severeAlerts.map((a) => a.conf).sort((x, y) => x - y);

    const peakIdx = perHour.indexOf(Math.max(...perHour));
    const worstIdx = perSegment.indexOf(Math.max(...perSegment));
    const firstSevere = alerts.find((a) => a.state === "High");

    return {
      segments,
      hourLabels,
      cells,
      perHour,
      alerts,
      severeCount: alerts.filter((a) => a.state === "High").length,
      atRisk: atRisk.size,
      severeSegments: [...severeSegments],
      severeCells,
      peakHour: perHour[peakIdx] > 0 ? peakIdx + 1 : null,
      peakHourCount: perHour[peakIdx],
      worstSegment: perSegment[worstIdx] > 0 ? segments[worstIdx] : null,
      worstSegmentCount: perSegment[worstIdx],
      firstSevere,
      contiguous,
      baseTs,
      severePerHour,
      kmFrom,
      kmTo,
      flatHours,
      allHours,
      maxHour,
      confLo: severeConfs.length ? severeConfs[0] : null,
      confHi: severeConfs.length ? severeConfs[severeConfs.length - 1] : null,
      // Whether the model EVER predicts Heavy. It does not, and a legend entry
      // for a state that never appears reads as a gap in the data rather than a
      // property of the model.
      everHeavy: cells.some((c) => c.state === "Med"),
      lowConfCount: cells.filter((c) => c.state !== "Low" && c.conf < LOW_CONF).length,
    };
  }, [raw, KMI]);

  if (!model) {
    return (
      <article className="chart-card wide" style={{ padding: "24px", marginTop: "24px", display: "flex", flexDirection: "column", gap: 12 }}>
        {loadError ? (
          <>
            <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>
              Predictive Congestion State Map
              <InfoTooltip text="Predicted jam state at each exit for the next 12 hours, from Waze jam reports. Red = jams under 30 km/h expected; blue = no jam reported." />
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

  const { segments, hourLabels, cells, perHour, alerts } = model;
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
  const elapsedHours = baseMs == null ? 0
    : hourLabels.filter((_, i) => baseMs + (i + 1) * 3.6e6 < Date.now()).length;
  const stale = ageHours != null && elapsedHours > 0;
  // A state earns a text label only while it is the exception. Free flow is
  // included: when the corridor is mostly severe, the clear cells are the news.
  const stateShare = (["Low", "Med", "High"] as State[]).map((st) => ({
    st, share: cells.filter((c) => c.state === st).length / Math.max(cells.length, 1),
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
          const n = p.data as number;
          return `<b>${hourLabels[p.dataIndex]}</b><br/>${n} of ${segments.length} segments congested`;
        }
        const d = p.data as CellItem;
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
              <span style="color:#64748b;">Model confidence</span><span style="font-weight:600; color:${low ? "#b45309" : "#334155"};">${(d.conf * 100).toFixed(1)}%${low ? " · lower" : ""}</span>
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
        data: hourLabels,
        position: "top",
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: {
          interval: 0,          // never drop an hour; a cell with no header is unreadable
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
        data: hourLabels,
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
            if (!d.runStart || !minorityStates.has(d.state)) return "";
            return d.conf < LOW_CONF ? `${STATE_META[d.state].short}*` : STATE_META[d.state].short;
          },
          fontSize: 9,
          fontWeight: 700,
        },
        itemStyle: { borderColor: "#fff", borderWidth: 3, borderRadius: 4 },
        // Wash over the elapsed columns so a stale forecast looks stale.
        markArea: elapsedHours > 0 ? {
          silent: true,
          itemStyle: { color: "rgba(248,250,252,0.62)" },
          data: [[
            { xAxis: hourLabels[0] },
            { xAxis: hourLabels[Math.min(elapsedHours, hourLabels.length) - 1] },
          ]] as never[],
        } : undefined,
        emphasis: { itemStyle: { borderColor: "#0f172a", borderWidth: 2, shadowBlur: 10, shadowColor: "rgba(15,23,42,0.3)" } },
      },
      {
        name: "Segments congested",
        type: "bar",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: perHour.map((n) => ({
          value: n,
          itemStyle: { color: n === maxPerHour && n > 0 ? "#475569" : "#e2e8f0", borderRadius: [3, 3, 0, 0] },
          label: { color: n === maxPerHour && n > 0 ? "#334155" : "#94a3b8" },
        })),
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
          {a.from === a.to ? `+${a.from}h` : `+${a.from}h → +${a.to}h`} <span style={{ color: "#94a3b8" }}>· {span}h</span>
        </span>
        <span style={{ color: a.conf < LOW_CONF ? "#b45309" : "#94a3b8", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{(a.conf * 100).toFixed(0)}%</span>
      </div>
    );
  };

  // A one-sentence read of the whole card, for stakeholders who will not
  // decode a 108-cell grid. The shape of the problem - one unbroken stretch of
  // road, bad for the whole window - is the thing to say.
  const nSevere = model.severeSegments.length;
  const kmSpan =
    model.kmFrom != null && model.kmTo != null ? Math.round(model.kmTo - model.kmFrom) : null;

  const spH = model.severePerHour as number[];
  const firstCount = spH[0] ?? 0;
  const peakCount = Math.max(...spH);
  const peakAt = spH.indexOf(peakCount) + 1;
  const clear = segments.filter((sg) => !model.severeSegments.includes(sg));

  const whoText =
    nSevere === segments.length
      ? `every exit on the corridor`
      : nSevere > segments.length * 0.6
      ? `all but ${clear.length} exit${clear.length === 1 ? "" : "s"} (${clear.join(", ")} stay${clear.length === 1 ? "s" : ""} clear)`
      : model.contiguous && kmSpan != null
      ? `${nSevere} neighbouring exits over about ${kmSpan} km, km ${model.kmFrom} to ${model.kmTo}`
      : `${nSevere} of ${segments.length} exits (${model.severeSegments.join(", ")})`;

  const headline = !model.firstSevere
    ? `No severe congestion forecast in the next ${hourLabels.length} hours.`
    : firstCount < peakCount
    ? `Congestion builds: ${firstCount} of ${segments.length} exit${firstCount === 1 ? "" : "s"} severe at +1h, rising to ${peakCount} by +${peakAt}h. By the peak it is ${whoText}.`
    : `${whoText.charAt(0).toUpperCase()}${whoText.slice(1)} — forecast severe from +1h${model.allHours ? ` and holding for the whole ${model.maxHour}-hour window` : ""}.`;

  const stat = (value: string, label: string, tone?: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
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
            <InfoTooltip text="Predicted jam state at each exit for the next 12 hours, from Waze jam reports. Red = jams under 30 km/h expected; blue = no jam reported." />
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
            {stale && (
              <span
                title={`This forecast was generated from data ending ${model.baseTs}. ${elapsedHours} of ${hourLabels.length} forecast hours have already passed. Re-run train_congestion_horizon.py to refresh it.`}
                style={{
                  fontSize: "0.7rem", padding: "2px 8px", borderRadius: 999, fontWeight: 700, cursor: "help", whiteSpace: "nowrap",
                  background: elapsedHours === hourLabels.length ? "#fef2f2" : "#fffbeb",
                  border: `1px solid ${elapsedHours === hourLabels.length ? "#fecaca" : "#fde68a"}`,
                  color: elapsedHours === hourLabels.length ? "#b91c1c" : "#92400e",
                }}
              >
                {elapsedHours === hourLabels.length ? `⚠ expired · ${Math.round(ageHours!)}h old` : `⚠ ${elapsedHours} of ${hourLabels.length} hours elapsed`}
              </span>
            )}
          </div>
        </div>
        <p style={{ color: "#64748b", fontSize: "0.82rem", margin: "4px 0 0 0" }}>
          {stale ? "Covered" : "Next"} {hourLabels.length} hours from <b style={{ color: "#334155" }}>{baseLabel(model.baseTs) ?? "the last reading"}</b>
          <span style={{ cursor: "help" }} title="Rows are exits ordered north-bound by km-post. Hover any cell for the model's confidence. The base time is the last complete hour of Waze ingestion."> · hover for detail</span>
        </p>
      </div>

      {/* Row 2: the finding. */}
      <div style={{
        padding: "12px 14px", borderRadius: "10px", fontSize: "0.88rem", lineHeight: 1.5,
        background: model.firstSevere ? "#fef2f2" : "#f0fdf4",
        border: `1px solid ${model.firstSevere ? "#fecaca" : "#bbf7d0"}`,
        color: model.firstSevere ? "#991b1b" : "#166534",
      }}>
        {headline}
      </div>

      {/* Row 3: how many, where, how long, how sure — once each, one line. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "10px 16px", padding: "10px 14px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10 }}>
        {stat(`${nSevere} of ${segments.length}`, nSevere > 0 ? "exits with a jam expected" : "exits affected · clear", nSevere > 0 ? "#b91c1c" : "#15803d")}
        {stat(kmSpan != null ? `km ${model.kmFrom}–${model.kmTo}` : "—", kmSpan != null ? `${kmSpan} km${model.contiguous ? ", one stretch" : ", not contiguous"}` : "no congestion predicted")}
        {stat(model.allHours ? `all ${model.maxHour}h` : model.worstSegment ? `${model.worstSegmentCount} of ${hourLabels.length}h` : "—", model.flatHours ? "same every hour" : "at the worst exit")}
        {stat(model.confLo != null && model.confHi != null ? `${Math.round(model.confLo * 100)}–${Math.round(model.confHi * 100)}%` : "—",
              model.confLo != null && model.confLo < LOW_CONF ? "confidence · below 80%, indicative" : "confidence on severe cells",
              model.confLo != null && model.confLo < LOW_CONF ? "#b45309" : undefined)}
      </div>

      {/* Row 4: the grid, with its legend and its exit picker attached to it. */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 2 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: "0.74rem", color: "#64748b", flexWrap: "wrap" }}>
            {(["Low", "Med", "High"] as State[]).map((st) => {
              const absent = st === "Med" && !model.everHeavy;
              return (
                <span key={st} title={absent ? "Heavy would need jams averaging 30–60 km/h; reported jams almost never run that fast, so the model has nothing to learn it from" : undefined}
                      style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", opacity: absent ? 0.45 : 1 }}>
                  <span style={{ width: 11, height: 11, background: STATE_META[st].color, borderRadius: 3 }} />
                  {STATE_META[st].label} <span style={{ color: "#94a3b8" }}>{STATE_META[st].speed}</span>
                  {absent && <span style={{ color: "#94a3b8", fontStyle: "italic" }}>· never predicted</span>}
                </span>
              );
            })}
            {model.lowConfCount > 0 && <span style={{ color: "#94a3b8", whiteSpace: "nowrap" }}><b>*</b> confidence under 80%</span>}
            <span style={{ color: "#94a3b8" }} title="States come from Waze jam reports at each exit, hour by hour. Severe means jams were reported and averaged under 30 km/h; Clear means the model expects no report.">
              · from Waze jam reports ⓘ
            </span>
          </div>

          {/* Which exits are drawn. A select instead of fifteen chips: the
              reader pulls in the two or three they are responsible for. */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.72rem", color: "#64748b", flexWrap: "wrap" }}>
            <span>{shownSegments.length} of {segments.length} exits</span>
            {hiddenCount > 0 && (
              <select
                value=""
                onChange={(e) => { if (e.target.value) setExtraExits((cur) => [...cur, e.target.value]); }}
                title={urgentHidden ? "Some hidden exits turn severe sooner than any shown" : undefined}
                style={{ font: "inherit", fontWeight: 600, color: urgentHidden ? "#b45309" : "#475569", background: "#fff", border: `1px solid ${urgentHidden ? "#fcd9a4" : "#dce2ef"}`, borderRadius: 8, padding: "3px 8px", cursor: "pointer" }}
              >
                <option value="">{urgentHidden ? "Add exit… (some hidden turn severe sooner)" : "Add exit…"}</option>
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

        <div style={{ width: "100%", height: `${chartHeight}px` }}>
          <DashboardChart option={option} height={chartHeight} />
        </div>
      </div>

      {/* Row 5: what to act on. Four rows; the rest in the dialog. */}
      <div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
          <h4 style={{ margin: 0, fontSize: "0.88rem", color: "#0f172a", fontWeight: 700 }}>
            What to act on <span style={{ color: "#94a3b8", fontWeight: 500 }}>· {model.severeCount} severe episode{model.severeCount === 1 ? "" : "s"} across {nSevere} of {segments.length} exits</span>
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

      {/* Row 6: model evidence, behind one disclosure. */}
      {hzAcc.length > 1 && hzFirst && hzLast && (
        <details style={{ fontSize: "0.76rem", color: "#64748b", borderTop: "1px solid #eef2f7", paddingTop: 10 }}>
          <summary style={{ cursor: "pointer", color: "#475569", fontWeight: 600, listStyle: "none", display: "flex", gap: 14, flexWrap: "wrap" }}>
            <span>Details</span>
            <span style={{ color: "#94a3b8" }}>
              {(() => {
                const a0 = hzFirst.accuracy ?? 0; const a1 = hzLast.accuracy ?? 0;
                return a1 < a0 - 0.03 ? "accuracy fades with distance" : a1 > a0 + 0.03 ? "accuracy improves with distance" : "accuracy holds across the horizon";
              })()} · {pct(hzFirst.accuracy)} at +1h → {pct(hzLast.accuracy)} at +{hzLast.horizon}h
            </span>
            <span style={{ color: "#94a3b8" }}>{beatsFrom ? "beats no-change" : "no better than no-change"}</span>
          </summary>

          <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 34 }}>
              {hzAcc.map((a) => {
                const beats = a.accuracy != null && a.persistenceAccuracy != null && a.accuracy > a.persistenceAccuracy;
                return (
                  <span key={a.horizon} title={`+${a.horizon}h — model ${pct(a.accuracy)}, "nothing changes" ${pct(a.persistenceAccuracy)}`}
                        style={{ width: 14, borderRadius: 2, background: beats ? "#16a34a" : "#cbd5e1", height: `${Math.max(4, ((a.accuracy ?? 0) - 0.5) * 110)}px` }} />
                );
              })}
              <span style={{ marginLeft: 8, alignSelf: "center" }}>
                Accuracy by hour ahead, +1h to +{hzLast.horizon}h · green where it beats assuming nothing changes
                {beatsFrom && beatsFrom.horizon > 1 && <> (from +{beatsFrom.horizon}h)</>}
                {hzLast.persistenceAccuracy != null && <> · that benchmark falls to {pct(hzLast.persistenceAccuracy)} by +{hzLast.horizon}h</>}
              </span>
            </div>
            <p style={{ margin: 0, lineHeight: 1.55, color: "#94a3b8" }}>
              {modelInfo?.model ?? "The model"} classifies each exit-hour as clear or severe from whether Waze jams were reported there and how slow they ran
              {modelInfo?.baseline?.accuracy != null && <>, at {(modelInfo.accuracy! * 100).toFixed(1)}% against {(modelInfo.baseline.accuracy * 100).toFixed(1)}% for the {modelInfo.baseline.model.toLowerCase()} baseline</>}.
              {!model.everHeavy && <> It never predicts Heavy: that would need jams averaging 30–60 km/h, and reported jams almost never do.</>}
              {" "}Because most daytime hours on the corridor carry at least one jam report, the grid runs mostly red; the informative cells are the clear ones and the hour a run begins.
              {" "}Confidence is the model&apos;s certainty in its classification, not the probability of congestion.
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
