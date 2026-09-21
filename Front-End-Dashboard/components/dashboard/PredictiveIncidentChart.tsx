"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import InfoTooltip from "./InfoTooltip";
import { aggregateSeries } from "./aggregateSeries";
import IncidentNarrative, { MetricHint, metricHintFor, modelHintFor } from "./IncidentNarrative";
import {
  ACTUAL_COLOR,
  META,
  MODELS,
  RAIN_COLOR,
  VOLUME_COLOR,
  fmtDate,
  fmtDateFull,
  fmtInt,
  fmtNum,
  fmtTrainedAt,
  type ModelKey,
  type PredictiveData,
} from "./incidentPredictive.shared";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// ModelKey, MODELS, META, the response types and the formatters all live in
// ./incidentPredictive.shared so this chart, the narrative and the visual
// analysis panels cannot disagree about a model's label or hue.

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

// How far into the Future band to draw, mirroring the Future control on the
// traffic chart. `d` counts days from the first forecast row, and the control
// only ever trims what is already on the response — it cannot ask the API for
// a longer horizon, because the horizon is whatever the training run wrote
// into ml_predictive_incidents.
//
// That pipeline currently writes 7 forecast days, so the wider presets render
// disabled rather than hidden: a greyed "1 mo" states the ceiling, where an
// absent button would read as a missing feature. They enable themselves once
// the table holds that many days, with no change needed here.
const FUTURE_PRESETS = [
  { label: "1 wk", d: 7 },
  { label: "2 wk", d: 14 },
  { label: "1 mo", d: 28 },
] as const;

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
  // null = "show the whole horizon the pipeline wrote", which is what the chart
  // did before this control existed. Kept as null rather than seeded to a
  // preset so a Range change never silently hides forecast days the previous
  // selection happened to be narrower than.
  const [futureDays, setFutureDays] = useState<number | null>(null);
  // Exposure overlay, off by default: the chart's subject is the incident
  // forecast, and a second axis should be something the reader opts into rather
  // than something they have to clear away before they can read the lines.
  const [showVolume, setShowVolume] = useState(false);
  // Rainfall overlay, on by default: this is the chart's original behavior
  // (Rainfall always drawn), kept as the default so existing views don't
  // change until the user opts out — mirrors showVolume's off-by-default in
  // spirit, just with the opposite starting state since Rainfall used to be
  // unconditional.
  const [showWeather, setShowWeather] = useState(true);
  // Viewing aid only, same contract as PredictiveVolumeChart's granularity
  // control (see aggregateSeries.ts) — bucketed points are a MEAN of the days
  // inside them and never change what was scored or forecast. No Hourly here:
  // this chart's drill-down already opens the hourly breakdown from any Daily
  // point, so an Hourly granularity would offer nothing an Hourly button on
  // the traffic chart's own (decorative, always-disabled) control does either.
  const [granularity, setGranularity] = useState<"Daily" | "Weekly" | "Monthly">("Daily");
  // Accident/breakdown split view. Only offered when the dedicated accident
  // forecast exists (data.accidentSplit); off by default so the chart opens on
  // the same total-count view it always has.
  const [splitView, setSplitView] = useState(false);
  // Guards the one-time "open on the champion" default against filter refetches.
  const seededRef = useRef(false);
  const router = useRouter();

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
    // Which trained variant (primary / volume-free / weather-free) the
    // accuracy metrics table is scored against — must travel with the request
    // so the table the API returns matches the lines this render is about to
    // plot from d.models/modelsNoVolume/modelsNoWeather below. Omitted at the
    // default ("on") so an unrelated caller's URL doesn't grow for no reason.
    if (!showVolume) qs.set("volumeToggle", "off");
    if (!showWeather) qs.set("weatherToggle", "off");
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
        // away a model comparison the user had set up. `selected` isn't a fetch
        // dependency (below), so this can't trigger a redundant refetch.
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
  }, [months, from, to, weather, showVolume, showWeather, onDataBoundsChange, onWeatherApplicableChange]);

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

  const { daily: fullDaily, modelMetrics, modelInfo } = data;

  // Trim the tail of the forecast horizon to the selected width. Past and
  // Present sit entirely before the first future row, so cutting rows off the
  // end leaves every earlier index untouched — which is why the zone
  // boundaries below need none of the index rebasing PredictiveVolumeChart
  // does, since that chart trims its head as well.
  const rawFullFutureStart = fullDaily.findIndex((d) => d.predictionType === "future");
  const fullFutureStart = rawFullFutureStart === -1 ? fullDaily.length : rawFullFutureStart;
  const futureAvailable = fullDaily.length - fullFutureStart;
  // Clamped, so a selection made while a wide Range was loaded cannot outrun a
  // narrower window's shorter horizon and slice past the end of the array.
  const effectiveFutureDays = Math.min(futureDays ?? futureAvailable, futureAvailable);
  const daily = fullDaily.slice(0, fullFutureStart + effectiveFutureDays);
  const dates = daily.map((d) => fmtDate(d.date));

  // Drill-down: any point on any series maps back to its day by dataIndex, since
  // every series here is plotted against the same effective (possibly
  // aggregated) date array. Every day navigates regardless of which band it
  // falls in — the hourly view is driven by recorded weather, which exists
  // for the whole window including the forecast horizon, and that page states
  // when a day's incident log hasn't caught up rather than drawing zeros for
  // it. Disabled once bucketed (below): a point is a period there, not a
  // single day, mirroring PredictiveVolumeChart's openDay.
  const openDay = (i: number) => {
    if (isAggregated) return;
    if (i < 0 || i >= effIso.length) return;
    // Carry the current Range/Weather along so the drill-down's "Back to daily"
    // can restore the exact view it was opened from, rather than dropping the
    // user back on the default 12-month window.
    const qs = new URLSearchParams({ date: effIso[i] });
    if (months) qs.set("months", months);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    if (weather) qs.set("weather", weather);
    router.push(`/dashboard/incident/hourly?${qs}`);
  };
  // x-axis labels are click targets too (xAxis.triggerEvent below) — a wider
  // hit area than the line symbols, mirroring PredictiveVolumeChart's onChartClick.
  const onChartClick = (p: { componentType?: string; dataIndex?: number; value?: string }) => {
    if (p.componentType === "xAxis") return openDay(effDates.indexOf(String(p.value)));
    if (typeof p.dataIndex === "number") openDay(p.dataIndex);
  };
  const actualData = daily.map((d) => d.actual);

  // Only offer toggles for models the pipeline actually stored a series for.
  const availableModels = MODELS.filter((m) => daily.some((d) => d.models?.[m.key] != null));

  // Whether this table carries a volume-free twin. When it does, the Volume
  // toggle switches the forecast itself — volume ON shows the volume-aware fit,
  // OFF shows what the same models predict having never seen volume. When it
  // does not (a table written before the twins existed), the toggle governs the
  // overlay alone and the caption below says so, rather than implying a change
  // to the lines that isn't happening.
  const hasVolumeFreeTwin = daily.some((d) => d.modelsNoVolume != null);
  // Same idea for rain_mm: when the pipeline stored a weather-free twin, the
  // Weather toggle can switch the forecast itself the same way Volume's does.
  const hasWeatherFreeTwin = daily.some((d) => d.modelsNoWeather != null);
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

  // The scored window itself never moves — only how much of it is drawn — so
  // this is computed off the raw daily boundaries, before any Future trim or
  // aggregation below, the same way PredictiveVolumeChart's toolbar caption
  // reads its untrimmed chartData.holdoutStart/futureStart rather than the
  // (possibly cut/bucketed) render-local ones.
  const presentScoredDays = futureStart - validationStart;

  // Past/Present's share of the full trained-plus-scored window — real
  // figures straight from the training run's own metadata (modelInfo.
  // trainedDays/scoredDays), not derived from whatever's currently drawn, so
  // the percentage stays true regardless of which Range slice is on screen.
  const trainedPlusScored = (modelInfo.trainedDays ?? 0) + presentScoredDays;
  const trainedPct = trainedPlusScored > 0 && modelInfo.trainedDays != null ? (modelInfo.trainedDays / trainedPlusScored) * 100 : null;
  const scoredPct = trainedPlusScored > 0 ? (presentScoredDays / trainedPlusScored) * 100 : null;

  // Aggregation: a viewing aid only, same contract as PredictiveVolumeChart
  // (see aggregateSeries.ts) — a bucket carries the MEAN of the days inside
  // it and cannot change what was scored or forecast. Volume rides along as
  // an extra "model" column so it gets the same mean-and-majority-zone
  // treatment as everything else without a second aggregation pass.
  type AggKey = ModelKey | "__volume" | "__accA" | "__accP" | "__bdA" | "__bdP";
  const modelsFlat = Object.fromEntries(
    availableModels.map((m) => [
      m.key,
      daily.map((d) => {
        if (d.predictionType !== "validation" && d.predictionType !== "future") return null;
        // Same twin-selection rule the model-line series below applies — kept
        // in sync by hand since both need to answer the current toggle state
        // identically before either one aggregates or draws anything.
        const source =
          showVolume && showWeather ? d.models
          : !showVolume && showWeather ? (d.modelsNoVolume ?? d.models)
          : showVolume && !showWeather ? (d.modelsNoWeather ?? d.models)
          : (d.modelsNoVolume ?? d.modelsNoWeather ?? d.models);
        return source?.[m.key] ?? null;
      }),
    ])
  ) as Record<ModelKey, (number | null)[]>;

  // Accident/breakdown split. Accidents come from their own trained model.
  // Breakdowns are NOT a second model: a dedicated breakdown model measured no
  // better than the blended fit, so they are derived as (blended champion
  // forecast - accident forecast) and (actual total - actual accidents), which
  // reconstructs the total exactly. Forecasts use the champion's PRIMARY
  // series; the Volume/Weather twins only switch the overlay in this view.
  const split = data.accidentSplit;
  const splitOn = splitView && split != null;
  const accByDate = new Map((split?.daily ?? []).map((r) => [r.date, r]));
  const isForecastRow = (d: (typeof daily)[number]) => d.predictionType === "validation" || d.predictionType === "future";
  const accA = daily.map((d) => accByDate.get(d.date)?.actual ?? null);
  const accP = daily.map((d) => (isForecastRow(d) ? accByDate.get(d.date)?.predicted ?? null : null));
  const bdA = daily.map((d, i) => (d.actual != null && accA[i] != null ? d.actual - (accA[i] as number) : null));
  const bdP = daily.map((d, i) =>
    isForecastRow(d) && d.predicted != null && accP[i] != null ? Math.max(d.predicted - (accP[i] as number), 0) : null
  );

  const agg =
    granularity === "Daily"
      ? null
      : aggregateSeries<AggKey>({
          granularity,
          isoDates: daily.map((d) => d.date),
          baseActual: actualData,
          models: { ...modelsFlat, __volume: daily.map((d) => d.volume ?? null), __accA: accA, __accP: accP, __bdA: bdA, __bdP: bdP },
          rainfall: daily.map((d) => d.rainfallMm),
          holdoutStart: validationStart,
          futureStart,
        });

  const isAggregated = agg != null;
  const effDates = agg ? agg.dates : dates;
  const effIso = agg ? agg.isoDates : daily.map((d) => d.date);
  const effActual = agg ? agg.baseActual : actualData;
  const effRainfall = agg ? agg.rainfall : daily.map((d) => d.rainfallMm);
  const effModels: Record<AggKey, (number | null)[]> = agg ? agg.models : (modelsFlat as Record<AggKey, (number | null)[]>);
  const effVolume = effModels.__volume ?? daily.map((d) => d.volume ?? null);
  const effAccA = agg ? agg.models.__accA : accA;
  const effAccP = agg ? agg.models.__accP : accP;
  const effBdA = agg ? agg.models.__bdA : bdA;
  const effBdP = agg ? agg.models.__bdP : bdP;
  const effHoldoutStart = agg ? agg.holdoutStart : validationStart;
  const effFutureStart = agg ? agg.futureStart : futureStart;
  const effLastIndex = effDates.length - 1;

  const showPast = effHoldoutStart > 0;
  const showPresent = effFutureStart > effHoldoutStart;
  const showFuture = effFutureStart < effDates.length;

  // A band's label is suppressed once it's too narrow to read on its own —
  // "Present" and "Future" are the ones that collide in practice, since the
  // forecast horizon here is short (~a week) against a Range that can be a
  // year wide. If every rendered band is that narrow, the widest of them
  // still gets a label rather than leaving the chart with none.
  const totalPoints = Math.max(effDates.length, 1);
  const zoneFraction: Record<"Past" | "Present" | "Future", number> = {
    Past: showPast ? effHoldoutStart / totalPoints : 0,
    Present: showPresent ? (effFutureStart - effHoldoutStart) / totalPoints : 0,
    Future: showFuture ? (effDates.length - effFutureStart) / totalPoints : 0,
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
          `holdoutStart=${effHoldoutStart} futureStart=${effFutureStart} dates.length=${effDates.length}`
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
      { xAxis: Math.max(effHoldoutStart - 1, 0) },
    ]);
  }
  if (showPresent) {
    markAreaData.push([
      { xAxis: effHoldoutStart, itemStyle: { color: "rgba(249, 115, 22, 0.08)" }, label: zoneLabel("Present", showZoneLabel("Present")) },
      { xAxis: Math.max(effFutureStart - 1, 0) },
    ]);
  }
  if (showFuture) {
    markAreaData.push([
      { xAxis: effFutureStart, itemStyle: { color: "rgba(22, 163, 74, 0.08)" }, label: zoneLabel("Future", showZoneLabel("Future")) },
      { xAxis: effLastIndex },
    ]);
  }
  // A divider only at a boundary where both neighboring bands are actually
  // drawn — a line at validationStart with no Past band to its left (or at
  // futureStart with nothing to its left) would be a stray mark, not a divider.
  const markLineData: { xAxis: number }[] = [];
  if (showPast && showPresent) markLineData.push({ xAxis: effHoldoutStart });
  if (showFuture && (showPast || showPresent)) markLineData.push({ xAxis: effFutureStart });

  // Rainfall shaded by intensity so the bars read as a weather condition at a
  // glance rather than as anonymous blue blocks. Thresholds match
  // PredictiveVolumeChart's PAGASA-advisory bands so the two charts agree on
  // what counts as "Heavy" — only the caption below differs, because rain
  // pushes incidents the opposite way it pushes volume.
  const RAIN_BANDS = [
    { max: 7.5, label: "Light", color: "rgba(56, 189, 248, 0.45)" },
    { max: 15, label: "Moderate", color: "rgba(14, 165, 233, 0.65)" },
    { max: 30, label: "Heavy", color: "rgba(2, 132, 199, 0.8)" },
    { max: Infinity, label: "Intense", color: "rgba(30, 64, 175, 0.9)" },
  ];
  const rainBand = (mm: number) => RAIN_BANDS.find((b) => mm < b.max) ?? RAIN_BANDS[RAIN_BANDS.length - 1];

  // Zone bands + dividers, attached to whichever series is the ground truth.
  const bandProps =
    markAreaData.length > 0
      ? {
          markArea: { silent: true, data: markAreaData },
          markLine: {
            silent: true,
            symbol: "none" as const,
            label: { show: false },
            lineStyle: { type: "dashed" as const, color: "#94a3b8" },
            data: markLineData,
          },
        }
      : {};

  const ACCIDENT_COLOR = "#dc2626";
  const BREAKDOWN_COLOR = "#0f766e";
  const splitLine = (name: string, data: (number | null)[], color: string, forecast: boolean) => ({
    name,
    type: "line" as const,
    data,
    smooth: true,
    connectNulls: true,
    symbol: "circle" as const,
    symbolSize: 5,
    z: forecast ? 3 : 4,
    lineStyle: { width: forecast ? 2.2 : 2.5, color, type: forecast ? ("dashed" as const) : ("solid" as const) },
    itemStyle: { color },
    emphasis: { scale: 2.2 },
  });
  const SPLIT_SERIES = [
    { ...splitLine("Actual Accidents", effAccA, ACCIDENT_COLOR, false), ...bandProps },
    splitLine("Accident forecast", effAccP, ACCIDENT_COLOR, true),
    splitLine("Actual Breakdowns", effBdA, BREAKDOWN_COLOR, false),
    splitLine("Breakdown forecast (derived)", effBdP, BREAKDOWN_COLOR, true),
  ];

  // Legend swatches for the split view: three short bars read as a dashed line, one long
  // bar as a solid one. The path's own bounding box is scaled to itemWidth x itemHeight
  // (28 x 3), so these stay thin lines rather than blocks.
  const SOLID_SWATCH = "path://M0,0h28v3h-28z";
  const DASHED_SWATCH = "path://M0,0h8v3h-8zM10,0h8v3h-8zM20,0h8v3h-8z";
  const legendData: (string | { name: string; icon: string })[] = [
    ...(splitOn
      ? [
          { name: "Actual Accidents", icon: SOLID_SWATCH },
          { name: "Accident forecast", icon: DASHED_SWATCH },
          { name: "Actual Breakdowns", icon: SOLID_SWATCH },
          { name: "Breakdown forecast (derived)", icon: DASHED_SWATCH },
        ]
      : ["Actual Count", ...activeModels.map((k) => `${META[k].label} Prediction`)]),
    // The bar/overlay entries keep a block-like icon in split view (a 3px circle would vanish).
    ...(showWeather ? [splitOn ? { name: "Rainfall", icon: "roundRect" } : "Rainfall"] : []),
    ...(showVolume ? [splitOn ? { name: "Vehicle Volume", icon: SOLID_SWATCH } : "Vehicle Volume"] : []),
  ];

  const option: EChartsOption = {
    grid: { left: 60, right: 24, top: 28, bottom: 96 },
    // A scrub/zoom bar under the chart, same as PredictiveVolumeChart's —
    // useful specifically because Range can put hundreds of daily points on
    // screen at once; the slider lets a reader narrow in without switching
    // Range or Granularity. "inside" mirrors the slider for scroll/pinch.
    dataZoom: [
      {
        type: "slider",
        xAxisIndex: 0,
        bottom: 30,
        height: 16,
        borderColor: "transparent",
        backgroundColor: "#eef2ff",
        fillerColor: "rgba(79,70,229,0.25)",
        handleStyle: { color: "#4f46e5", borderColor: "#4f46e5" },
        moveHandleStyle: { color: "#4f46e5" },
        textStyle: { color: "#64748b", fontSize: 10 },
        showDetail: false,
      },
      { type: "inside", xAxisIndex: 0 },
    ],
    tooltip: {
      trigger: "axis",
      formatter: (params: unknown) => {
        const items = params as { name: string; marker: string; seriesName: string; value: number | null }[];
        let tip = `<b>${items[0].name}</b><br/>`;
        items.forEach((p) => {
          if (p.value == null) return;
          const val =
            p.seriesName === "Rainfall"
              ? `${fmtNum(Number(p.value), 1)} mm`
              : p.seriesName === "Vehicle Volume"
                ? `${fmtInt(Number(p.value))} vehicles`
                : fmtInt(Number(p.value));
          tip += `${p.marker} ${p.seriesName}: <b>${val}</b><br/>`;
        });
        tip += `<span style="color:#94a3b8;font-size:11px">${
          isAggregated ? "Switch to Daily to open a day" : "Click to view hourly breakdown"
        }</span>`;
        return tip;
      },
    },
    legend: {
      data: legendData,
      bottom: 0,
      icon: "circle",
      itemGap: 16,
      // Split view draws each series as a thin line swatch (solid = actual, dashed =
      // forecast) so the legend matches the line style; a coloured dot was the same for
      // both members of a pair. Total view keeps the dots.
      ...(splitOn ? { itemWidth: 28, itemHeight: 3 } : {}),
      textStyle: { fontSize: 12 },
    },
    xAxis: {
      type: "category",
      data: effDates,
      // Labels are click targets too — a wider hit area than the line symbols
      // (matches PredictiveVolumeChart's xAxis).
      triggerEvent: true,
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
        show: showWeather,
        axisLabel: { color: RAIN_COLOR },
        splitLine: { show: false },
      },
      // Volume rides its own axis because it is ~4 orders of magnitude above an
      // incident count; sharing either existing axis would flatten one series
      // into a straight line. Offset clears the rainfall axis, and the whole
      // axis hides with the series so no orphaned scale is left behind when the
      // overlay is off.
      {
        type: "value",
        name: "Vehicle Volume",
        nameLocation: "middle",
        nameGap: 62,
        position: "right",
        offset: 58,
        show: showVolume,
        // scale:true, unlike the other two: volume never approaches zero, so a
        // zero-based axis would compress every day into one flat band near the
        // top and hide exactly the variation the overlay is there to show.
        scale: true,
        axisLabel: {
          color: VOLUME_COLOR,
          formatter: (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`),
        },
        axisLine: { show: true, lineStyle: { color: VOLUME_COLOR } },
        splitLine: { show: false },
      },
    ],
    series: [
      // Weather overlay, same pattern as Volume below: an empty array when
      // off rather than a hidden series, so ECharts drops the bars and their
      // axis space entirely instead of just visually hiding them.
      ...(showWeather
        ? [
            {
              name: "Rainfall",
              type: "bar" as const,
              yAxisIndex: 1,
              data: effRainfall.map((mm) =>
                mm == null ? null : { value: mm, itemStyle: { color: rainBand(mm).color } }
              ),
              barMaxWidth: 14,
              itemStyle: { borderRadius: [2, 2, 0, 0] },
              z: 1,
            },
          ]
        : []),
      // Exposure. A line rather than a second bar set: rainfall already holds
      // the bars, and two bar series on one chart compete for the same visual
      // slot. Drawn under the incident lines (z:2) so it reads as context.
      // connectNulls stays FALSE deliberately — a gap in the warehouse should
      // look like a gap, not like a straight line drawn through missing days.
      ...(showVolume
        ? [
            {
              name: "Vehicle Volume",
              type: "line" as const,
              yAxisIndex: 2,
              data: effVolume,
              smooth: true,
              symbol: "none" as const,
              connectNulls: false,
              z: 2,
              lineStyle: { width: 2, color: VOLUME_COLOR, type: "solid" as const },
              itemStyle: { color: VOLUME_COLOR },
              areaStyle: { color: VOLUME_COLOR, opacity: 0.08 },
            },
          ]
        : []),
      ...(splitOn ? SPLIT_SERIES : []),
      ...(splitOn ? [] : [{
        name: "Actual Count",
        type: "line" as const,
        data: effActual,
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
        ...bandProps,
      }]),
      ...(splitOn ? [] : activeModels).map((key) => ({
        name: `${META[key].label} Prediction`,
        type: "line" as const,
        // Model curves are drawn only across Present (validation) and Future —
        // modelsFlat above already nulls out Train rows and picks which of a
        // day's three stored series (primary / volume-free / weather-free)
        // answers the current toggle state, the same rule the backend's
        // pickPrediction applies when scoring modelMetrics, so the table
        // underneath never disagrees with what this line is plotting. Reading
        // from effModels here (rather than re-deriving per-day) is what lets
        // this line aggregate along with everything else under Weekly/Monthly.
        data: effModels[key] ?? [],
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
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem", minWidth: "610px" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#64748b", fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              <th style={{ padding: "6px 10px", fontWeight: 600 }}>Model</th>
              <th style={th}><MetricHint hint={metricHintFor("RMSE")}>RMSE</MetricHint></th>
              <th style={th}><MetricHint hint={metricHintFor("MAE")}>MAE</MetricHint></th>
              <th style={th}><MetricHint hint={metricHintFor("WMAPE")}>WMAPE</MetricHint></th>
              <th style={th}><MetricHint hint={metricHintFor("MASE")}>MASE</MetricHint></th>
              <th style={th}><MetricHint hint={metricHintFor("R² Score")}>R² Score</MetricHint></th>
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
                      <MetricHint hint={modelHintFor(m.model as ModelKey)}>{meta?.label ?? m.model}</MetricHint>
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
                  <td
                    style={{ ...td, fontWeight: 700, color }}
                    // The scored-day count used to sit in its own column and
                    // explain a blank R² on sight. With that column gone the
                    // explanation moves here, so "—" still says why.
                    title={m.R2 == null && m.n < 30 ? `R² is hidden below 30 scored days (${m.n} here)` : undefined}
                  >
                    {fmtNum(m.R2, 4)}
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
            <InfoTooltip text="Daily incident forecast, scored against real held-out data. Past = training history, Present = the model's held-out accuracy check (never trained on), Future = the published forecast for days that haven't happened yet." />
          </h3>
          <p style={{ color: "#64748b", fontSize: "0.82rem", margin: "4px 0 0 0" }}>
            Click any point to view that day&apos;s hourly breakdown
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {data.accidentSplit && (
            <div
              style={{ display: "inline-flex", gap: "2px", padding: "3px", background: "var(--bg-surface, #fff)", border: "1px solid #dce2ef", borderRadius: "999px" }}
              title="Total: the blended forecast with every candidate model. Split: a dedicated accident forecast, with breakdowns derived as blended total minus accidents."
            >
              {([false, true] as const).map((on) => (
                <button
                  key={String(on)}
                  onClick={() => setSplitView(on)}
                  aria-pressed={splitView === on}
                  style={{
                    padding: "4px 12px", borderRadius: "999px", border: "none", cursor: "pointer",
                    background: splitView === on ? "#4f46e5" : "transparent",
                    color: splitView === on ? "#fff" : "#4b5e7d",
                    fontWeight: 600, fontSize: "0.72rem", whiteSpace: "nowrap",
                  }}
                >
                  {on ? "Accident / Breakdown" : "Total"}
                </button>
              ))}
            </div>
          )}
          {/* Exposure overlay toggle — same pill the traffic forecast uses for
              its Weather overlay, so the two charts are operated the same way. */}
          <button
            onClick={() => setShowVolume(!showVolume)}
            title={
              hasVolumeFreeTwin
                ? showVolume
                  ? "Volume ON: forecasts fitted WITH traffic volume, overlay shown. Click to switch to the volume-free models."
                  : "Volume OFF: forecasts fitted WITHOUT traffic volume. Click to use the volume-aware models and show the overlay."
                : showVolume
                  ? "Hide the volume overlay (this training run stored no volume-free models, so the forecast lines do not change)"
                  : "Show the volume overlay (this training run stored no volume-free models, so the forecast lines do not change)"
            }
            style={{
              display: "inline-flex", alignItems: "center", gap: "6px", padding: "5px 14px",
              borderRadius: "999px", border: "1px solid #dce2ef",
              fontSize: "0.76rem", fontWeight: 600, cursor: "pointer", transition: "all 0.15s",
              background: showVolume ? "linear-gradient(135deg, #fbbf24, #f59e0b)" : "var(--bg-surface, #fff)",
              color: showVolume ? "var(--bg-surface, #fff)" : "var(--text-secondary, #4b5e7d)",
              boxShadow: showVolume ? "0 1px 6px rgba(245,158,11,0.35)" : "none",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M3 17h2l1-4h12l1 4h2M6 13l1.5-5h9L18 13M7.5 17.5h.01M16.5 17.5h.01"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              />
            </svg>
            Volume
          </button>
          {/* Rainfall toggle — same pill, independent of Volume so the user can
              show either, both, or neither. Like Volume, it switches the
              forecast itself when the pipeline stored a weather-free twin
              (has_weather_free_twin), not merely the rainfall overlay. */}
          <button
            onClick={() => setShowWeather(!showWeather)}
            title={
              hasWeatherFreeTwin
                ? showWeather
                  ? "Weather ON: forecasts fitted WITH rainfall, overlay shown. Click to switch to the weather-free models."
                  : "Weather OFF: forecasts fitted WITHOUT rainfall. Click to use the weather-aware models and show the overlay."
                : showWeather
                  ? "Hide the rainfall overlay (this training run stored no weather-free models, so the forecast lines do not change)"
                  : "Show the rainfall overlay (this training run stored no weather-free models, so the forecast lines do not change)"
            }
            style={{
              display: "inline-flex", alignItems: "center", gap: "6px", padding: "5px 14px",
              borderRadius: "999px", border: "1px solid #dce2ef",
              fontSize: "0.76rem", fontWeight: 600, cursor: "pointer", transition: "all 0.15s",
              background: showWeather ? `linear-gradient(135deg, ${RAIN_COLOR}, #0284c7)` : "var(--bg-surface, #fff)",
              color: showWeather ? "var(--bg-surface, #fff)" : "var(--text-secondary, #4b5e7d)",
              boxShadow: showWeather ? `0 1px 6px ${RAIN_COLOR}59` : "none",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M17 15.5a4 4 0 0 0-1.2-7.85 5.5 5.5 0 0 0-10.6 1.5A3.75 3.75 0 0 0 6.5 16.5"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              />
              <path d="M8 18.5l-1 2M12 18.5l-1 2M16 18.5l-1 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Weather
          </button>
        </div>
      </div>

      {/* The model picker has its own row instead of sharing the flex-wrapping cluster
          above. It used to sit in that cluster and vanish in the Accident / Breakdown
          view, which let the row reflow: at typical widths the cluster wrapped in Total
          view and not in split view, so the Total | Accident / Breakdown toggle jumped
          position exactly when clicked. With the picker out of the cluster, the toggle,
          Volume and Weather are identical in both views, and this row keeps its height in
          split view (saying why the picker doesn't apply) so nothing below shifts either. */}
      <div style={{ display: "flex", alignItems: "center", minHeight: 40 }}>
        {splitOn && split ? (
          <span style={{ fontSize: "0.76rem", color: "#64748b" }}>
            Model picker not used in this view — the accident forecast is{" "}
            {split.championModel ? (META[split.championModel as ModelKey]?.label ?? split.championModel) : "its own champion model"},
            fitted on accidents alone; breakdowns are derived as blended total minus accidents.
          </span>
        ) : (
          modelToolbar
        )}
      </div>

      {/* "Each point = X" badge — only relevant once aggregation is actually
          bucketing days together, same clarifying role as
          PredictiveVolumeChart's own badge: without it a Weekly/Monthly mean
          reads as a total to anyone skimming the axis. */}
      {isAggregated && (
        <div style={{
          display: "inline-flex", alignItems: "center", gap: "6px", alignSelf: "flex-start",
          padding: "5px 12px", borderRadius: "999px",
          background: "linear-gradient(135deg, #4f46e5, #4338ca)", color: "#fff",
          fontSize: "0.74rem", fontWeight: 600,
        }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Each point = {granularity === "Weekly" ? "7-day" : "~30-day"} mean, not a total
        </div>
      )}

      {/* Zone window & Granularity controls, laid out the same way
          PredictiveVolumeChart's toolbar is: one row, GRANULARITY first, then
          a tinted card per band. No Hourly pill here — every Daily point
          already opens the hourly breakdown on click, so there's no separate
          capability an Hourly granularity would add. */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        {/* GRANULARITY control pill */}
        <span style={{
          display: "inline-flex", alignItems: "center", gap: "8px", padding: "10px 14px",
          borderRadius: "10px", background: "#f8fafc", border: "1px solid #e2e8f0", fontSize: "0.76rem",
        }}>
          <b style={{ color: "#3b82f6", letterSpacing: "0.04em", fontSize: "0.75rem", textTransform: "uppercase" }}>
            GRANULARITY
          </b>
          <div style={{
            display: "inline-flex", alignItems: "center", padding: "2px",
            borderRadius: "999px", background: "#fff", border: "1px solid #dce2ef",
          }}>
            {(["Daily", "Weekly", "Monthly"] as const).map((g) => (
              <button
                key={g}
                onClick={() => setGranularity(g)}
                title={
                  g === "Daily"
                    ? "One point per day — the resolution the models actually forecast"
                    : `Averaged per ${g.replace("ly", "").toLowerCase()} — a viewing aid, not a separate forecast`
                }
                style={{
                  padding: "3px 10px", borderRadius: "999px", cursor: "pointer", border: "none",
                  background: "transparent",
                  color: granularity === g ? "#2563eb" : "#4b5e7d",
                  fontWeight: granularity === g ? 700 : 600, fontSize: "0.72rem",
                }}
              >
                {granularity === g ? `✓ ${g}` : g}
              </button>
            ))}
          </div>
        </span>

        {/* Past */}
        {showPast && (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: "8px", padding: "10px 14px",
            borderRadius: "10px", background: "rgba(37,99,235,0.07)", border: "1px solid rgba(37,99,235,0.18)", fontSize: "0.76rem",
          }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(37,99,235,0.5)" }} />
            <b style={{ color: "#0f172a" }}>Past</b>
            {modelInfo.trainedDays != null && (
              <span style={{ color: "#4b5e7d" }}>
                {fmtInt(modelInfo.trainedDays)}d trained{trainedPct != null ? ` · ${trainedPct.toFixed(2)}%` : ""} · showing last {fmtInt(effHoldoutStart)}d
              </span>
            )}
          </span>
        )}

        {/* Present */}
        {showPresent && (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: "8px", padding: "10px 14px",
            borderRadius: "10px", background: "rgba(249,115,22,0.08)", border: "1px solid rgba(249,115,22,0.22)", fontSize: "0.76rem",
          }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(249,115,22,0.55)" }} />
            <b style={{ color: "#0f172a" }}>Present</b>
            <span style={{ color: "#4b5e7d" }}>
              {presentScoredDays}d scored{scoredPct != null ? ` · ${scoredPct.toFixed(2)}%` : ""} · fixed by evaluation
            </span>
          </span>
        )}

        {/* Future. Hidden outright when the visible window has no Future band
            at all (a custom range ending before the horizon starts), since
            there would be nothing for the preset buttons to trim. */}
        {futureAvailable > 0 && (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: "8px", flexWrap: "wrap", padding: "10px 14px",
            borderRadius: "10px", background: "rgba(22,163,74,0.07)", border: "1px solid rgba(22,163,74,0.2)", fontSize: "0.76rem",
          }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(22,163,74,0.5)" }} />
            <b style={{ color: "#0f172a" }}>Future</b>
            {FUTURE_PRESETS.map((item) => {
              const unavailable = item.d > futureAvailable;
              const active = effectiveFutureDays === item.d;
              return (
                <button
                  key={item.label}
                  onClick={() => setFutureDays(item.d)}
                  disabled={unavailable}
                  title={
                    unavailable
                      ? `The forecast only runs ${futureAvailable} day${futureAvailable === 1 ? "" : "s"} ahead — retrain the incident pipeline with a longer horizon to use this`
                      : `Show ${item.d} days of forecast`
                  }
                  style={{
                    padding: "3px 10px",
                    borderRadius: "999px",
                    cursor: unavailable ? "not-allowed" : "pointer",
                    border: active ? "1px solid #16a34a" : "1px solid #dce2ef",
                    background: active ? "#16a34a" : "#fff",
                    color: active ? "#fff" : "#4b5e7d",
                    fontWeight: 600,
                    fontSize: "0.72rem",
                    opacity: unavailable ? 0.4 : 1,
                  }}
                >
                  {item.label}
                </button>
              );
            })}
            <span style={{ color: "#64748b" }}>
              · validated at {presentScoredDays}d
            </span>
          </span>
        )}
      </div>

      <div style={{ height: "450px", width: "100%", cursor: "pointer" }}>
        <DashboardChart option={option} height={450} onEvents={{ click: onChartClick as (p: never) => void }} />
      </div>

      {/* Without this key the rainfall bars are anonymous blue blocks — a reader
          has no way to tell a drizzle from a storm, or why they should care.
          Unlike the traffic chart, heavier rain here reads as a warning, not a
          calming signal: fewer cars are out, but reduced visibility, slicker
          roads and hydroplaning drive up collisions and breakdowns per mile
          driven, and the resulting jams run worse than a sunny-day incident's
          because road capacity itself has dropped. */}
      {showWeather && (
        <div style={{
          display: "flex", alignItems: "center", gap: "18px", flexWrap: "wrap",
          padding: "10px 14px", borderRadius: "10px", background: "#f8fafc",
          border: "1px solid #e2e8f0", fontSize: "0.75rem", color: "#4b5e7d",
        }}>
          <span style={{ fontWeight: 700, color: "#0f172a" }}>Daily rainfall</span>
          {RAIN_BANDS.map((b, i) => (
            <span key={b.label} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <span style={{
                width: 14, height: 10, borderRadius: 2, background: b.color,
                border: "1px solid rgba(2,132,199,0.5)", display: "inline-block",
              }} />
              {b.label}
              <span style={{ color: "#94a3b8" }}>
                {i === 0 ? `< ${b.max} mm`
                  : b.max === Infinity ? `≥ ${RAIN_BANDS[i - 1].max} mm`
                  : `${RAIN_BANDS[i - 1].max}–${b.max} mm`}
              </span>
            </span>
          ))}
          <span style={{ color: "#4b5e7d", borderLeft: "1px solid #e2e8f0", paddingLeft: "14px" }}>
            Taller bar = wetter day. Heavy rain typically coincides with higher incident rates and worse congestion, even as traffic volume drops.
          </span>
        </div>
      )}

      {splitOn && split && (
        <div style={{ padding: "12px 16px", borderRadius: "10px", background: "#fef2f2", border: "1px solid #fecaca", fontSize: "0.82rem", color: "#7f1d1d", lineHeight: 1.55 }}>
          <strong>Accident forecast</strong> — {split.championModel ? (META[split.championModel as ModelKey]?.label ?? split.championModel) : "champion"},
          fitted on accidents alone (last trained {fmtTrainedAt(split.trainedAt)}).
          {typeof split.metrics?.MAE === "number" && typeof split.metrics?.R2 === "number" && (
            <> Held-out MAE <strong>{fmtNum(split.metrics.MAE as number)}</strong> incidents/day, R² <strong>{fmtNum(split.metrics.R2 as number, 3)}</strong>.</>
          )}{" "}
          Accidents are only ~12% of daily incidents, so a fit tuned to the combined count is tuned to breakdowns: on the current
          holdout, scaling the blended forecast down to an accident estimate does worse than simply assuming the historical average,
          and this dedicated model beats it clearly. Its own skill is modest, though — without traffic volume it is not clearly better
          than the historical average (re-measured 2026-09-21). <strong>Breakdowns are derived, not separately modeled</strong> (blended
          forecast minus accident forecast): a dedicated breakdown model was tested and did no better than the blended fit. Metrics
          below describe the blended forecast.
        </div>
      )}
      {metricsTable}
      {weatherPanel}

      {/* Narrative is composed from the same modelMetrics rows that feed the
          table above, so the prose can never drift away from the numbers
          beside it. scoringCaption is reused verbatim from the table so the
          two can't disagree about which window they're describing. */}
      <IncidentNarrative
        selected={activeModels}
        metrics={shownMetrics}
        scoringCaption={scoringCaption}
        weather={weather ?? "all"}
        horizonDays={modelInfo.forecastHorizon}
      />
    </article>
  );
}
