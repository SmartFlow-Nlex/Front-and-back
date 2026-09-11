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
 *   - No Future width buttons. The volume run stores 28 future days and can show
 *     2wk/1mo; this run stores exactly the 7-day validated horizon.
 *
 * HORIZON is 7 days, versus 14 for volume, per the modelling diagram. The two
 * sets of error metrics are therefore NOT directly comparable.
 */

import type { EChartsOption } from "echarts";
import { useEffect, useMemo, useState } from "react";
import DashboardChart from "./DashboardChart";
import ModelNarrative, { type MetricRow, type NarrativeVocab } from "./ModelNarrative";
import { aggregateSeries, type Granularity } from "./aggregateSeries";
import { useThemeTokens, zoneTints } from "./useThemeTokens";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

const VALIDATED_HORIZON = 7; // must match train_emissions.py HORIZON

type Zone = "past" | "present" | "future";
type ModelKey = "gbr" | "polynomial" | "lstm";

type Point = {
  date: string;
  actual: number | null;
  predicted: number | null;
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

const ORDER: ModelKey[] = ["polynomial", "gbr", "lstm"];
const LABEL: Record<ModelKey, string> = {
  polynomial: "Polynomial",
  gbr: "Gradient Boosting",
  lstm: "LSTM",
};
/** UI key -> model_name in gold.ml_model_metrics */
const DB_NAME: Record<ModelKey, string> = { polynomial: "Polynomial", gbr: "GBR", lstm: "LSTM" };
const FROM_DB: Record<string, ModelKey> = { Polynomial: "polynomial", GBR: "gbr", LSTM: "lstm" };
const COLOR: Record<ModelKey, string> = {
  polynomial: "#7c3aed",
  gbr: "#f59e0b",
  lstm: "#0ea5e9",
};
const HOW_IT_WORKS: Record<ModelKey, string> = {
  polynomial:
    "Ridge regression on degree-2 terms over trend, the 7- and 28-day rolling means, lag-1, lag-7, day-of-week and rainfall.",
  gbr: "Gradient-boosted trees over the same lag, calendar and weather features. Captures interactions a linear fit cannot.",
  lstm: "Neural network over a 28-day window. Predicts one day at a time and feeds its own output back, so early errors compound.",
};

const NARRATIVE_VOCAB: NarrativeVocab = {
  dbName: DB_NAME,
  label: LABEL,
  color: COLOR,
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

  const option: EChartsOption | null = useMemo(() => {
    if (!view) return null;
    const { dates, holdoutStart, futureStart } = view;
    const actualColor = T.isDark ? "#e2e8f0" : "#1e293b";

    // These render on a CANVAS, so a CSS variable is not a colour here: ECharts
    // hands "var(--text-muted)" straight to ctx.fillStyle, the browser rejects
    // it, and the label falls back to a near-invisible default. That is why the
    // three band names could not be found on the chart. Real values only.
    const ZONE_INK: Record<string, string> = T.isDark
      ? { Past: "#93b4fd", Present: "#fdba74", Future: "#86efac" }
      : { Past: "#1d4ed8", Present: "#c2410c", Future: "#15803d" };
    const ZONE_CHIP: Record<string, string> = T.isDark
      ? { Past: "rgba(29,78,216,0.22)", Present: "rgba(194,65,12,0.22)", Future: "rgba(21,128,61,0.22)" }
      : { Past: "rgba(37,99,235,0.10)", Present: "rgba(249,115,22,0.14)", Future: "rgba(22,163,74,0.14)" };

    const zoneLabel = (text: string) => ({
      show: true,
      position: "insideTop" as const,
      distance: 6,
      color: ZONE_INK[text],
      backgroundColor: ZONE_CHIP[text],
      borderRadius: 4,
      padding: [3, 8, 3, 8] as [number, number, number, number],
      fontSize: 12,
      fontWeight: 700 as const,
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
    ] as { name: string; from: number; to: number; color: string }[])
      .filter((z) => z.from <= z.to && dates[z.from] != null && dates[z.to] != null)
      .map((z) => [
        { xAxis: dates[z.from], itemStyle: { color: z.color }, label: zoneLabel(z.name) },
        { xAxis: dates[z.to] },
      ] as AreaPair);

    // Saying in prose that "some days are weak" leaves the reader to work out
    // which. Shading them means a value read off the line carries its own
    // warning. The range comes from gold.ml_horizon_accuracy, so it follows a
    // retrain and disappears entirely if no bucket fails.
    const weakPairs: AreaPair[] = (weakDates ?? []).flatMap((w) => {
      const hit = view.isoDates
        .map((iso, i) => ({ i, t: new Date(iso + "T00:00:00").getTime() }))
        .filter((x) => x.t >= w.from.getTime() && x.t <= w.to.getTime());
      if (!hit.length) return [] as AreaPair[];
      const a = dates[hit[0].i];
      const b = dates[hit[hit.length - 1].i];
      if (a == null || b == null) return [] as AreaPair[];
      return [[
        {
          xAxis: a,
          itemStyle: { color: "rgba(249,115,22,0.22)" },
          label: {
            show: true, position: "insideTop", distance: 22,
            color: "#b45309", fontSize: 10, fontWeight: 700,
            formatter: `⚠ ${w.label}`,
          },
        },
        { xAxis: b },
      ] as AreaPair];
    });

    const markAreaData = [...zonePairs, ...weakPairs] as never[];

    return {
      grid: { left: 66, right: 64, top: 34, bottom: 74 },
      tooltip: {
        trigger: "axis",
        backgroundColor: T.tooltipBg,
        borderColor: T.border,
        textStyle: { color: T.tooltipText, fontSize: 12 },
        formatter: (params: unknown) => {
          const ps = params as { dataIndex: number; seriesName: string; value: number | null; color: string }[];
          if (!ps.length) return "";
          const i = ps[0].dataIndex;
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
        icon: "roundRect",
        itemWidth: 14,
        itemHeight: 4,
        textStyle: { color: T.textMuted, fontSize: 12 },
        formatter: (name: string) => (meanLabel ? `${name}  ·  ${meanLabel}` : name),
      },
      dataZoom: [
        { type: "inside", throttle: 60 },
        {
          type: "slider",
          height: 16,
          bottom: 6,
          borderColor: T.border,
          fillerColor: T.isDark ? "rgba(56,118,245,0.18)" : "rgba(37,99,235,0.08)",
          backgroundColor: T.isDark ? "rgba(255,255,255,0.03)" : "transparent",
          textStyle: { color: T.textMuted, fontSize: 10 },
        },
      ],
      xAxis: {
        type: "category",
        data: dates,
        boundaryGap: false,
        axisLabel: { color: T.textMuted, fontSize: 11, hideOverlap: true, formatter: (v: string) => label(v) },
        axisLine: { lineStyle: { color: T.border } },
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
        nameTextStyle: { color: T.textMuted, fontSize: 11 },
        axisLabel: { color: T.textMuted, fontSize: 11, formatter: (v: number) => v.toFixed(0) },
        splitLine: { lineStyle: { color: T.border, type: "dashed", opacity: 0.6 } },
      },
      series: [
        {
          name: "Actual CO₂",
          type: "line",
          data: view.models.actual,
          smooth: true,
          connectNulls: false,
          symbol: "circle",
          symbolSize: dates.length > 400 ? 0 : 4,
          z: 3,
          lineStyle: { width: dates.length > 400 ? 1.6 : 2.6, color: actualColor },
          itemStyle: { color: actualColor },
          markArea: { silent: true, data: markAreaData },
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { type: "dashed", color: ZONE.divider },
            data: [holdoutStart, futureStart]
              .filter((i) => dates[i] != null)
              .map((i) => ({ xAxis: dates[i], label: { show: false } })),
          },
        },
        ...ORDER.filter((k) => selected.includes(k)).map((k) => ({
          name: LABEL[k],
          type: "line" as const,
          data: view.models[k],
          smooth: true,
          connectNulls: true,
          symbol: "circle" as const,
          // Points are drawn ONLY over the future block. Everywhere else the
          // series is dense enough that markers would just smear the line.
          symbolSize: (_v: unknown, params: { dataIndex: number }) =>
            params.dataIndex >= futureStart ? 7 : 0,
          z: 4,
          lineStyle: { width: 2.2, color: COLOR[k], type: "dashed" as const },
          itemStyle: { color: COLOR[k], borderColor: "#fff", borderWidth: 1.5 },
        })),
      ],
    };
  }, [view, selected, granularity, meanLabel, T, ZONE, weakDates]);

  if (error) {
    return (
      <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: 12 }}>
        <h3 style={{ fontSize: "1.05rem", color: "var(--text-primary)", fontWeight: 700, margin: 0 }}>
          Corridor CO₂ Walk-Forward Forecast
        </h3>
        <div style={{ color: "var(--color-danger, #ef4444)", fontSize: "0.88rem" }}>{error}</div>
        <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--text-muted)", maxWidth: 620, lineHeight: 1.5 }}>
          Three attempts were made. This instance is shared, so a connection can be slow to
          establish while the training pipelines run — the stored forecast itself is unaffected.
        </p>
        <div>
          <button
            onClick={() => {
              setError(null);
              setAttempt((a) => a + 1);
            }}
            style={{
              padding: "6px 16px", borderRadius: 999, cursor: "pointer",
              border: "1px solid transparent", background: "linear-gradient(135deg, #6366f1, #4f46e5)",
              color: "#fff", fontSize: "0.78rem", fontWeight: 600,
              boxShadow: "0 1px 6px rgba(79,70,229,0.35)",
            }}
          >
            Try again
          </button>
        </div>
      </article>
    );
  }
  if (!data || !view || !option) {
    return (
      <article className="chart-card wide" style={{ padding: "24px" }}>
        <div style={{ color: "var(--text-secondary)" }}>
          {retrying ? "Database slow to respond — retrying…" : "Loading CO₂ forecast from AWS…"}
        </div>
      </article>
    );
  }


  const modelToolbar = (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: "0 1 auto", minWidth: 0 }}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: "var(--text-muted)", flex: "none" }}>
        <path d="M2 11.5l3.5-4 3 3L13.5 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10.5 4h3v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span
        style={{
          fontSize: "0.74rem", fontWeight: 700, color: "var(--text-secondary, #4b5e7d)",
          letterSpacing: "0.02em", whiteSpace: "nowrap",
        }}
      >
        Models
      </span>
      {/* Same segmented-pill control the volume panel uses, with each selected
          model tinted its own series colour. */}
      <div
        style={{
          display: "inline-flex", flexWrap: "wrap", gap: "2px", padding: "3px",
          background: "var(--bg-surface)", border: "1px solid #dce2ef", borderRadius: "999px",
        }}
      >
        {ORDER.map((k) => {
          const on = selected.includes(k);
          const locked = on && selected.length === 1;
          return (
            <button
              key={k}
              onClick={() => toggleModel(k)}
              aria-pressed={on}
              title={locked ? "At least one model must stay selected" : `${on ? "Hide" : "Show"} ${LABEL[k]}`}
              style={{
                display: "inline-flex", alignItems: "center", border: 0,
                padding: "5px 12px", borderRadius: "999px",
                fontSize: "0.76rem", fontWeight: 600, whiteSpace: "nowrap",
                cursor: locked ? "default" : "pointer", transition: "all 0.15s",
                background: on ? COLOR[k] : "transparent",
                color: on ? "var(--bg-surface)" : "var(--text-secondary, #4b5e7d)",
                boxShadow: on ? `0 1px 4px ${COLOR[k]}40` : "none",
              }}
            >
              {on && (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4, marginBottom: -1 }}>
                  <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              {LABEL[k]}
              {/* A star on one chip claims a winner. Only show it when the
                  trainer found one; with a tie every tied model gets an "=". */}
              {tied.length > 1
                ? tied.includes(DB_NAME[k]) && <span style={{ marginLeft: 5, fontSize: "0.68rem" }}>=</span>
                : k === championKey && <span style={{ marginLeft: 5, fontSize: "0.68rem" }}>★</span>}
            </button>
          );
        })}
      </div>
    </div>
  );

  const metricsTable = (
    <div
      style={{
        background: "var(--bg-surface-hover)", borderRadius: "8px", padding: "16px",
        border: "1px solid var(--border-default)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <h4 style={{ margin: "0", fontSize: "0.95rem", color: "var(--text-primary)", fontWeight: 600 }}>
          Real-World ML Validation Metrics
        </h4>
        <button
          onClick={() => setShowAllMetrics(!showAllMetrics)}
          style={{
            display: "inline-flex", alignItems: "center", gap: "6px", padding: "4px 10px", borderRadius: "6px",
            background: showAllMetrics ? "var(--bg-surface-hover)" : "var(--bg-surface)",
            border: "1px solid var(--border-strong)", color: "var(--text-secondary)",
            fontSize: "0.75rem", fontWeight: 600, cursor: "pointer", transition: "all 0.15s",
          }}
        >
          {showAllMetrics ? "Show Less" : "Show All Metrics"}
        </button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%", borderCollapse: "collapse", fontSize: "0.85rem",
            minWidth: showAllMetrics ? "820px" : "600px",
          }}
        >
          <thead>
            <tr
              style={{
                textAlign: "left", color: "var(--text-muted)", fontSize: "0.72rem",
                textTransform: "uppercase", letterSpacing: "0.05em",
              }}
            >
              <th style={{ padding: "6px 10px", fontWeight: 600 }}>Model</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>RMSE (t)</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>MAE (t)</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>WMAPE</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>R² Score</th>
              <th
                style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}
                title="Error relative to a seasonal-naive forecast. Below 1.0 beats it; above 1.0 does not."
              >
                MASE
              </th>
              {showAllMetrics && (
                <>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>MAPE</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Rank</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {ORDER.filter((k) => selected.includes(k)).map((k) => {
              const m = metricFor(k);
              return (
                <tr key={k} style={{ background: "var(--bg-surface)", borderTop: "1px solid var(--border-default)" }}>
                  <td style={{ padding: "10px", fontWeight: 700, color: "var(--text-primary)" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: COLOR[k] }} />
                      {LABEL[k]}
                      <span
                        style={{
                          fontSize: "0.72rem", fontWeight: 500,
                          color: m?.accepted ? "var(--color-success)" : "var(--color-danger)",
                        }}
                      >
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
                  <td style={{ padding: "10px", textAlign: "right", color: "var(--text-primary)" }}>
                    {fmt(m?.rmse ?? null, 2)}
                  </td>
                  <td style={{ padding: "10px", textAlign: "right", color: "var(--text-primary)" }}>
                    {fmt(m?.mae ?? null, 2)}
                  </td>
                  <td style={{ padding: "10px", textAlign: "right", fontWeight: 700, color: COLOR[k] }}>
                    {m?.wmape != null ? `${m.wmape.toFixed(2)}%` : "—"}
                  </td>
                  <td style={{ padding: "10px", textAlign: "right", fontWeight: 700, color: COLOR[k] }}>
                    {fmt(m?.r2 ?? null, 4)}
                  </td>
                  <td
                    style={{
                      padding: "10px", textAlign: "right", fontWeight: 700,
                      color:
                        m?.mase != null
                          ? m.mase < 1 ? "var(--color-success)" : "var(--color-danger)"
                          : "var(--text-secondary)",
                    }}
                  >
                    {fmt(m?.mase ?? null, 3)}
                  </td>
                  {showAllMetrics && (
                    <>
                      <td style={{ padding: "10px", textAlign: "right", color: "var(--text-secondary)" }}>
                        {m?.mape != null ? `${m.mape.toFixed(2)}%` : "—"}
                      </td>
                      <td style={{ padding: "10px", textAlign: "right", color: "var(--text-secondary)" }}>
                        {m?.rank ?? "—"}
                      </td>
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
      <p style={{ margin: "10px 0 0", fontSize: "0.72rem", color: "var(--text-muted)" }}>
        Scored on {data.split.holdoutDays.toLocaleString()} held-out days at a {data.horizonDays}-day horizon, with the
        forecast window&apos;s weather taken from day-of-year climatology rather than observations — a model is never shown
        rain it could not have known. The volume module validates at 14 days, so its figures are not directly comparable.
        {tied.length > 1 && (
          <>
            {" "}
            <b style={{ color: "var(--text-secondary)" }}>
              {tied.join(" and ")} are within the run-to-run jitter of each other, so neither is the winner.
            </b>
          </>
        )}
      </p>
    </div>
  );

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "18px" }}>
      {/* Title and model chips share one row and only stack when the card is too
          narrow to hold both. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
        <div style={{ minWidth: "260px" }}>
          <h3
            style={{
              fontSize: "1.05rem", color: "var(--text-primary)", fontWeight: 700,
              margin: 0, letterSpacing: "-0.01em",
            }}
          >
            Corridor CO₂ Walk-Forward Forecast
          </h3>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.82rem", margin: "4px 0 0 0" }}>
            {isAggregated ? (
              <>
                Every point is a <b style={{ color: "#1d4ed8" }}>{meanLabel}</b> — the average of that {bucketNoun}
                &apos;s days, not a total · Toggle models to overlay predictions
              </>
            ) : (
              <>Tonnes of CO₂ per day across the whole corridor · Toggle models to overlay predictions</>
            )}
          </p>
        </div>
        {modelToolbar}
      </div>

      {/* Zone window & Granularity controls. Two explicit rows: what you can
          CHANGE on top, what the chart currently SHOWS underneath. */}
      <div
        style={{
          display: "flex", flexDirection: "column", gap: "7px",
          padding: "9px 16px", borderRadius: "10px", background: "var(--bg-surface-hover)",
          border: "1px solid var(--border-default)", fontSize: "0.76rem",
        }}
      >
        {/* Row 1 — controls */}
        <div
          style={{
            display: "flex", alignItems: "center", gap: "18px", flexWrap: "wrap",
            justifyContent: "space-between",
          }}
        >
          {/* Aggregation notice — shown only when the values ARE aggregated, so it
              never becomes furniture the eye learns to ignore. */}
          {isAggregated && (
            <span
              title={`Each plotted point is the arithmetic mean of the days in its ${bucketNoun} — for the actual series and for every model line. Totals are never plotted: a sum would make a short ${bucketNoun} look like a dip.`}
              style={{
                display: "inline-flex", alignItems: "center", gap: "7px",
                padding: "4px 11px", borderRadius: "999px",
                background: "#1d4ed8", border: "1px solid #1d4ed8",
                color: "#ffffff", fontSize: "0.78rem", fontWeight: 700,
                whiteSpace: "nowrap", letterSpacing: "0.01em",
                boxShadow: "0 1px 6px rgba(29,78,216,0.30)",
              }}
            >
              <span style={{ fontSize: "0.85rem", lineHeight: 1 }}>⌀</span>
              Each point = {meanLabel}
              <span style={{ fontWeight: 500, color: "#bfdbfe" }}>averaged, not totalled</span>
            </span>
          )}

          {/* GRANULARITY control pill */}
          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <b style={{ color: "#3b82f6", letterSpacing: "0.04em", fontSize: "0.75rem", textTransform: "uppercase" }}>
              GRANULARITY
            </b>
            <div
              style={{
                display: "inline-flex", alignItems: "center", padding: "2px",
                borderRadius: "999px", background: "var(--bg-surface)", border: "1px solid #dce2ef",
              }}
            >
              {/* Hourly is greyed out: CO2 is stored hourly but forecast daily, so
                  there is no hourly prediction to drill into. */}
              <span
                title="The CO₂ models forecast daily totals — there is no hourly prediction to drill into"
                style={{
                  padding: "3px 10px", borderRadius: "999px", color: "var(--text-muted)",
                  fontWeight: 600, fontSize: "0.72rem", cursor: "not-allowed", opacity: 0.5,
                }}
              >
                Hourly
              </span>
              {(["Daily", "Weekly", "Monthly"] as const).map((g) => (
                <button
                  key={g}
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
                  style={{
                    padding: "3px 10px", borderRadius: "999px", cursor: "pointer", border: "none",
                    background: "transparent",
                    color: granularity === g ? "#3876f5" : "var(--text-secondary)",
                    fontWeight: granularity === g ? 700 : 600, fontSize: "0.72rem",
                  }}
                >
                  {granularity === g ? `✓ ${g}` : g}
                </button>
              ))}
            </div>
          </span>

          {/* HISTORY window. The forecast is 7 days against up to 1,433 of
              history, so without this it is a sliver at the right edge no
              matter which granularity is chosen. */}
          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <b style={{ color: "#3b82f6", letterSpacing: "0.04em", fontSize: "0.75rem", textTransform: "uppercase" }}>
              HISTORY
            </b>
            <div
              style={{
                display: "inline-flex", alignItems: "center", padding: "2px",
                borderRadius: "999px", background: "var(--bg-surface)", border: "1px solid #dce2ef",
              }}
            >
              {WINDOWS.map((wd) => (
                <button
                  key={wd.label}
                  onClick={() => setPastDays(wd.days)}
                  title={
                    wd.days >= ALL_PAST
                      ? "All context back to 2022 — the 7-day forecast will be a sliver"
                      : `Show the last ${wd.label} of context before the scored window, so the forecast is legible`
                  }
                  style={{
                    padding: "3px 10px", borderRadius: "999px", cursor: "pointer", border: "none",
                    background: "transparent",
                    color: pastDays === wd.days ? "#3876f5" : "var(--text-secondary)",
                    fontWeight: pastDays === wd.days ? 700 : 600, fontSize: "0.72rem",
                  }}
                >
                  {pastDays === wd.days ? `✓ ${wd.label}` : wd.label}
                </button>
              ))}
            </div>
          </span>
        </div>

        {/* Row 2 — what the chart is currently showing. Kept together so the three
            zones always read as one group. */}
        <div
          style={{
            display: "flex", alignItems: "center", gap: "18px", flexWrap: "wrap",
            justifyContent: "space-between", paddingTop: "8px", borderTop: "1px solid var(--border-default)",
          }}
        >
          {/* Past */}
          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(37,99,235,0.25)" }} />
            <b style={{ color: "var(--text-primary)" }}>Past</b>
            {/* Without this the band reads as "the 80%", when the selected range
                may be drawing only its final weeks. State both numbers. */}
            {/* Wording deliberately identical to the volume panel: same three
                facts in the same order, so a reader moving between the two
                modules is not re-learning the layout. */}
            <span style={{ color: "var(--text-secondary)" }}>
              {data.split.trainDays.toLocaleString()}d trained
              {data.split.trainPct != null ? ` · ${data.split.trainPct}%` : ""}
              {pastDays < ALL_PAST && pastDays < data.split.trainDays && (
                <span style={{ color: "var(--color-warning)" }}>
                  {" · "}showing last {pastDays.toLocaleString()}d
                </span>
              )}
            </span>
          </span>

          {/* Present */}
          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(249,115,22,0.35)" }} />
            <b style={{ color: "var(--text-primary)" }}>Present</b>
            <span style={{ color: "var(--text-secondary)" }}>
              {data.split.holdoutDays.toLocaleString()}d scored
              {data.split.holdoutPct != null ? ` · ${data.split.holdoutPct}%` : ""} · fixed by evaluation
            </span>
          </span>

          {/* Future */}
          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(22,163,74,0.3)" }} />
            <b style={{ color: "var(--text-primary)" }}>Future</b>
            {/* Same steps as the volume panel, EXCEPT that a range is dropped when
                everything it newly shows failed the gates.
                  7d -> 2wk adds days 8-14 and nothing else, and that whole
                  stretch loses to repeating last week — so the option exists
                  only to display unusable output.
                  7d -> 1mo also spans those days, but the majority it adds
                  (15-30) is usable, and the weak part is shaded on the chart.
                An option is offered when it buys something; days you cannot
                avoid drawing get a warning instead. Computed from
                gold.ml_horizon_accuracy, so a retrain that fixes the weak
                stretch brings the option back on its own. */}
            {[
              { label: "7 d", d: 7 },
              { label: "2 wk", d: 14 },
              { label: "1 mo", d: 28 },
              { label: "2 mo", d: 60 },
              { label: "3 mo", d: 90 },
            ]
              .filter((it, i, arr) => {
                const buckets = data.horizonAccuracy ?? [];
                if (!buckets.length || i === 0) return true;
                const prev = arr[i - 1].d;
                const added = buckets.filter((bk) => bk.hHi > prev && bk.hLo <= it.d);
                return added.length === 0 || added.some((bk) => bk.usable);
              })
              .map((it) => (
              <button
                key={it.label}
                onClick={() => setFutureDays(it.d)}
                disabled={it.d > data.split.futureDays}
                style={{
                  padding: "3px 10px", borderRadius: "999px",
                  cursor: it.d > data.split.futureDays ? "not-allowed" : "pointer",
                  border: futureDays === it.d ? "1px solid #16a34a" : "1px solid var(--border-default)",
                  background: futureDays === it.d ? "#16a34a" : "var(--bg-surface)",
                  color: futureDays === it.d ? "#fff" : "var(--text-secondary)",
                  fontWeight: 600, fontSize: "0.72rem",
                  opacity: it.d > data.split.futureDays ? 0.4 : 1,
                }}
              >
                {it.label}
              </button>
            ))}
            <span style={{ color: "var(--text-secondary)" }}>· validated at {VALIDATED_HORIZON}d</span>
          </span>
        </div>
      </div>

      {/* Past the validated range the reader needs to know what they are looking
          at. Figures come from gold.ml_horizon_accuracy, measured by rolling
          origin out to 90 days - not extrapolated from the 7-day headline. */}
      {futureDays > VALIDATED_HORIZON && data.horizonAccuracy?.length > 0 && (() => {
        const shown = data.horizonAccuracy.filter((b) => b.hLo <= futureDays);
        const weak = shown.filter((b) => !b.usable);
        return (
          <div style={{
            display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 14px",
            borderRadius: 10, background: "rgba(249,115,22,0.08)",
            border: "1px solid rgba(249,115,22,0.28)", fontSize: "0.75rem",
            color: "var(--text-secondary)", lineHeight: 1.55,
          }}>
            <span style={{ fontSize: "0.9rem", lineHeight: 1 }}>⚠</span>
            <span>
              {/* This said "rolled forward recursively", "seasonal trajectory"
                  and a raw MASE figure — all correct, none of it readable without
                  already knowing the terms. Same facts, plain words; the exact
                  metrics stay on hover for anyone who wants them. */}
              Only the first <b style={{ color: "var(--text-primary)" }}>{VALIDATED_HORIZON} days</b> were
              checked against what actually happened. To predict a day, the model reads the days just before
              it — and past day {VALIDATED_HORIZON} those days are themselves still in the future, so it
              reads its own earlier forecasts instead of measurements. Nothing is invented: the measured
              history stays exactly as recorded, and no actual value is ever filled in for a future date.
              But forecasts built on forecasts drift, so from here the line describes the usual shape for
              that time of year rather than any particular day.
              {weak.length > 0 && (
                <>
                  {" "}
                  <b
                    title={`MASE ${weak[0].mase?.toFixed(3)} — above 1.0 means it loses to a seasonal-naive benchmark (copy the same weekday from last week)`}
                    style={{ color: "var(--color-warning)" }}
                  >
                    Days {weak[0].hLo}–{weak[0].hHi} are the least reliable — in that stretch you would do
                    better just repeating last week
                  </b>
                  . It steadies again after day {weak[0].hHi + 1}.
                </>
              )}
              <span
                title="WMAPE — total absolute error as a share of total actual CO₂, measured by rolling-origin over 9 origins"
                style={{ display: "block", marginTop: 4, color: "var(--text-muted)" }}
              >
                Typical error:{" "}
                {shown.map((b, i) => (
                  <span key={b.hLo}>
                    {i > 0 && " · "}
                    days {b.hLo}–{b.hHi}{" "}
                    <b style={{ color: b.usable ? "var(--text-secondary)" : "var(--color-warning)" }}>
                      {b.wmape?.toFixed(0)}% off
                    </b>
                  </span>
                ))}
              </span>
            </span>
          </div>
        );
      })()}

      <div style={{ height: `${CHART_H}px`, width: "100%" }}>
        <DashboardChart option={option} height={CHART_H} />
      </div>

      {metricsTable}

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
          "DENR/DOTC emission factors and each exit's corridor segment, so the two panels reconcile by construction. The " +
          "factors themselves are unvalidated, so an error in them shifts every tonnage without changing any accuracy figure. " +
          "Weather over the forecast window is day-of-year climatology in both scoring and projection, never observation."
        }
      />
    </article>
  );
}
