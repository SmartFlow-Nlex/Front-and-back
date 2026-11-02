"use client";

/**
 * Corridor CO2 walk-forward forecast.
 *
 * Every number comes from GET /api/emissions/forecast, which serves
 * gold.ml_predictive_emissions. That table's actuals roll up from
 * gold.fact_emissions_hourly — the same traffic series the volume forecast is
 * trained on — so this panel and the volume panel cannot disagree (verified to
 * 0.0005 t/day).
 *
 * This component previously held hardcoded `actualData`/`predictedData` arrays
 * over 57 unlabelled day-indices. Nothing in it was measured.
 *
 * The layout deliberately mirrors PredictiveVolumeChart: same header, same model
 * toolbar, same two-row control strip, same metrics table, same narrative
 * component. Two deviations, both because the underlying run differs:
 *
 *   - No Weather toggle. The volume module trained weather-free twins, so its
 *     toggle changes the forecast itself. No such twins exist for CO2, so a
 *     toggle here would be a control that does nothing.
 *   - Fewer Future widths. The run stores 90 days, but a width is offered only
 *     where the horizon study says the model beat the baseline; with the current
 *     run that is the 7-day validated horizon alone (see `horizons`).
 *
 * HORIZON is 7 days, versus 14 for volume, per the modelling diagram. The two
 * sets of error metrics are therefore NOT directly comparable.
 */

import type { EChartsOption } from "echarts";
import { useEffect, useMemo, useState } from "react";
import { Diameter, Star, TriangleAlert } from "lucide-react";
import DashboardChart from "./DashboardChart";
import InfoTooltip from "./InfoTooltip";
import ChartSkeleton from "./ChartSkeleton";
import StateNote from "../stage/StateNote";
import ModelNarrative, { type MetricRow, type NarrativeVocab } from "./ModelNarrative";
import { aggregateSeries, type Granularity } from "./aggregateSeries";
import { useThemeTokens, zoneTints } from "./useThemeTokens";
import { useChartTheme } from "../../lib/chart-theme";
import { fmtAxis, gapMarkArea, nowMarkLine, withAlpha } from "../../lib/chart-kit";
import EvidenceModal from "./EvidenceModal";
import { Term } from "./emissionsTerms";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

const VALIDATED_HORIZON = 7; // must match train_emissions.py HORIZON

type Zone = "past" | "present" | "future";
type ModelKey = "derived" | "gbr" | "polynomial" | "lstm";

type Point = {
  date: string;
  actual: number | null;
  predicted: number | null;
  derived?: number | null;
  gbr: number | null;
  polynomial: number | null;
  lstm: number | null;
  zone: Zone;
};

type Metric = {
  model: string;
  model_name: string;
  rank: number | null;
  accepted: boolean;
  rmse: number | null;
  mae: number | null;
  wmape: number | null;
  r2: number | null;
  mase: number | null;
  mape: number | null;
  rejectedReason: string | null;
  rejected_reason: string | null;
  uses_weather: boolean | null;
  diagnosis: string | null;
};

type HzBucket = {
  hLo: number; hHi: number; wmape: number | null; mase: number | null;
  usable: boolean; note: string | null;
  /** The baseline's error over the same days, for saying how far the model lost by. */
  baselineWmape?: number | null;
};

type Payload = {
  championModel: string | null;
  horizonAccuracy: HzBucket[];
  /** Models the trainer could not separate from the leader. */
  coChampions: string[];
  weatherAtForecastTime: string;
  horizonDays: number;
  series: Point[];
  metrics: Metric[];
  split: {
    trainDays: number;
    holdoutDays: number;
    futureDays: number;
    trainStart: string | null;
    trainEnd: string | null;
    holdoutStart: string | null;
    holdoutEnd: string | null;
    futureStart: string | null;
    futureEnd: string | null;
    trainPct: number | null;
    holdoutPct: number | null;
  };
};

const ORDER: ModelKey[] = ["derived", "polynomial", "gbr", "lstm"];
const LABEL: Record<ModelKey, string> = {
  derived: "Volume-derived",
  polynomial: "Polynomial",
  gbr: "Gradient Boosting",
  lstm: "LSTM",
};
/** UI key -> model_name in gold.ml_model_metrics */
const DB_NAME: Record<ModelKey, string> = { derived: "Derived", polynomial: "Polynomial", gbr: "GBR", lstm: "LSTM" };
const FROM_DB: Record<string, ModelKey> = { Derived: "derived", Polynomial: "polynomial", GBR: "gbr", LSTM: "lstm" };
/* Lane Signal: the first four steps of the validated model order (blue /
   magenta / teal / violet), stepped per theme. Green and amber now mean road
   state, so the emission models no longer use them. */
const COLOR_LIGHT: Record<ModelKey, string> = { derived: "#2a78d6", polynomial: "#c2185b", gbr: "#0b8db0", lstm: "#7a5fe0" };
const COLOR_DARK: Record<ModelKey, string> = { derived: "#3987e5", polynomial: "#d55181", gbr: "#169bb8", lstm: "#8c7ff0" };
const HOW_IT_WORKS: Record<ModelKey, string> = {
  derived:
    "The volume panel's forecast (Prophet) × the corridor's CO₂ per vehicle on that weekday over the previous 8 weeks. CO₂ here is vehicles × km × a fixed factor per class, so forecasting it through the volume forecast keeps the two panels in agreement.",
  polynomial:
    "Ridge regression on degree-2 terms over trend, the 7- and 28-day rolling means, lag-1, lag-7, day-of-week and rainfall.",
  gbr: "Gradient-boosted trees over the same lag, calendar and weather features. Captures interactions a linear fit cannot.",
  lstm: "Neural network over a 28-day window. Predicts one day at a time and feeds its own output back, so early errors compound.",
};

const NARRATIVE_VOCAB: NarrativeVocab = {
  dbName: DB_NAME,
  label: LABEL,
  // The narrative names models in text only; the light step is its legend swatch.
  color: COLOR_LIGHT,
  howItWorks: HOW_IT_WORKS,
  maeUnit: "t",
  // Tonnes, not vehicle counts — rounding these to integers would throw away
  // most of the precision the metric has.
  fmtMagnitude: (n) => (n == null || !isFinite(n) ? null : n.toFixed(2)),
};

const ALL_PAST = 100000;
const CHART_H = 450;

const fmt = (v: number | null, d = 1) =>
  v == null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const shortDate = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export default function PredictiveEmissionChart() {
  const T = useThemeTokens();
  // The chart kit's helpers (hatch, NOW marker) take the chart theme.
  const CT = useChartTheme();
  const COLOR = T.isDark ? COLOR_DARK : COLOR_LIGHT;
  const ZONE = zoneTints(T.isDark);

  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [granularity, setGranularity] = useState<Granularity>("Weekly");
  const [pastDays, setPastDays] = useState<number>(ALL_PAST);
  const WINDOWS: { label: string; days: number }[] = [
    { label: "60d", days: 60 },
    { label: "1y", days: 365 },
    { label: "All", days: ALL_PAST },
  ];
  const [showAllMetrics, setShowAllMetrics] = useState(false);
  // How much of the stored 90-day projection to draw. Defaults to the validated
  // 7 days so the panel opens on the range the diagram specifies.
  const [futureDays, setFutureDays] = useState<number>(7);
  // Starts on the champion the API reports, so a retrain that changes the winner
  // changes this panel with no code edit.
  const [selected, setSelected] = useState<ModelKey[]>([]);

  // Bumping this refetches. The panel used to fetch exactly once, so a single
  // slow handshake on the shared RDS instance left it dead until a full page
  // reload — see the pool comment in Back-End/src/config/db.ts, which records the
  // same false "database not reachable" alarm.
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    (async () => {
      const MAX_TRIES = 3;
      for (let tryNo = 1; tryNo <= MAX_TRIES; tryNo++) {
        try {
          setRetrying(tryNo > 1);
          const res = await fetch(`${BACKEND}/api/emissions/forecast`);
          const json = await res.json().catch(() => ({}));
          if (cancelled) return;

          if (res.ok && json.success) {
            const payload = json.data as Payload;
            setData(payload);
            setSelected([FROM_DB[payload.championModel ?? ""] ?? "polynomial"]);
            setError(null);
            setRetrying(false);
            return;
          }

          // Only connectivity failures are worth repeating. A malformed query or
          // an untrained model will fail identically every time, and retrying it
          // just delays an error the user needs to see.
          const retryable = json.retryable === true || res.status === 503;
          if (!retryable || tryNo === MAX_TRIES) {
            setError(json.message ?? `HTTP ${res.status}`);
            setRetrying(false);
            return;
          }
        } catch (e) {
          if (cancelled) return;
          if (tryNo === MAX_TRIES) {
            setError(e instanceof Error ? e.message : "Forecast unavailable");
            setRetrying(false);
            return;
          }
        }
        // Backoff: 1s, then 3s. Long enough for a slow handshake to clear.
        await new Promise<void>((r) => timers.push(setTimeout(r, tryNo * 2000 - 1000)));
        if (cancelled) return;
      }
    })();

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [attempt]);

  const championKey = data?.championModel ? FROM_DB[data.championModel] : null;
  const tied = data?.coChampions ?? [];
  const metricFor = (k: ModelKey) => data?.metrics.find((m) => m.model === DB_NAME[k]) ?? null;

  const toggleModel = (k: ModelKey) =>
    setSelected((cur) =>
      cur.includes(k) ? (cur.length === 1 ? cur : cur.filter((x) => x !== k)) : [...cur, k]
    );

  const view = useMemo(() => {
    if (!data?.series.length) return null;
    const all = data.series;

    // Trim only the PAST stretch. The holdout and the future block are always
    // shown whole: cropping either would hide exactly the part being evaluated.
    const firstScored = all.findIndex((p) => p.zone !== "past");
    const keepFrom = pastDays >= ALL_PAST || firstScored < 0 ? 0 : Math.max(0, firstScored - pastDays);
    // Also trim the FUTURE tail: the table holds 90 days but only the selected
    // window is drawn, so the reader is never shown more projection than they
    // asked for.
    const firstFuture = all.findIndex((p) => p.zone === "future");
    const cutTo = firstFuture < 0 ? all.length : firstFuture + futureDays;
    const win = all.slice(keepFrom, cutTo);

    const isoDates = win.map((p) => p.date);
    const hi = win.findIndex((p) => p.zone === "present");
    const holdoutStart = hi < 0 ? win.length : hi;
    const fi = win.findIndex((p) => p.zone === "future");
    const futureStart = fi < 0 ? win.length : fi;

    const daily = {
      actual: win.map((p) => p.actual),
      derived: win.map((p) => p.derived ?? null),
      gbr: win.map((p) => p.gbr),
      polynomial: win.map((p) => p.polynomial),
      lstm: win.map((p) => p.lstm),
    } as Record<ModelKey | "actual", (number | null)[]>;

    const agg = aggregateSeries<ModelKey | "actual">({
      granularity,
      isoDates,
      baseActual: daily.actual,
      models: daily,
      rainfall: win.map(() => null),
      holdoutStart,
      futureStart,
    });

    return agg
      ? {
          // aggregateSeries returns `dates` as display labels and `isoDates` as
          // real dates. The axis keys off isoDates so it stays parseable.
          dates: agg.isoDates,
          isoDates: agg.isoDates,
          models: agg.models,
          holdoutStart: agg.holdoutStart,
          futureStart: agg.futureStart,
          bucketDays: agg.bucketDays,
          aggregated: true,
        }
      : {
          dates: isoDates,
          isoDates,
          models: daily,
          holdoutStart,
          futureStart,
          bucketDays: isoDates.map(() => 1),
          aggregated: false,
        };
  }, [data, granularity, pastDays, futureDays]);

  const isAggregated = !!view?.aggregated;
  const bucketNoun = granularity === "Weekly" ? "week" : granularity === "Monthly" ? "month" : "year";
  const meanLabel =
    granularity === "Weekly" ? "7-day mean"
    : granularity === "Monthly" ? "monthly mean"
    : granularity === "Yearly" ? "yearly mean"
    : "";

  // Which calendar dates fall in a horizon bucket the study marked unusable.
  // Read from gold.ml_horizon_accuracy, so if a retrain moves the weak stretch
  // the shading moves with it — and disappears entirely if nothing fails.
  const weakDates = useMemo(() => {
    const bad = (data?.horizonAccuracy ?? []).filter((b) => !b.usable);
    if (!bad.length || !data?.split.futureStart) return null;
    const t0 = new Date(data.split.futureStart + "T00:00:00").getTime();
    const day = 86400000;
    return bad.map((b) => ({
      from: new Date(t0 + (b.hLo - 1) * day),
      to: new Date(t0 + (b.hHi - 1) * day),
      label: `days ${b.hLo}-${b.hHi}`,
    }));
  }, [data]);

  /* Which "Ahead" widths to offer: the validated horizon always, then each longer step only where the run
     stores that many days and some stretch the step adds beat the baseline in the horizon study. Read
     from the payload, so a retrain changes the control by itself. */
  const horizons = useMemo(() => {
    const none = { offered: [] as { label: string; d: number }[], hidden: null as string | null, why: null as string | null };
    if (!data) return none;
    const base = data.horizonDays;
    const stored = data.split.futureDays > 0 ? data.split.futureDays : base;
    const buckets = data.horizonAccuracy ?? [];
    const steps = [
      { label: `${base} d`, d: Math.min(base, stored) },
      ...[
        { label: "2 wk", d: 14 },
        { label: "1 mo", d: 28 },
        { label: "2 mo", d: 60 },
        { label: "3 mo", d: 90 },
      ].filter((s) => s.d > base),
    ];
    const offered: { label: string; d: number }[] = [];
    const dropped: string[] = [];
    let failedAt: HzBucket | null = null;
    let notStored = false;
    steps.forEach((s, i) => {
      if (i === 0) return void offered.push(s);
      if (s.d > stored) return void (notStored = true);
      // What this step adds beyond the previous one; offered if any of it is usable.
      const added = buckets.filter((bk) => bk.hHi > steps[i - 1].d && bk.hLo <= s.d);
      if (buckets.length === 0 || added.length === 0 || added.some((bk) => bk.usable)) return void offered.push(s);
      dropped.push(s.label);
      failedAt ??= added[0];
    });
    if (offered.length === steps.length) return { ...none, offered };
    const f = failedAt as HzBucket | null;
    const why = f
      ? `The run stores ${stored} days ahead, but tested on past data the model loses to simply repeating last week from day ${f.hLo}` +
        (f.wmape != null && f.baselineWmape != null ? ` (days ${f.hLo}–${f.hHi}: ${f.wmape.toFixed(1)}% error against ${f.baselineWmape.toFixed(1)}%)` : "") +
        `, so ${dropped.join(", ")} ${dropped.length === 1 ? "is" : "are"} not offered. They appear here by themselves once a retrained model beats that baseline.`
      : notStored
        ? `The published forecast stores only ${stored} days ahead.`
        : null;
    const hidden = f
      ? offered.length === 1
        ? "longer ranges lose to repeating last week, so are not offered"
        : `${dropped.join(", ")} not offered: ${dropped.length === 1 ? "it loses" : "they lose"} to repeating last week`
      : notStored
        ? `only ${stored} days stored`
        : null;
    return { offered, hidden, why };
  }, [data]);

  // Keep the drawn width on an offered step: the default (7) and the stored run can disagree.
  useEffect(() => {
    if (horizons.offered.length && !horizons.offered.some((h) => h.d === futureDays)) setFutureDays(horizons.offered[0].d);
  }, [horizons, futureDays]);

  const option: EChartsOption | null = useMemo(() => {
    if (!view) return null;
    const { holdoutStart, futureStart } = view;
    /* Room for the future block. Weekly over all history puts the 7-day forecast on ONE point at the very right
       edge, where its band had no width and the point sat on the frame. A few empty slots after it (about 5% of
       the axis) give the Future band a visible width and its value label somewhere to sit. They carry no data
       and no axis label. */
    const realN = view.dates.length;
    const futureCount = Math.max(0, realN - futureStart);
    const pad = futureCount > 0 ? Math.max(0, Math.ceil(realN * 0.05) - futureCount) : 0;
    const dates = [...view.dates, ...Array.from({ length: pad }, (_, i) => `pad-${i}`)];
    const padded = (arr: (number | null)[]) => (pad ? [...arr, ...Array<null>(pad).fill(null)] : arr);
    // History is the measured line: solid, in primary ink.
    const actualColor = T.textPrimary;

    // These render on a CANVAS, so a CSS variable is not a colour here: ECharts
    // hands "var(--text-muted)" straight to ctx.fillStyle, the browser rejects
    // it, and the label falls back to a near-invisible default. That is why the
    // three band names could not be found on the chart. Real values only.
    const ZONE_INK: Record<string, string> = T.isDark
      ? { Past: "#a9b9da", Present: "#cfd9f0", Future: "#5cc8ff" }
      : { Past: "#55678b", Present: "#3b4d72", Future: "#0a6cc2" };
    const ZONE_CHIP: Record<string, string> = T.isDark
      ? { Past: "rgba(232,238,251,0.06)", Present: "rgba(232,238,251,0.10)", Future: "rgba(92,200,255,0.16)" }
      : { Past: "rgba(10,22,48,0.04)", Present: "rgba(10,22,48,0.07)", Future: "rgba(10,108,194,0.10)" };
    // The warning ink (--color-warning) as a literal, for the canvas.
    const WARN = T.isDark ? "#f6c544" : "#946500";

    const zoneLabel = (text: string) => ({
      show: true,
      position: "insideTop" as const,
      distance: 6,
      color: ZONE_INK[text],
      backgroundColor: ZONE_CHIP[text],
      borderRadius: 999,
      padding: [3, 9, 3, 9] as [number, number, number, number],
      fontSize: 11,
      fontWeight: 600 as const,
      fontFamily: CT.fontFamily,
      formatter: text,
    });

    const label = (iso: string) => {
      const d = new Date(iso + "T00:00:00");
      if (granularity === "Monthly") return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
      if (granularity === "Yearly") return String(d.getFullYear());
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    };

    // Zone bands, plus a hatch over any horizon stretch the study could not
    // vouch for. Assembled here so the whole thing carries one cast rather than
    // fighting ECharts' markArea typing inline.
    type AreaPair = [Record<string, unknown>, Record<string, unknown>];
    const zonePairs: AreaPair[] = ([
      { name: "Past", from: 0, to: holdoutStart - 1, color: ZONE.past },
      { name: "Present", from: holdoutStart, to: futureStart - 1, color: ZONE.present },
      { name: "Future", from: futureStart, to: dates.length - 1, color: ZONE.future },
      // (dates.length includes the empty slots, so the band reaches the frame.)
    ] as { name: string; from: number; to: number; color: string }[])
      .filter((z) => z.from <= z.to && dates[z.from] != null && dates[z.to] != null)
      .map((z) => [
        {
          xAxis: dates[z.from],
          itemStyle: { color: z.color },
          // The Future band is often a sliver at the right edge; its chip sits
          // just above the plot so it can never land on top of "Present".
          label: z.name === "Future" ? { ...zoneLabel(z.name), position: "top" as const, distance: 4 } : zoneLabel(z.name),
        },
        { xAxis: dates[z.to] },
      ] as AreaPair);

    // Saying in prose that "some days are weak" leaves the reader to work out
    // which. Shading them means a value read off the line carries its own
    // warning. The range comes from gold.ml_horizon_accuracy, so it follows a
    // retrain and disappears entirely if no bucket fails. Drawn with the chart
    // kit's hatch, labelled in the warning ink.
    const weakPairs: AreaPair[] = (weakDates ?? []).flatMap((w) => {
      const hit = view.isoDates
        .map((iso, i) => ({ i, t: new Date(iso + "T00:00:00").getTime() }))
        .filter((x) => x.t >= w.from.getTime() && x.t <= w.to.getTime());
      if (!hit.length) return [] as AreaPair[];
      const a = dates[hit[0].i];
      const b = dates[hit[hit.length - 1].i];
      if (a == null || b == null) return [] as AreaPair[];
      const hatch = gapMarkArea(CT, [[a, b]], `⚠ ${w.label}`);
      return [[
        {
          xAxis: a,
          itemStyle: hatch.itemStyle,
          label: { ...hatch.label, distance: 26, color: WARN, formatter: `⚠ ${w.label}` },
        },
        { xAxis: b },
      ] as AreaPair];
    });

    const markAreaData = [...zonePairs, ...weakPairs] as never[];

    /* Where "now" falls, if the axis reaches today. The forecast's own origin
       is marked either way; the NOW line is drawn only when today is actually
       on the chart, never pinned to the end of a series that stopped earlier. */
    const todayIso = new Date().toLocaleDateString("en-CA");
    const lastIso = view.isoDates[view.isoDates.length - 1];
    const lastSpan = view.bucketDays[view.bucketDays.length - 1] ?? 1;
    const lastEndIso = lastIso
      ? new Date(new Date(lastIso + "T00:00:00").getTime() + (lastSpan - 1) * 86_400_000).toLocaleDateString("en-CA")
      : null;
    let nowIdx: number | null = null;
    if (lastIso && lastEndIso && view.isoDates[0] <= todayIso && todayIso <= lastEndIso) {
      for (let i = view.isoDates.length - 1; i >= 0; i--) {
        if (view.isoDates[i] <= todayIso) { nowIdx = i; break; }
      }
    }
    const nowLine = nowIdx != null && dates[nowIdx] != null ? nowMarkLine(CT, dates[nowIdx]) : null;
    const boundaryLines = [
      ...(dates[holdoutStart] != null
        ? [{ xAxis: dates[holdoutStart], lineStyle: { type: "dashed" as const, color: ZONE.divider, width: 1 }, label: { show: false } }]
        : []),
      ...(dates[futureStart] != null
        ? [{
            xAxis: dates[futureStart],
            lineStyle: { type: "dashed" as const, color: T.textPrimary, width: 1, opacity: 0.85 },
            label: { show: true, formatter: "forecast →", position: "insideStartTop" as const, color: T.textPrimary, fontSize: 11, fontWeight: 600 as const, fontFamily: CT.fontFamily },
          }]
        : []),
      ...(nowLine ? [{ xAxis: dates[nowIdx as number], lineStyle: nowLine.lineStyle, label: nowLine.label }] : []),
    ];

    return {
      grid: { left: 66, right: 64, top: 34, bottom: 78 },
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const ps = params as { dataIndex: number; seriesName: string; value: number | null; color: string }[];
          if (!ps.length) return "";
          const i = ps[0].dataIndex;
          if (i >= realN) return "";
          const zoneText =
            i >= futureStart ? "Future — no actual to compare"
            : i >= holdoutStart ? "Holdout — scored against actual"
            : "Past — training context";
          const n = view.bucketDays[i] ?? 1;
          const head = view.aggregated
            ? `${label(view.isoDates[i])} · mean of ${n} day${n === 1 ? "" : "s"}`
            : shortDate(view.isoDates[i]);
          const actual = ps.find((p) => p.seriesName === "Actual CO₂")?.value ?? null;
          const rows = ps
            .filter((p) => p.value != null)
            .map((p) => {
              const err =
                p.seriesName !== "Actual CO₂" && actual != null && actual !== 0
                  ? `<span style="color:var(--text-muted);margin-left:8px">${
                      (p.value as number) - actual >= 0 ? "+" : ""
                    }${((((p.value as number) - actual) / actual) * 100).toFixed(1)}%</span>`
                  : "";
              return (
                `<div style="display:flex;gap:16px;justify-content:space-between">` +
                `<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px"></span>${p.seriesName}</span>` +
                `<span><b>${fmt(p.value)} t</b>${err}</span></div>`
              );
            })
            .join("");
          return (
            `<b>${head}</b>` +
            `<div style="color:var(--text-muted);font-size:11px;margin-bottom:4px">${zoneText}</div>` +
            rows
          );
        },
      },
      legend: {
        bottom: 34,
        // One line at every width: on a phone it pages instead of wrapping
        // onto the axis labels. Same entries, same click-to-toggle.
        type: "scroll",
        pageIconColor: T.textSecondary,
        pageIconInactiveColor: T.border,
        pageTextStyle: { color: T.textMuted },
        icon: "roundRect",
        itemWidth: 14,
        itemHeight: 4,
        formatter: (name: string) => (meanLabel ? `${name}  ·  ${meanLabel}` : name),
      },
      dataZoom: [
        { type: "inside", throttle: 60 },
        {
          type: "slider",
          height: 16,
          bottom: 6,
          borderColor: T.border,
          fillerColor: withAlpha(T.isDark ? "#f4f1ea" : "#0b1220", 0.08),
          backgroundColor: "transparent",
          dataBackground: {
            lineStyle: { color: withAlpha(T.isDark ? "#f4f1ea" : "#0b1220", 0.3), width: 1 },
            areaStyle: { color: withAlpha(T.isDark ? "#f4f1ea" : "#0b1220", 0.06) },
          },
          textStyle: { color: T.textMuted, fontSize: 11, fontFamily: CT.fontFamily },
        },
      ],
      xAxis: {
        type: "category",
        data: dates,
        boundaryGap: false,
        axisLabel: { hideOverlap: true, formatter: (v: string) => (v.startsWith("pad-") ? "" : label(v)) },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        // Not zero-based: the corridor never emits near zero, and anchoring at 0
        // flattens the series into the top of the plot.
        scale: true,
        name: meanLabel ? `tonnes CO₂ / day (${meanLabel})` : "tonnes CO₂ / day",
        nameLocation: "middle",
        nameGap: 50,
        axisLabel: { formatter: fmtAxis() },
      },
      series: [
        {
          name: "Actual CO₂",
          type: "line",
          data: padded(view.models.actual),
          smooth: true,
          connectNulls: false,
          symbol: "circle",
          symbolSize: dates.length > 400 ? 0 : 4,
          z: 3,
          lineStyle: { width: dates.length > 400 ? 1.6 : 2, color: actualColor },
          itemStyle: { color: actualColor },
          markArea: { silent: true, data: markAreaData },
          markLine: {
            silent: true,
            symbol: "none",
            animation: false,
            data: boundaryLines as never[],
          },
        },
        ...ORDER.filter((k) => selected.includes(k)).map((k) => {
          const champ = k === championKey;
          const lastFuture = view.models[k][realN - 1];
          return {
            name: LABEL[k],
            type: "line" as const,
            data: padded(view.models[k]),
            smooth: true,
            connectNulls: false,
            symbol: "circle" as const,
            // Points are drawn ONLY over the future block. Everywhere else the
            // series is dense enough that markers would just smear the line.
            // The champion's are larger: it is the forecast the headline quotes.
            symbolSize: (_v: unknown, params: { dataIndex: number }) =>
              params.dataIndex >= futureStart && params.dataIndex < realN ? (champ ? 10 : 7) : 0,
            z: champ ? 5 : 4,
            // Model output is dashed, so it can never pass for the measured line.
            lineStyle: { width: champ ? 2.4 : 2, color: COLOR[k], type: "dashed" as const },
            itemStyle: { color: COLOR[k], borderColor: T.tooltipBg, borderWidth: 2 },
            // The forecast's own value, written beside its last point, so the future reads at a glance instead
            // of being a dot to hover. Champion only: one number, the one the headline is about.
            ...(champ && futureCount > 0 && lastFuture != null && isFinite(lastFuture)
              ? {
                  markPoint: {
                    silent: true,
                    symbol: "circle",
                    symbolSize: 0,
                    data: [{ coord: [dates[realN - 1], lastFuture], value: lastFuture }],
                    label: {
                      show: true,
                      position: "right" as const,
                      distance: 10,
                      formatter: `${fmt(lastFuture, 0)} t`,
                      color: ZONE_INK.Future,
                      backgroundColor: ZONE_CHIP.Future,
                      borderRadius: 6,
                      padding: [3, 7, 3, 7] as [number, number, number, number],
                      fontSize: 12,
                      fontWeight: 700 as const,
                      fontFamily: CT.fontFamily,
                    },
                  } as never,
                }
              : {}),
          };
        }),
      ],
    };
  }, [view, selected, granularity, meanLabel, T, CT, ZONE, weakDates, championKey]);

  const titleRow = (
    <h3>
      Corridor <Term t="CO₂" /> Walk-Forward Forecast
      <InfoTooltip text="Modeled daily CO₂ (carbon dioxide) for the corridor: the model's past fit, its held-out test period, and the forecast ahead. Pick a model above." />
    </h3>
  );

  if (error) {
    return (
      <article className="chart-card wide nc-em-fc">
        {titleRow}
        <StateNote kind="error" role="alert" title={error}>
          Three attempts were made. This instance is shared, so a connection can be slow to
          establish while the training pipelines run — the stored forecast itself is unaffected.
          <span className="nc-em-state-action">
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setError(null);
                setAttempt((a) => a + 1);
              }}
            >
              Try again
            </button>
          </span>
        </StateNote>
      </article>
    );
  }
  if (!data || !view || !option) {
    return (
      <article className="chart-card wide nc-em-fc">
        {titleRow}
        <p className="nc-em-loading">
          {retrying ? "Database slow to respond — retrying…" : "Loading CO₂ forecast from AWS…"}
        </p>
        <div className="nc-em-skeleton"><ChartSkeleton /></div>
      </article>
    );
  }

  /* The answer: the champion's mean forecast over the future window on
     screen, read from the same stored series the chart draws. */
  const valOf = (p: Point, k: ModelKey) => (k === "derived" ? p.derived ?? null : p[k]);
  const champFuture = championKey ? data.series.filter((p) => p.zone === "future").slice(0, futureDays) : [];
  const champVals = championKey
    ? champFuture.map((p) => valOf(p, championKey)).filter((v): v is number => v != null && isFinite(v))
    : [];
  const champMean = champVals.length ? champVals.reduce((s, v) => s + v, 0) / champVals.length : null;
  const champMetric = championKey ? metricFor(championKey) : null;
  const tiedLabels = tied.map((n) => (FROM_DB[n] ? LABEL[FROM_DB[n]] : n));

  const modelToolbar = (
    <div className="nc-em-models">
      <span className="nc-em-ctl-label" title="Toggle models to overlay predictions">Models</span>
      {/* Each chip is the series' legend and its toggle: tinted with the
          series colour when on. */}
      <div className="nc-em-model-chips">
        {ORDER.map((k) => {
          const on = selected.includes(k);
          const locked = on && selected.length === 1;
          return (
            <button
              key={k}
              type="button"
              className={`nc-em-model${locked ? " is-locked" : ""}`}
              onClick={() => toggleModel(k)}
              aria-pressed={on}
              title={locked ? "At least one model must stay selected" : `${on ? "Hide" : "Show"} ${LABEL[k]}`}
              style={{ ["--chip-c" as string]: COLOR[k] }}
            >
              <span className="nc-em-model-dot" aria-hidden="true" />
              {LABEL[k]}
              {/* A star on one chip claims a winner. Only show it when the
                  trainer found one; with a tie every tied model gets an "=". */}
              {tied.length > 1
                ? tied.includes(DB_NAME[k]) && <span className="nc-em-model-mark" title="Co-champion">=</span>
                : k === championKey && (
                    <span className="nc-em-model-mark" title="Champion">
                      <Star size={11} strokeWidth={0} fill="currentColor" aria-hidden="true" />
                      <span className="sr-only">champion</span>
                    </span>
                  )}
            </button>
          );
        })}
      </div>
    </div>
  );

  /* The model trust strip: champion, how it was tested, the horizon it was
     checked at, and its accuracy against the seasonal-naive baseline. Every
     figure is the stored metric; the full table follows directly beneath, and
     "Show All Metrics" opens its remaining columns. (No live track record is
     stored for the CO2 forecast, so the strip claims none.) */
  const trustPills = (
    <>
      {tied.length > 1 ? (
        <span className="pill purple">Co-champions · {tiedLabels.join(" = ")}</span>
      ) : championKey ? (
        <span className="pill purple">
          <Star size={11} strokeWidth={0} fill="currentColor" aria-hidden="true" />
          Champion · {LABEL[championKey]}
        </span>
      ) : (
        <span className="pill">No champion</span>
      )}
      <span className="pill">
        Tested · {data.split.holdoutDays.toLocaleString()} held-out days
        {data.split.holdoutStart && data.split.holdoutEnd
          ? ` · ${shortDate(data.split.holdoutStart)} – ${shortDate(data.split.holdoutEnd)}`
          : ""}
      </span>
      <span className="pill">Horizon · {data.horizonDays} days</span>
      {champMetric?.mase != null && (
        <span
          className={`pill ${champMetric.mase < 1 ? "green" : "red"}`}
          title="Error relative to a seasonal-naive forecast. Below 1.0 beats it; above 1.0 does not."
        >
          MASE {champMetric.mase.toFixed(3)} · {champMetric.mase < 1 ? "beats" : "loses to"} seasonal-naive
        </span>
      )}
      {champMetric?.wmape != null && <span className="pill">WMAPE {champMetric.wmape.toFixed(2)}%</span>}
    </>
  );
  const trustStrip = (
    <div className="nc-em-trust" role="group" aria-label="Model trust">
      {trustPills}
    </div>
  );

  const metricsTable = (
    <section className="nc-em-validation" aria-label="Real-World ML Validation Metrics">
      <div className="nc-em-validation-head">
        <h4>Real-World ML Validation Metrics</h4>
        <button type="button" className="btn-muted nc-em-small-btn" onClick={() => setShowAllMetrics(!showAllMetrics)}>
          {showAllMetrics ? "Show Less" : "Show All Metrics"}
        </button>
      </div>
      {trustStrip}
      <div className="nc-em-table-wrap">
        <table className="nc-em-table" style={{ minWidth: showAllMetrics ? "820px" : "600px" }}>
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">RMSE (t)</th>
              <th className="num">MAE (t)</th>
              <th className="num">WMAPE</th>
              <th className="num">R² Score</th>
              <th className="num" title="Error relative to a seasonal-naive forecast. Below 1.0 beats it; above 1.0 does not.">
                MASE
              </th>
              {showAllMetrics && (
                <>
                  <th className="num">MAPE</th>
                  <th className="num">Rank</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {ORDER.filter((k) => selected.includes(k)).map((k) => {
              const m = metricFor(k);
              return (
                <tr key={k}>
                  <td className="nc-em-model-cell">
                    <span className="nc-em-model-name">
                      <span className="nc-em-series-dot" style={{ background: COLOR[k] }} aria-hidden="true" />
                      {LABEL[k]}
                      <span className={`nc-em-status ${m?.accepted ? "is-ok" : "is-bad"}`}>
                        {m
                          ? m.accepted
                            ? tied.includes(m.model) && tied.length > 1
                              ? `accepted · co-champion`
                              : `accepted · rank #${m.rank}`
                            : "rejected"
                          : "no metrics"}
                      </span>
                    </span>
                  </td>
                  <td className="num">{fmt(m?.rmse ?? null, 2)}</td>
                  <td className="num">{fmt(m?.mae ?? null, 2)}</td>
                  <td className="num nc-em-strong">{m?.wmape != null ? `${m.wmape.toFixed(2)}%` : "—"}</td>
                  <td className="num nc-em-strong">{fmt(m?.r2 ?? null, 4)}</td>
                  <td className={`num nc-em-strong ${m?.mase != null ? (m.mase < 1 ? "is-ok" : "is-bad") : "is-muted"}`}>
                    {fmt(m?.mase ?? null, 3)}
                  </td>
                  {showAllMetrics && (
                    <>
                      <td className="num is-muted">{m?.mape != null ? `${m.mape.toFixed(2)}%` : "—"}</td>
                      <td className="num is-muted">{m?.rank ?? "—"}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* sMAPE, RMSSE and adjusted R2 appear on the volume table because that run
          stores them. This run does not, and adding blank columns for them would
          imply they were computed. */}
      {tied.length > 1 && (
        <p className="nc-em-caption nc-em-warn-ink">
          <b>{tied.join(" and ")} are within the run-to-run jitter of each other, so neither is the winner.</b>
        </p>
      )}
      <details className="nc-details">
        {/* Named apart from ModelNarrative's own "How this is measured"
            (the CO2 caveat) further down the same card. */}
        <summary>How it was tested</summary>
        {/* The climatology caveat is carried by quantityNote (ModelNarrative),
            which is where the how-it-was-built detail belongs. What stays is
            the scoring basis and the one comparison a reader could otherwise
            get wrong. */}
        <p>
          Scored on {data.split.holdoutDays.toLocaleString()} held-out days at a {data.horizonDays}-day horizon · volume
          validates at 14d, so the two are not directly comparable.
        </p>
      </details>
    </section>
  );

  return (
    <article className="chart-card wide nc-em-fc">
      <header className="nc-em-fc-top">
        <div className="nc-em-fc-head">{titleRow}</div>
      </header>

      {/* The answer: the champion's mean over the forecast window on screen,
          with its window, model, last measured day and scope as context. */}
      {(champFuture.length > 0 || data.split.holdoutEnd) && (
        <div className="fc-answer">
          {championKey && champFuture.length > 0 && (
            <span className="fc-answer-label">Next {champFuture.length} days · average</span>
          )}
          {championKey && champMean != null && champFuture.length > 0 && (
            <span className="fc-answer-value">
              {fmt(champMean, 0)} t
              <span className="fc-answer-unit">CO₂ per day</span>
            </span>
          )}
          <span className="fc-answer-context">
            {championKey && champFuture.length > 0 && (
              <><b>{shortDate(champFuture[0].date)} – {shortDate(champFuture[champFuture.length - 1].date)}</b> · </>
            )}
            {championKey && <>model <b>{LABEL[championKey]}</b> · </>}
            {data.split.holdoutEnd && <>measured to <b>{shortDate(data.split.holdoutEnd)}</b> · </>}
            whole corridor, t CO₂ / day
          </span>
        </div>
      )}

      {/* Which forecasts are drawn. */}
      <div className="fc-row fc-models">{modelToolbar}</div>

      {/* Controls, then the key: the order every forecast card uses. View
          (grain), History (how much context), Ahead (how far to draw). */}
      <div className="fc-row fc-controls" role="group" aria-label="Forecast view">
        <div className="fc-group">
          <span className="fc-label">View</span>
          <div className="nc-em-seg">
            {/* Hourly is greyed out: CO2 is stored hourly but forecast daily, so
                there is no hourly prediction to drill into. */}
            <span
              className="nc-em-seg-off"
              aria-disabled="true"
              title="The CO₂ models forecast daily totals — there is no hourly prediction to drill into"
            >
              Hourly
            </span>
            {(["Daily", "Weekly", "Monthly"] as const).map((g) => (
              <button
                key={g}
                type="button"
                className={granularity === g ? "is-on" : ""}
                aria-pressed={granularity === g}
                onClick={() => {
                  setGranularity(g);
                  // Daily stays zoomed because 1,400 raw points is unreadable;
                  // the aggregated views bucket the data so they can show it all.
                  setPastDays(g === "Daily" ? 90 : ALL_PAST);
                }}
                title={
                  g === "Daily"
                    ? "One point per day — the resolution the models actually forecast"
                    : `Averaged per ${g.replace("ly", "").toLowerCase()} — a viewing aid, not a separate forecast`
                }
              >
                {g}
              </button>
            ))}
          </div>
        </div>

        {/* HISTORY window. The forecast is 7 days against up to 1,433 of
            history, so without this it is a sliver at the right edge no
            matter which granularity is chosen. */}
        <div className="fc-group">
          <span className="fc-label">History</span>
          <div className="nc-em-seg">
            {WINDOWS.map((wd) => (
              <button
                key={wd.label}
                type="button"
                className={pastDays === wd.days ? "is-on" : ""}
                aria-pressed={pastDays === wd.days}
                onClick={() => setPastDays(wd.days)}
                title={
                  wd.days >= ALL_PAST
                    ? "All context back to 2022 — the 7-day forecast will be a sliver"
                    : `Show the last ${wd.label} of context before the scored window, so the forecast is legible`
                }
              >
                {wd.label}
              </button>
            ))}
          </div>
        </div>

        <div className="fc-group">
          <span className="fc-label">Ahead</span>
          {/* Only the horizons the published forecast can back (17 Oct 2026, testers EM-9: "the week option
              cannot be clicked"; "the forecast only covers 7 days but other day options are offered"). Every
              longer step used to be drawn as a disabled button, and with the current run all of them were,
              so the strip was one live button and four dead ones. A step is now offered only if the run
              stores that many days AND some stretch it adds beat the baseline in gold.ml_horizon_accuracy.
              With one horizon left there is nothing to choose, so it is stated rather than drawn as a
              control, and why the rest are missing is on the note. A retrain that passes brings them back
              with no code change. */}
          {horizons.offered.length > 1 ? (
            <div className="nc-em-seg">
              {horizons.offered.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  className={futureDays === it.d ? "is-on" : ""}
                  aria-pressed={futureDays === it.d}
                  onClick={() => setFutureDays(it.d)}
                >
                  {it.label}
                </button>
              ))}
            </div>
          ) : (
            <span className="nc-em-seg">
              <span className="nc-em-seg-fixed">{horizons.offered[0]?.label ?? `${data.horizonDays} d`}</span>
            </span>
          )}
          <span className="fc-note nc-em-hz-note" title={horizons.why ?? undefined}>
            validated at {data.horizonDays}d{horizons.hidden ? ` · ${horizons.hidden}` : ""}
          </span>
        </div>
      </div>

      {/* What the chart is currently showing: the three zones with their
          split counts, and the averaging notice when points are means. */}
      <div className="fc-legend">
        <span className="nc-em-zone fc-legend-item">
          <i className="is-past" aria-hidden="true" />
          <b>Past</b>
          {/* Without this the band reads as "the 80%", when the selected range
              may be drawing only its final weeks. State both numbers. */}
          {/* Wording deliberately identical to the volume panel: same three
              facts in the same order, so a reader moving between the two
              modules is not re-learning the layout. */}
          <span>
            {data.split.trainDays.toLocaleString()}d trained
            {data.split.trainPct != null ? ` · ${data.split.trainPct}%` : ""}
            {pastDays < ALL_PAST && pastDays < data.split.trainDays && (
              <span className="nc-em-warn-ink">
                {" · "}showing last {pastDays.toLocaleString()}d
              </span>
            )}
          </span>
        </span>
        <span className="nc-em-zone fc-legend-item">
          <i className="is-present" aria-hidden="true" />
          <b>Present</b>
          <span>
            {data.split.holdoutDays.toLocaleString()}d scored
            {data.split.holdoutPct != null ? ` · ${data.split.holdoutPct}%` : ""} · fixed by evaluation
          </span>
        </span>
        <span className="nc-em-zone fc-legend-item">
          <i className="is-future" aria-hidden="true" />
          <b>Future</b>
          <span>{Math.min(futureDays, data.split.futureDays)}d projected</span>
        </span>
        {/* Aggregation notice — shown only when the values ARE aggregated, so it
            never becomes furniture the eye learns to ignore. */}
        {isAggregated && (
          <span
            className="nc-em-agg fc-push"
            title={`Each plotted point is the arithmetic mean of the days in its ${bucketNoun} — for the actual series and for every model line. Totals are never plotted: a sum would make a short ${bucketNoun} look like a dip.`}
          >
            <Diameter size={13} strokeWidth={2} aria-hidden="true" />
            Each point = {meanLabel}
            <span>averaged, not totalled</span>
          </span>
        )}
      </div>

      {/* Past the validated range the reader needs to know what they are looking
          at. Figures come from gold.ml_horizon_accuracy, measured by rolling
          origin out to 90 days - not extrapolated from the 7-day headline. */}
      {futureDays > VALIDATED_HORIZON && data.horizonAccuracy?.length > 0 && (() => {
        const shown = data.horizonAccuracy.filter((b) => b.hLo <= futureDays);
        const weak = shown.filter((b) => !b.usable);
        const maxWmape = Math.max(...shown.map((b) => b.wmape ?? 0), 0.0001);
        return (
          <div className="nc-em-banner">
            <TriangleAlert size={15} strokeWidth={2} aria-hidden="true" />
            <span>
              {/* Headline + the weak stretch + a per-bucket error bar visible;
                  the plain-words explanation of why forecasts drift (verbatim)
                  behind Details. Same facts, same figures. */}
              <b>Only the first {VALIDATED_HORIZON} days were checked against what actually happened.</b>
              {weak.length > 0 && (
                <span className="nc-em-banner-line">
                  <b
                    className="nc-em-warn-ink"
                    title={`MASE ${weak[0].mase?.toFixed(3)} — above 1.0 means it loses to a seasonal-naive benchmark (copy the same weekday from last week)`}
                  >
                    Days {weak[0].hLo}–{weak[0].hHi} are the least reliable — in that stretch you would do
                    better just repeating last week
                  </b>
                  . It steadies again after day {weak[0].hHi + 1}.
                </span>
              )}
              <span
                className="nc-em-hz"
                title="WMAPE — total absolute error as a share of total actual CO₂, measured by rolling-origin over 9 origins"
              >
                <span className="nc-em-hz-label">Typical error</span>
                {shown.map((b) => (
                  <span key={b.hLo} className={`nc-em-hz-row${b.usable ? "" : " is-weak"}`}>
                    <span>days {b.hLo}–{b.hHi}</span>
                    <span className="nc-em-inline-bar" aria-hidden="true">
                      <i style={{ width: `${Math.max(2, ((b.wmape ?? 0) / maxWmape) * 100)}%` }} />
                    </span>
                    <b>{b.wmape?.toFixed(0)}% off</b>
                  </span>
                ))}
              </span>
              <details className="nc-details">
                <summary>Details</summary>
                <p>
                  Only the first <b>{VALIDATED_HORIZON} days</b> were
                  checked against what actually happened. To predict a day, the model reads the days just before
                  it — and past day {VALIDATED_HORIZON} those days are themselves still in the future, so it
                  reads its own earlier forecasts instead of measurements. Nothing is invented: the measured
                  history stays exactly as recorded, and no actual value is ever filled in for a future date.
                  But forecasts built on forecasts drift, so from here the line describes the usual shape for
                  that time of year rather than any particular day.
                </p>
              </details>
            </span>
          </div>
        );
      })()}

      <div style={{ height: `${CHART_H}px`, width: "100%" }}>
        <DashboardChart option={option} height={CHART_H} />
      </div>

      {/* The validation evidence opens in a modal; its strip carries the headline figures. */}
      <EvidenceModal
        className="nc-em-ev"
        scopeClass="viz-emissions"
        subtitle="CO₂ forecast: every model's scores on held-out days, and how it was tested."
        strip={<>
          <span className="nct-trust-pill">
            <span className="nct-trust-k">{tied.length > 1 ? "Co-champions" : "Champion"}</span>
            {tied.length > 1 ? tiedLabels.join(" = ") : championKey ? LABEL[championKey] : "none"}
          </span>
          <span className="nct-trust-pill">
            <span className="nct-trust-k">Tested on</span>
            {data.split.holdoutDays.toLocaleString()} held-out days
            {data.split.holdoutStart && data.split.holdoutEnd
              ? ` · ${shortDate(data.split.holdoutStart)} – ${shortDate(data.split.holdoutEnd)}`
              : ""}
          </span>
          <span className="nct-trust-pill">
            <span className="nct-trust-k">Horizon</span>
            {data.horizonDays} days
          </span>
          {(champMetric?.mase != null || champMetric?.wmape != null) && (
            <span className="nct-trust-pill" title="MASE: error relative to a seasonal-naive forecast. Below 1.0 beats it; above 1.0 does not.">
              <span className="nct-trust-k">Accuracy</span>
              {champMetric?.wmape != null && <>WMAPE {champMetric.wmape.toFixed(2)}%</>}
              {champMetric?.wmape != null && champMetric?.mase != null && " · "}
              {champMetric?.mase != null && (
                <>
                  MASE {champMetric.mase.toFixed(3)}
                  <span className={champMetric.mase < 1 ? "nct-ok" : "nct-bad"}>
                    {champMetric.mase < 1 ? " · beats seasonal-naive" : " · loses to seasonal-naive"}
                  </span>
                </>
              )}
            </span>
          )}
        </>}
      >
        {metricsTable}
      </EvidenceModal>

      {/* Narrative is composed from the same rows that feed the table above, so the
          prose can never drift away from the numbers beside it. */}
      <ModelNarrative
        selected={ORDER.filter((k) => selected.includes(k))}
        metrics={data.metrics as unknown as MetricRow[]}
        scoredDays={data.split.holdoutDays}
        windowStart={data.split.holdoutStart}
        windowEnd={data.split.holdoutEnd}
        horizonDays={data.horizonDays}
        vocab={NARRATIVE_VOCAB}
        quantity="emissions"
        quantityNote={
          "CO₂ is not measured: it is derived from the same traffic series the volume forecast uses, times the per-class " +
          "EMEP/EEA Guidebook 2023 emission factors and the distance each trip drove, so the two panels reconcile by construction. " +
          "The factors are European fleet figures, not measured on NLEX, so an error in them shifts every tonnage without changing any accuracy figure. " +
          "Weather over the forecast window is day-of-year climatology in both scoring and projection, never observation."
        }
      />
    </article>
  );
}
