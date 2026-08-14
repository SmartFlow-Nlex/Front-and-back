"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// The seven candidates, keyed as the pipeline names them (MODEL_NAMES in
// train_incident_models.py). Each owns a distinct hue so several can share the
// chart at once without the reader having to guess which line is which.
type ModelKey =
  | "XGBoost"
  | "RandomForest"
  | "LSTM"
  | "GRU"
  | "Poisson_GLM"
  | "NegBinomial_GLM"
  | "SARIMAX";

const MODELS: { key: ModelKey; label: string; color: string }[] = [
  { key: "XGBoost", label: "XGBoost", color: "#16a34a" },
  { key: "RandomForest", label: "Random Forest", color: "#f59e0b" },
  { key: "Poisson_GLM", label: "Poisson GLM", color: "#8b5cf6" },
  { key: "NegBinomial_GLM", label: "Neg. Binomial GLM", color: "#0891b2" },
  { key: "SARIMAX", label: "SARIMAX", color: "#ef4444" },
  { key: "LSTM", label: "LSTM", color: "#db2777" },
  { key: "GRU", label: "GRU", color: "#64748b" },
];

const META = Object.fromEntries(MODELS.map((m) => [m.key, m])) as Record<
  ModelKey,
  (typeof MODELS)[number]
>;
const ACTUAL_COLOR = "#2563eb";
const RAIN_COLOR = "#38bdf8";

type DailyPoint = {
  date: string;
  actual: number | null;
  predicted: number | null;
  predictionType: "validation" | "future" | null;
  sameDayLastYear: number | null;
  rainfallMm: number | null;
  models: Partial<Record<ModelKey, number | null>>;
};

type ModelMetric = {
  model: string;
  MAE: number | null;
  RMSE: number | null;
  WMAPE: number | null;
  MASE: number | null;
  R2: number | null;
  Adjusted_R2: number | null;
  Train_R2: number | null;
  Gap: number | null;
  Diagnosis: string | null;
  isChampion: boolean;
  // "window": computed live from the rows inside the current Range/Weather
  // slice. "holdout": that slice had no scored rows, so these numbers are the
  // pipeline's full-holdout figures instead.
  source: "window" | "holdout";
  n: number;
};

type PredictiveData = {
  summary: {
    totalPredictedNext7Days: number;
    peakRiskDate: string | null;
    championModel: string | null;
  };
  daily: DailyPoint[];
  modelMetrics: ModelMetric[];
  featureImportance: { feature: string; importance: number }[];
  modelInfo: {
    championModel: string | null;
    forecastHorizon: number;
    trainedAt: string | null;
    metrics: Record<string, unknown> | null;
    scoredDays: number | null;
  };
  weatherMetrics: {
    weather: "all" | "dry" | "wet";
    days: number;
    models: { model: string; MAE: number; RMSE: number; R2: number | null; isChampion: boolean }[];
  } | null;
  // The row set every "window"-sourced row in modelMetrics was scored
  // against. Null exactly when every row fell back to source:"holdout" —
  // 12mo and All can report the identical scoringWindow (both fully contain
  // the same holdout), which is what makes their metrics identical too.
  scoringWindow: { start: string; end: string; n: number } | null;
  appliedFilters: {
    months: "3" | "12" | "all";
    weather: "all" | "dry" | "wet";
    contextFrom: string | null;
    contextTo: string | null;
  };
  // Earliest observed date / latest forecast date across the whole series
  // (not the resolved window) — used to cap the Range control's custom date
  // picker so a pick can't fall outside what the model actually covers.
  dataBounds: { minDate: string; maxDate: string };
  // The resolved Past/Present/Future band boundaries for THIS response's
  // window (unlike dataBounds, which is fixed regardless of Range). Used to
  // position markAreas directly instead of re-deriving them by scanning
  // `daily` for a predictionType change.
  windowBounds: {
    windowStart: string;
    validationStart: string | null;
    futureStart: string | null;
    windowEnd: string;
  };
  // = scoringWindow !== null. False means every model already fell back to
  // its full-holdout numbers, which carry no weather dimension — the Weather
  // chips would refetch and land on the identical row every time.
  weatherApplicable: boolean;
};

// Driven by the Range/Weather strip on the incident page so the Predictive tab
// answers to the same controls the Descriptive tab does.
type Props = {
  months?: "3" | "12" | "all";
  from?: string;
  to?: string;
  weather?: "all" | "dry" | "wet";
  // Fired whenever a response lands, so the page can lift dataBounds into its
  // own state and pass minDate/maxDate down to the Range control's date
  // picker. The page has no other way to know these — they come from the API,
  // not from anything computed client-side.
  onDataBoundsChange?: (bounds: { minDate: string; maxDate: string }) => void;
  // Fired alongside onDataBoundsChange with the same response's
  // weatherApplicable, so the page can disable the Weather chips when the
  // current Range has nothing for them to filter.
  onWeatherApplicableChange?: (applicable: boolean) => void;
};

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtDate = (d: string | null) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
// Same as fmtDate but with a year — the x-axis labels can afford to drop it
// (adjacent points disambiguate), a scoring-window caption spanning years
// (12mo vs All) cannot.
const fmtDateFull = (d: string | null) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
// modelInfo.trainedAt is a full ISO timestamp, not a plain date — appending
// "T00:00:00" to it (as fmtDate/fmtDateFull do) would produce an invalid
// string, so this parses it directly instead.
const fmtTrainedAt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "unknown date";
const fmtNum = (v: number | null, dp = 3) => (v == null ? "—" : v.toFixed(dp));

const zoneLabel = (text: string, show: boolean) => ({
  show,
  position: "insideTop" as const,
  color: "#94a3b8",
  fontSize: 11,
  fontWeight: 600 as const,
  formatter: text,
});

// Below this fraction of the chart's total width, a band's "Past"/"Present"/
// "Future" label collides with its neighbors rather than reading as a label —
// at 12mo the Present band can be ~90 days wide against ~450 total, which
// still renders legibly, but a custom range can squeeze it much narrower.
const MIN_ZONE_LABEL_FRACTION = 0.06;

// No defaults: with nothing passed the component sends no query params, so the
// API returns the same fixed-window payload it always did and the chart keeps
// its original shape.
export default function PredictiveIncidentChart({
  months,
  from,
  to,
  weather,
  onDataBoundsChange,
  onWeatherApplicableChange,
}: Props = {}) {
  const [data, setData] = useState<PredictiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Several models can be on screen at once; the list never empties so the
  // chart always has something to compare the ground truth against.
  const [selected, setSelected] = useState<ModelKey[]>([]);
  // Guards the one-time "open on the champion" default against filter refetches.
  const seededRef = useRef(false);

  const toggleModel = useCallback((key: ModelKey) => {
    setSelected((prev) => {
      if (!prev.includes(key)) return MODELS.filter((m) => m.key === key || prev.includes(m.key)).map((m) => m.key);
      if (prev.length === 1) return prev; // keep at least one line on the chart
      return prev.filter((k) => k !== key);
    });
  }, []);

  useEffect(() => {
    // A half-filled custom range would query a nonsense window — wait until
    // both dates are picked. Mirrors the same gate on the traffic chart
    // (PredictiveVolumeChart): `from` only ever arrives set once Custom is
    // active, so its presence is what signals "a custom range is in play".
    if (from !== undefined && (!from || !to)) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    const qs = new URLSearchParams();
    if (months) qs.set("months", months);
    if (weather) qs.set("weather", weather);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const url = qs.size > 0
      ? `${BACKEND}/api/incident/predictive?${qs}`
      : `${BACKEND}/api/incident/predictive`;

    fetch(url, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        // A non-2xx (e.g. 503 when the DB is unreachable or the pipeline
        // hasn't run yet) still has a parseable body — check success, not
        // just res.ok, so the message from the API reaches the UI.
        if (!json.success) throw new Error(json.message ?? "Request failed");
        const payload = json.data as PredictiveData;
        setData(payload);
        onDataBoundsChange?.(payload.dataBounds);
        onWeatherApplicableChange?.(payload.weatherApplicable);
        // Open on the champion so the default view matches the headline metrics,
        // but only on first load — re-seeding on every filter change would throw
        // away a model comparison the user had set up.
        if (!seededRef.current) {
          const champ = MODELS.find((m) => m.key === payload.summary.championModel)?.key;
          setSelected([champ ?? MODELS[0].key]);
          seededRef.current = true;
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load predictive forecast");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [months, from, to, weather, onDataBoundsChange, onWeatherApplicableChange]);

  // Only blank the card on the very first load. Changing Range or Weather
  // refetches, and swapping the whole chart out for a spinner each time made the
  // filter strip feel like it was resetting the page.
  if (loading && !data) {
    return (
      <article className="chart-card wide" style={{ height: "480px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ color: "#64748b" }}>Loading ML forecast from AWS…</div>
      </article>
    );
  }

  if (error || !data) {
    return (
      <article className="chart-card wide" style={{ height: "480px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: "420px" }}>
          <div style={{ fontWeight: 700, color: "#b91c1c", marginBottom: "6px" }}>Predictive analytics unavailable</div>
          <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>{error ?? "Database not reachable"}</div>
        </div>
      </article>
    );
  }

  const { daily, modelMetrics, modelInfo } = data;
  const dates = daily.map((d) => fmtDate(d.date));
  const actualData = daily.map((d) => d.actual);
  const lastIndex = dates.length - 1;

  // Only offer toggles for models the pipeline actually stored a series for.
  const availableModels = MODELS.filter((m) => daily.some((d) => d.models?.[m.key] != null));
  const shown = selected.filter((k) => availableModels.some((m) => m.key === k));
  const activeModels = shown.length > 0 ? shown : availableModels.slice(0, 1).map((m) => m.key);

  // Zone boundaries: found by scanning `daily` for its own predictionType,
  // the same way PredictiveVolumeChart finds holdoutStart/futureStart via
  // rows.findIndex(v => v.is_holdout) / (v => v.is_future) — a per-row flag
  // on the query's own (already Range-bounded) result set, not a lookup for a
  // specific boundary *date*. That self-clamps for free: if the resolved
  // window starts after validationStart (true for "3 mo" whenever the window
  // is narrower than the ~90-day holdout — windowStart=2026-05-01 vs
  // validationStart=2026-04-27 today), the excluded early validation rows
  // just aren't in `daily`, and this finds whatever the first *included*
  // validation row is — index 0 if the whole visible window is inside the
  // holdout, exactly matching pastStart=max(windowStart,validationStart).
  // An earlier version of this looked up windowBounds.validationStart as a
  // literal date via indexOf; that date can be absent from a narrow window's
  // result entirely, which made hasZones false and hid Present/Future along
  // with Past — the bug this replaces. windowBounds stays on the response as
  // documented, request-scoped metadata (still useful for a caption etc.);
  // it just isn't what positions these bands any more.
  const rawFutureStart = daily.findIndex((d) => d.predictionType === "future");
  const futureStart = rawFutureStart === -1 ? daily.length : rawFutureStart;

  const rawValidationStart = daily.findIndex((d) => d.predictionType === "validation");
  // Explicit Math.min against futureStart, not a sequential "fall back to
  // futureStart, else daily.length" chain — a fallback chain still has a path
  // where a later value ends up past futureStart if a third case is ever
  // added, which would let Past invert into Future again the way it did
  // before. Math.min makes "Past can never end past Future" true by
  // construction regardless of how validationStart was derived.
  const validationStart = Math.min(rawValidationStart === -1 ? futureStart : rawValidationStart, futureStart);

  const showPast = validationStart > 0;
  const showPresent = futureStart > validationStart;
  const showFuture = futureStart < daily.length;

  // A band's label is suppressed once it's too narrow to read on its own —
  // "Present" and "Future" are the ones that collide in practice, since the
  // forecast horizon here is short (~a week) against a Range that can be a
  // year wide. If every rendered band is that narrow, the widest of them
  // still gets a label rather than leaving the chart with none.
  const totalPoints = Math.max(daily.length, 1);
  const zoneFraction: Record<"Past" | "Present" | "Future", number> = {
    Past: showPast ? validationStart / totalPoints : 0,
    Present: showPresent ? (futureStart - validationStart) / totalPoints : 0,
    Future: showFuture ? (daily.length - futureStart) / totalPoints : 0,
  };

  // Dev-only invariant: the three bands must partition the axis without
  // overlapping, so their fractions can never sum past 100% (a float epsilon
  // guards against rounding noise, not a real violation). This exact check
  // would have caught both the "windowStart > validationStart" bug and the
  // "no validation row in view at all" bug that followed it — cheaper to
  // assert it here than to rediscover it by eyeballing a rendered chart again.
  if (process.env.NODE_ENV !== "production") {
    const total = zoneFraction.Past + zoneFraction.Present + zoneFraction.Future;
    if (total > 1 + 1e-6) {
      console.warn(
        "[PredictiveIncidentChart] Past/Present/Future band fractions sum to " +
          `${(total * 100).toFixed(2)}% (> 100%) — bands overlap. ` +
          `validationStart=${validationStart} futureStart=${futureStart} daily.length=${daily.length}`
      );
    }
  }

  const shownZones = (["Past", "Present", "Future"] as const).filter(
    (z) => (z === "Past" && showPast) || (z === "Present" && showPresent) || (z === "Future" && showFuture)
  );
  const widestZone = shownZones.reduce<(typeof shownZones)[number] | null>(
    (a, b) => (a === null || zoneFraction[b] > zoneFraction[a] ? b : a),
    null
  );
  const showZoneLabel = (zone: keyof typeof zoneFraction) =>
    zoneFraction[zone] >= MIN_ZONE_LABEL_FRACTION || zone === widestZone;

  // Built as an explicitly-typed tuple array (rather than conditional array
  // literals inline in `option`) because TS infers markArea.data as pairs of
  // exactly two points — spreading `showX ? [[a, b]] : []` per band inline
  // loses that tuple shape and widens each pair to a plain array, which
  // ECharts' MarkArea2DDataItemOption type then rejects.
  type ZoneMarkAreaPoint = { xAxis: number; itemStyle?: { color: string }; label?: ReturnType<typeof zoneLabel> };
  const markAreaData: [ZoneMarkAreaPoint, ZoneMarkAreaPoint][] = [];
  if (showPast) {
    markAreaData.push([
      { xAxis: 0, itemStyle: { color: "rgba(37, 99, 235, 0.05)" }, label: zoneLabel("Past", showZoneLabel("Past")) },
      { xAxis: Math.max(validationStart - 1, 0) },
    ]);
  }
  if (showPresent) {
    markAreaData.push([
      { xAxis: validationStart, itemStyle: { color: "rgba(249, 115, 22, 0.08)" }, label: zoneLabel("Present", showZoneLabel("Present")) },
      { xAxis: Math.max(futureStart - 1, 0) },
    ]);
  }
  if (showFuture) {
    markAreaData.push([
      { xAxis: futureStart, itemStyle: { color: "rgba(22, 163, 74, 0.08)" }, label: zoneLabel("Future", showZoneLabel("Future")) },
      { xAxis: lastIndex },
    ]);
  }
  // A divider only at a boundary where both neighboring bands are actually
  // drawn — a line at validationStart with no Past band to its left (or at
  // futureStart with nothing to its left) would be a stray mark, not a divider.
  const markLineData: { xAxis: number }[] = [];
  if (showPast && showPresent) markLineData.push({ xAxis: validationStart });
  if (showFuture && (showPast || showPresent)) markLineData.push({ xAxis: futureStart });

  const option: EChartsOption = {
    grid: { left: 60, right: 24, top: 28, bottom: 76 },
    tooltip: {
      trigger: "axis",
      formatter: (params: unknown) => {
        const items = params as { name: string; marker: string; seriesName: string; value: number | null }[];
        let tip = `<b>${items[0].name}</b><br/>`;
        items.forEach((p) => {
          if (p.value == null) return;
          const val = p.seriesName === "Rainfall" ? `${fmtNum(Number(p.value), 1)} mm` : fmtInt(Number(p.value));
          tip += `${p.marker} ${p.seriesName}: <b>${val}</b><br/>`;
        });
        return tip;
      },
    },
    legend: {
      data: ["Actual Count", ...activeModels.map((k) => `${META[k].label} Prediction`), "Rainfall"],
      bottom: 0,
      icon: "circle",
      itemGap: 16,
      textStyle: { fontSize: 12 },
    },
    xAxis: {
      type: "category",
      data: dates,
      axisLabel: { color: "#64748b" },
      axisLine: { lineStyle: { color: "#cbd5e1" } },
    },
    yAxis: [
      {
        type: "value",
        name: "Incident Count",
        nameLocation: "middle",
        nameGap: 40,
        min: 0,
        axisLabel: { color: "#64748b" },
        splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } },
      },
      {
        type: "value",
        name: "Rainfall (mm)",
        nameLocation: "middle",
        nameGap: 40,
        min: 0,
        position: "right",
        axisLabel: { color: RAIN_COLOR },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: "Rainfall",
        type: "bar",
        yAxisIndex: 1,
        data: daily.map((d) => d.rainfallMm),
        barMaxWidth: 14,
        itemStyle: { color: RAIN_COLOR, opacity: 0.35 },
        emphasis: { itemStyle: { opacity: 0.6 } },
        z: 1,
      },
      {
        name: "Actual Count",
        type: "line",
        data: actualData,
        smooth: true,
        symbol: "circle",
        symbolSize: 5,
        connectNulls: true,
        z: 3,
        lineStyle: { width: 2.5, color: ACTUAL_COLOR },
        itemStyle: { color: ACTUAL_COLOR },
        emphasis: { scale: 2.2 },
        // The bands ride on the ground-truth series so they stay anchored
        // regardless of which models are toggled on. Each band is included
        // independently (not one hasZones on/off for all three) — a window
        // narrower than the holdout should still show Present+Future even
        // though Past has nothing to show. Coordinates are plain indices, not
        // dates[i] label strings — see the comment above showPast/etc. for why.
        ...(markAreaData.length > 0
          ? {
              markArea: { silent: true, data: markAreaData },
              markLine: {
                silent: true,
                symbol: "none",
                label: { show: false },
                lineStyle: { type: "dashed", color: "#94a3b8" },
                data: markLineData,
              },
            }
          : {}),
      },
      ...activeModels.map((key) => ({
        name: `${META[key].label} Prediction`,
        type: "line" as const,
        data: daily.map((d) => d.models?.[key] ?? null),
        smooth: true,
        connectNulls: true,
        symbol: "circle" as const,
        symbolSize: 5,
        lineStyle: { width: 2.2, color: META[key].color },
        itemStyle: { color: META[key].color },
        emphasis: { scale: 2.2 },
      })),
    ],
  };

  const modelToolbar = (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: "0 1 auto", minWidth: 0 }}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: "#94a3b8", flex: "none" }}>
        <path d="M2 11.5l3.5-4 3 3L13.5 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10.5 4h3v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span style={{ fontSize: "0.74rem", fontWeight: 700, color: "var(--text-secondary, #4b5e7d)", letterSpacing: "0.02em", whiteSpace: "nowrap" }}>
        Models
      </span>
      {/* Same segmented-pill control the traffic chart uses, with each selected
          model tinted its own series colour. */}
      <div
        style={{
          display: "inline-flex", flexWrap: "wrap", gap: "2px", padding: "3px",
          background: "var(--bg-surface, #fff)", border: "1px solid #dce2ef", borderRadius: "999px",
        }}
      >
        {availableModels.map((m) => {
          const on = activeModels.includes(m.key);
          const locked = on && activeModels.length === 1;
          return (
            <button
              key={m.key}
              onClick={() => toggleModel(m.key)}
              aria-pressed={on}
              title={locked ? "At least one model must stay selected" : `${on ? "Hide" : "Show"} ${m.label}`}
              style={{
                display: "inline-flex", alignItems: "center", border: 0,
                padding: "5px 12px", borderRadius: "999px",
                fontSize: "0.76rem", fontWeight: 600, whiteSpace: "nowrap",
                cursor: locked ? "default" : "pointer", transition: "all 0.15s",
                background: on ? m.color : "transparent",
                color: on ? "#fff" : "var(--text-secondary, #4b5e7d)",
                boxShadow: on ? `0 1px 4px ${m.color}40` : "none",
              }}
            >
              {on && (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4, marginBottom: -1 }}>
                  <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              {m.label}
            </button>
          );
        })}
      </div>
    </div>
  );

  const th: React.CSSProperties = { padding: "6px 10px", fontWeight: 600, textAlign: "right" };
  const td: React.CSSProperties = { padding: "10px", textAlign: "right", color: "#0f172a" };

  // The table is a read-out of what's plotted, not a static leaderboard — it
  // lists exactly the models toggled on, the same way the traffic chart does.
  const shownMetrics = modelMetrics.filter((m) => activeModels.includes(m.model as ModelKey));

  // Explains why 12mo and All can show byte-identical numbers (both fully
  // contain the same 90-day holdout, so both score the same days) and why a
  // Wet R² reads "—" (n visible in its own column makes that self-evident
  // instead of looking like a missing value) — without either fact, the
  // table reads as broken rather than as reporting what it actually scored.
  const scoringCaption = data.scoringWindow
    ? `Scored on ${data.scoringWindow.n} validation day${data.scoringWindow.n === 1 ? "" : "s"} (${fmtDateFull(data.scoringWindow.start)} – ${fmtDateFull(data.scoringWindow.end)})`
    : `Full-holdout metrics from the last training run (${fmtTrainedAt(modelInfo.trainedAt)})`;

  const metricsTable = (
    <div style={{ background: "#f8fafc", borderRadius: "8px", padding: "16px", border: "1px solid #e2e8f0" }}>
      <div style={{ marginBottom: "12px" }}>
        <h4 style={{ margin: 0, fontSize: "0.95rem", color: "#334155", fontWeight: 600 }}>
          Real-World ML Validation Metrics
        </h4>
        <p style={{ margin: "4px 0 0 0", fontSize: "0.78rem", color: "#94a3b8" }}>{scoringCaption}</p>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem", minWidth: "610px" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#64748b", fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              <th style={{ padding: "6px 10px", fontWeight: 600 }}>Model</th>
              <th style={th}>RMSE</th>
              <th style={th}>MAE</th>
              <th style={th}>WMAPE</th>
              <th style={th}>MASE</th>
              <th style={th}>R² Score</th>
              <th style={th} title="Days scored">N</th>
            </tr>
          </thead>
          <tbody>
            {shownMetrics.map((m) => {
              const meta = META[m.model as ModelKey];
              const color = meta?.color ?? "#64748b";
              return (
                <tr key={m.model} style={{ background: "#fff", borderTop: "1px solid #e2e8f0" }}>
                  <td style={{ padding: "10px", fontWeight: 700, color: "#0f172a" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: color }} />
                      {meta?.label ?? m.model}
                      {m.isChampion && (
                        <span
                          style={{ fontSize: "0.72rem", fontWeight: 600, color: "#15803d" }}
                          title="Selected on the full holdout window when the model was trained, not on the currently visible Range/Weather slice"
                        >
                          Champion
                        </span>
                      )}
                      {m.source === "holdout" && (
                        <span
                          style={{ fontSize: "0.72rem", fontWeight: 500, color: "#94a3b8" }}
                          title="No scored days in the current Range/Weather selection — showing the pipeline's full-holdout numbers instead"
                        >
                          (full holdout)
                        </span>
                      )}
                    </span>
                  </td>
                  <td style={td}>{fmtNum(m.RMSE)}</td>
                  <td style={td}>{fmtNum(m.MAE)}</td>
                  <td style={td}>{m.WMAPE == null ? "—" : `${m.WMAPE.toFixed(2)}%`}</td>
                  <td style={td}>{fmtNum(m.MASE)}</td>
                  <td style={{ ...td, fontWeight: 700, color }}>{fmtNum(m.R2, 4)}</td>
                  <td style={td} title={m.R2 == null && m.n < 30 ? "R² is hidden below 30 scored days" : undefined}>
                    {m.n}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

  // Weather split. The pipeline scores every model over the whole holdout; this
  // re-scores it over only the wet (or only the dry) days of that same window,
  // which is the question the Weather control is really asking.
  const wm = data.weatherMetrics;
  const weatherPanel =
    wm == null ? null : (
      <div style={{ background: wm.weather === "wet" ? "#f0f9ff" : "#fffbeb", borderRadius: "8px", padding: "16px", border: `1px solid ${wm.weather === "wet" ? "#bae6fd" : "#fde68a"}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "8px", marginBottom: "12px" }}>
          <h4 style={{ margin: 0, fontSize: "0.95rem", color: "#334155", fontWeight: 600 }}>
            Accuracy on {wm.weather === "wet" ? "wet" : "dry"} days only
          </h4>
          <span style={{ fontSize: "0.72rem", color: "#94a3b8" }}>
            {wm.days} of {modelInfo.scoredDays ?? "—"} holdout days · wet = expressway-average rainfall &gt; 0.3 mm
          </span>
        </div>
        {wm.days === 0 ? (
          <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
            No {wm.weather} days in the scored window.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem", minWidth: "420px" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#64748b", fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  <th style={{ padding: "6px 10px", fontWeight: 600 }}>Model</th>
                  <th style={th}>MAE</th>
                  <th style={th}>RMSE</th>
                  <th style={th}>R² Score</th>
                </tr>
              </thead>
              <tbody>
                {wm.models
                  .filter((m) => activeModels.includes(m.model as ModelKey))
                  .map((m) => {
                    const meta = META[m.model as ModelKey];
                    const color = meta?.color ?? "#64748b";
                    return (
                      <tr key={m.model} style={{ background: "#fff", borderTop: "1px solid #e2e8f0" }}>
                        <td style={{ padding: "10px", fontWeight: 700, color: "#0f172a" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                            <span style={{ width: 10, height: 10, borderRadius: "50%", background: color }} />
                            {meta?.label ?? m.model}
                            {m.isChampion && (
                              <span
                                style={{ fontSize: "0.72rem", fontWeight: 600, color: "#15803d" }}
                                title="Selected on the full holdout window when the model was trained, not on the currently visible Range/Weather slice"
                              >
                                Champion
                              </span>
                            )}
                          </span>
                        </td>
                        <td style={td}>{fmtNum(m.MAE)}</td>
                        <td style={td}>{fmtNum(m.RMSE)}</td>
                        <td style={{ ...td, fontWeight: 700, color }}>{fmtNum(m.R2, 4)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "18px" }}>
      {/* Title and model chips share one row and only stack when the card is
          too narrow to hold both. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
        <div style={{ minWidth: "260px" }}>
          <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
            Incident Walk-Forward Forecast
          </h3>
        </div>
        {modelToolbar}
      </div>

      <div style={{ height: "450px", width: "100%" }}>
        <DashboardChart option={option} height={450} />
      </div>

      {metricsTable}
      {weatherPanel}
    </article>
  );
}
