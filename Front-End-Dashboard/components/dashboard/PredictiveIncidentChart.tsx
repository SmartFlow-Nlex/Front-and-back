"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useThemeTokens, zoneTints } from "./useThemeTokens";
import { useRouter } from "next/navigation";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import InfoTooltip from "./InfoTooltip";
import StateNote from "../stage/StateNote";
import { withAlpha } from "../../lib/chart-kit";
import { aggregateSeries } from "./aggregateSeries";
import IncidentNarrative, { MetricHint, metricHintFor, modelHintFor } from "./IncidentNarrative";
import EvidenceModal from "./EvidenceModal";
import {
  ACTUAL_COLOR,
  META,
  MODELS,
  RAIN_COLOR,
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

const zoneLabel = (text: string, show: boolean, color: string) => ({
  show,
  position: "insideTop" as const,
  color,
  fontSize: 11,
  fontWeight: 600 as const,
  formatter: text,
});

// Below this fraction of the chart's total width, a band's "Past"/"Present"/
// "Future" label collides with its neighbors rather than reading as a label —
// at 12mo the Present band can be ~90 days wide against ~450 total, which
// still renders legibly, but a custom range can squeeze it much narrower.
const MIN_ZONE_LABEL_FRACTION = 0.06;

// How far into the Future band to draw, matching the traffic chart's own
// Ahead control exactly (2wk/1mo/2mo/3mo) — `d` counts days from the first
// forecast row, and the control only ever trims what is already on the
// response — it cannot ask the API for a longer horizon, because the
// horizon is whatever the training run wrote into ml_predictive_incidents.
//
// train_incident_models.py now writes 90 forecast days (FUTURE_DAYS), the
// same depth traffic's own retrain_honest.py + extend_future_volume.py
// write to gold.ml_predictive_volume, so every preset below is backed by a
// real forecast the same way traffic's is. A preset wider than what's
// actually on the response still renders disabled rather than hidden,
// exactly as before — the ceiling is stated, not hidden, if a future
// retrain ever writes fewer days again.
const FUTURE_PRESETS = [
  { label: "2 wk", d: 14 },
  { label: "1 mo", d: 28 },
  { label: "2 mo", d: 60 },
  { label: "3 mo", d: 90 },
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

  /* ECharts resolves no CSS, so every colour inside `option` below has to be a
     real string. The surrounding DOM uses var() directly. Both come from the
     same tokens, which is what keeps the chart and its card in step when the
     theme flips. */
  const T = useThemeTokens();
  const ZONE = zoneTints(T.isDark);
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
      <article className="chart-card wide inc-card" style={{ height: "480px", justifyContent: "center" }}>
        <div className="inc-loading" role="status">Loading ML forecast from AWS…</div>
      </article>
    );
  }

  if (error || !data) {
    return (
      <article className="chart-card wide inc-card" style={{ minHeight: "300px", justifyContent: "center" }}>
        <StateNote kind="error" role="alert" title="Predictive analytics unavailable">
          {error ?? "Database not reachable"}
        </StateNote>
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
  type AggKey = ModelKey | "__volume" | "__volumeF" | "__accA" | "__accP" | "__bdA" | "__bdP";
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
          models: {
            ...modelsFlat,
            __volume: daily.map((d) => d.volume ?? null),
            __volumeF: daily.map((d) => (d.predictionType === "future" ? d.volumeForecast ?? null : null)),
            __accA: accA, __accP: accP, __bdA: bdA, __bdP: bdP,
          },
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
  const effAccA = agg ? agg.models.__accA : accA;
  const effAccP = agg ? agg.models.__accP : accP;
  const effBdA = agg ? agg.models.__bdA : bdA;
  const effBdP = agg ? agg.models.__bdP : bdP;
  const effHoldoutStart = agg ? agg.holdoutStart : validationStart;
  const effFutureStart = agg ? agg.futureStart : futureStart;
  const effLastIndex = effDates.length - 1;
  /* Volume is drawn wherever the volume-aware models read it (19 Oct 2026, testers IN-10). It used to stop at
     the end of Past, which left the Present predictions depending on an input the chart did not show and read
     as a modelling inconsistency. What the models actually take (train_incident_models.py): the recorded day's
     volume through Past and Present, since Present is held-out history; the traffic module's volume forecast
     across Future (FUTURE_VOLUME_SQL, sent as volumeForecast). So recorded volume runs solid to the forecast
     origin and the forecast input runs dashed after it, the same solid/dashed rule the incident lines follow. */
  const rawEffVolume = effModels.__volume ?? daily.map((d) => d.volume ?? null);
  const effVolume = rawEffVolume.map((v, i) => (i < effFutureStart ? v : null));
  const rawEffVolumeF = effModels.__volumeF ?? daily.map((d) => (d.predictionType === "future" ? d.volumeForecast ?? null : null));
  // Starts on the last recorded point so the dashed line continues the solid one instead of floating free.
  const effVolumeF = rawEffVolumeF.map((v, i) =>
    i >= effFutureStart ? v : i === effFutureStart - 1 && rawEffVolumeF[effFutureStart] != null ? effVolume[i] : null
  );
  const hasVolumeForecast = effVolumeF.some((v, i) => v != null && i >= effFutureStart);

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
      { xAxis: 0, itemStyle: { color: ZONE.past }, label: zoneLabel("Past", showZoneLabel("Past"), T.textMuted) },
      { xAxis: Math.max(effHoldoutStart - 1, 0) },
    ]);
  }
  if (showPresent) {
    markAreaData.push([
      { xAxis: effHoldoutStart, itemStyle: { color: ZONE.present }, label: zoneLabel("Present", showZoneLabel("Present"), T.textMuted) },
      { xAxis: Math.max(effFutureStart - 1, 0) },
    ]);
  }
  if (showFuture) {
    markAreaData.push([
      { xAxis: effFutureStart, itemStyle: { color: ZONE.future }, label: zoneLabel("Future", showZoneLabel("Future"), T.textMuted) },
      { xAxis: effLastIndex },
    ]);
  }
  // A divider only at a boundary where both neighboring bands are actually
  // drawn — a line at validationStart with no Past band to its left (or at
  // futureStart with nothing to its left) would be a stray mark, not a divider.
  type MarkLineItem = {
    xAxis: number;
    lineStyle?: { type?: "dashed" | "solid"; color?: string; width?: number; opacity?: number };
    label?: { show: boolean; position?: "insideEndTop" | "end"; formatter?: string; color?: string; fontSize?: number; fontWeight?: 600 | 700; backgroundColor?: string; padding?: [number, number]; borderRadius?: number };
  };
  const markLineData: MarkLineItem[] = [];
  if (showPast && showPresent) markLineData.push({ xAxis: effHoldoutStart });
  // The Present/Future boundary is where the published forecast begins: the
  // chart kit's "now" marker (a thin solid ink line), labelled FORECAST rather
  // than NOW because the forecast origin is the pipeline's last scored day,
  // not today's date.
  if (showFuture && (showPast || showPresent))
    markLineData.push({
      xAxis: effFutureStart,
      lineStyle: { type: "solid", color: T.textPrimary, width: 1, opacity: 0.85 },
      label: { show: true, position: "end", formatter: "FORECAST", color: T.textPrimary, fontSize: 11, fontWeight: 600 },
    });

  // Period dividers (W1/W3/… or M1/M3/…) at Weekly/Monthly granularity --
  // same feature and the same thinning/tagging rules as
  // PredictiveVolumeChart's own markLine (see its doc comment: unthinned,
  // a long Monthly range drew two dozen unlabelled lines that read as noise
  // rather than as boundaries). Indexed into effDates rather than matched by
  // date-label string, consistent with how this file's own zone dividers
  // above already address positions by index, not by label text.
  const weeklyPeriods: { weekNum: number; startIdx: number }[] = [];
  for (let i = 0, weekNum = 1; i < effDates.length; i += 7, weekNum++) {
    weeklyPeriods.push({ weekNum, startIdx: i });
  }
  const monthlyPeriods: { monthNum: number; startIdx: number }[] = [];
  {
    let currentMonth = "";
    let monthNum = 0;
    for (let i = 0; i < effDates.length; i++) {
      const monthName = (effDates[i] || "").split(" ")[0];
      if (monthName !== currentMonth) {
        monthNum++;
        monthlyPeriods.push({ monthNum, startIdx: i });
        currentMonth = monthName;
      }
    }
  }
  const periodDividers: MarkLineItem[] = (() => {
    const periods =
      granularity === "Weekly" ? weeklyPeriods.map((w) => ({ idx: w.startIdx, tag: `W${w.weekNum}` }))
      : granularity === "Monthly" ? monthlyPeriods.map((m) => ({ idx: m.startIdx, tag: `M${m.monthNum}` }))
      : [];
    if (periods.length === 0) return [];
    const stride = Math.max(1, Math.ceil(periods.length / 12));
    const tint = T.textMuted;
    const ink = T.textSecondary;
    const wash = T.tooltipBg;
    return periods
      .filter((_, i) => i % stride === 0)
      .map((p) => ({
        xAxis: p.idx,
        lineStyle: { type: "dashed" as const, color: tint, width: 1, opacity: 0.45 },
        label: {
          show: true,
          position: "insideEndTop" as const,
          formatter: p.tag,
          color: ink,
          fontSize: 11,
          fontWeight: 600 as const,
          backgroundColor: wash,
          padding: [1, 3] as [number, number],
          borderRadius: 2,
        },
      }));
  })();
  markLineData.push(...periodDividers);

  /* Rainfall shaded by intensity. PAGASA's classes are HOURLY rates (light up to 2.5 mm/h, moderate 2.5-7.5, heavy
     over 7.5), the same ones the sandbox uses, so they are applied to each bar's wettest hour. They were applied to
     daily totals before, which called a day of steady drizzle "heavy" (fix list A8, 2 Nov 2026). The bar's height is
     still the day's (or period's) total. */
  const RAIN_BANDS = [
    { max: 2.5, label: "Light", color: "rgba(56, 189, 248, 0.45)" },
    { max: 7.5, label: "Moderate", color: "rgba(14, 165, 233, 0.65)" },
    { max: Infinity, label: "Heavy", color: "rgba(30, 64, 175, 0.9)" },
  ];
  const rainBand = (mmPerHour: number) => RAIN_BANDS.find((b) => mmPerHour <= b.max) ?? RAIN_BANDS[RAIN_BANDS.length - 1];
  // Each bar's wettest hour: the day's own, or the wettest across the days of a week or month.
  const peakByDate = new Map(daily.map((d) => [d.date, d.rainfallPeakHourMm ?? null]));
  const effPeak: (number | null)[] = effIso.map((start, i) => {
    if (!isAggregated) return peakByDate.get(start) ?? null;
    const next = effIso[i + 1];
    let peak: number | null = null;
    for (const d of daily) {
      if (d.date < start || (next != null && d.date >= next)) continue;
      const p = d.rainfallPeakHourMm;
      if (p != null && (peak == null || p > peak)) peak = p;
    }
    return peak;
  });

  // Zone bands + dividers, attached to whichever series is the ground truth.
  const bandProps =
    markAreaData.length > 0
      ? {
          markArea: { silent: true, data: markAreaData },
          markLine: {
            silent: true,
            symbol: "none" as const,
            label: { show: false },
            lineStyle: { type: "dashed" as const, color: ZONE.divider },
            data: markLineData,
          },
        }
      : {};

  // Accidents run roughly an order of magnitude below Breakdowns (see
  // split.daily above), so overlaying both on one shared axis used to
  // compress Accidents into a flat line near zero. Drawn as two stacked
  // panels instead, each on its own scale -- the same small-multiples fix
  // the Descriptive tab's Incident Trend chart uses (app/dashboard/incident/
  // page.tsx) -- and the same two series colours, so amber=Accidents /
  // magenta=Breakdowns carries between tabs.
  // Lane Signal (3 Oct 2026): amber and green now mean road state, so the
  // three series take the validated incident triple, violet / magenta / teal
  // (dataviz validator, all pairs, light and navy-dark surfaces).
  const ACCIDENT_COLOR = T.isDark ? "#8c7ff0" : "#4a3aa7";
  const BREAKDOWN_COLOR = T.isDark ? "#d55181" : "#c2185b";
  // Forecast reused the actual line's own colour before (a lightened tint of
  // it, before that reused it outright), distinguished only by the dashed
  // stroke -- a muted, de-emphasized line for the one thing this whole chart
  // ("Incident Walk-Forward Forecast") exists to show. One consistent green
  // across both panels instead, reusing the exact "this is the forward-
  // looking one" green this file already spends elsewhere -- the Future
  // zone/preset buttons and the "Champion" model badge below (T.isDark ?
  // "#4ade80" : "var(--color-success)") -- so Forecast reads as its own headline category
  // rather than a paler shade of whichever panel it's in.
  const FORECAST_COLOR = T.isDark ? "#169bb8" : "#0b8db0";
  const SPLIT_PANELS = [
    { name: "Accidents", actual: effAccA, forecast: effAccP, color: ACCIDENT_COLOR, forecastColor: FORECAST_COLOR },
    { name: "Breakdowns", actual: effBdA, forecast: effBdP, color: BREAKDOWN_COLOR, forecastColor: FORECAST_COLOR },
  ];
  const splitPanelLine = (name: string, data: (number | null)[], color: string, gridIdx: number, forecast: boolean) => ({
    name,
    type: "line" as const,
    xAxisIndex: gridIdx,
    yAxisIndex: gridIdx,
    data,
    smooth: true,
    connectNulls: false,
    symbol: "circle" as const,
    symbolSize: 4,
    z: forecast ? 3 : 4,
    lineStyle: { width: 2, color, type: forecast ? ("dashed" as const) : ("solid" as const) },
    itemStyle: { color },
    emphasis: { scale: 2 },
  });
  // Named "Actual"/"Forecast" (not "Actual Accidents" etc.) across both
  // panels on purpose: the panel title already says which series is which,
  // so one legend toggle hides/shows the actual (or forecast) line in both
  // panels together instead of four entries repeating that split.
  const SPLIT_PANEL_SERIES = SPLIT_PANELS.flatMap((p, i) => [
    { ...splitPanelLine("Actual", p.actual, p.color, i, false), ...bandProps },
    splitPanelLine("Forecast", p.forecast, p.forecastColor, i, true),
  ]);

  // Legend swatches for the split view: three short bars read as a dashed line, one long
  // bar as a solid one. The path's own bounding box is scaled to itemWidth x itemHeight
  // (28 x 3), so these stay thin lines rather than blocks.
  const SOLID_SWATCH = "path://M0,0h28v3h-28z";
  const VOLUME_FORECAST_NAME = "Volume forecast (model input)";
  const DASHED_SWATCH = "path://M0,0h8v3h-8zM10,0h8v3h-8zM20,0h8v3h-8z";
  const legendData: (string | { name: string; icon: string })[] = [
    ...(splitOn
      ? [
          { name: "Actual", icon: SOLID_SWATCH },
          { name: "Forecast", icon: DASHED_SWATCH },
        ]
      : [
          { name: "Actual Count", icon: SOLID_SWATCH },
          ...activeModels.map((k) => ({ name: `${META[k].label} Prediction`, icon: DASHED_SWATCH })),
        ]),
    // The bar/overlay entries keep a block-like icon (a 3px line would vanish).
    ...(showWeather ? [{ name: "Rainfall", icon: "roundRect" }] : []),
    ...(showVolume ? [{ name: "Vehicle Volume", icon: SOLID_SWATCH }] : []),
    ...(showVolume && hasVolumeForecast ? [{ name: VOLUME_FORECAST_NAME, icon: DASHED_SWATCH }] : []),
  ];

  // Shared by both layouts below and kept as one function so their tooltips
  // can't drift apart on formatting.
  const tooltipFormatter = (params: unknown) => {
    const items = params as { name: string; marker: string; seriesName: string; value: number | null }[];
    let tip = `<b>${items[0].name}</b><br/>`;
    // The dashed volume line starts on the last recorded day; that day reads once, as recorded.
    const hasRecordedVolume = items.some((p) => p.seriesName === "Vehicle Volume" && p.value != null);
    items.forEach((p) => {
      if (p.value == null) return;
      if (p.seriesName === VOLUME_FORECAST_NAME && hasRecordedVolume) return;
      const val =
        p.seriesName === "Rainfall"
          ? `${fmtNum(Number(p.value), 1)} mm`
          : p.seriesName === "Vehicle Volume" || p.seriesName === VOLUME_FORECAST_NAME
            ? `${fmtInt(Number(p.value))} vehicles`
            : fmtInt(Number(p.value));
      tip += `${p.marker} ${p.seriesName}: <b>${val}</b><br/>`;
    });
    tip += `<span style="color:${T.textMuted};font-size:11px">${
      isAggregated ? "Switch to Daily to open a day" : "Click to view hourly breakdown"
    }</span>`;
    return tip;
  };

  // Rainfall/Volume overlays, parameterized on which grid+axis pair they
  // land on: the Total layout has one grid; the split layout has two, and
  // draws Volume on both panels but Rainfall on Accidents only (see the
  // comment on splitOption's yAxis below for why they're treated
  // differently rather than both simply following showWeather/showVolume).
  const rainfallSeries = (xAxisIndex: number, yAxisIndex: number) => ({
    name: "Rainfall",
    type: "bar" as const,
    xAxisIndex,
    yAxisIndex,
    data: effRainfall.map((mm, i) => (mm == null ? null : { value: mm, itemStyle: { color: rainBand(effPeak[i] ?? 0).color } })),
    barMaxWidth: 14,
    itemStyle: { borderRadius: [2, 2, 0, 0] },
    z: 1,
  });
  // Exposure overlay ink: a neutral from the theme, not amber, so the volume
  // line can never read as the "slow" road state. Legend and tooltip wording
  // ("Vehicle Volume", "{n} vehicles") are unchanged.
  const VOLUME_INK = T.textMuted;
  const volumeSeries = (xAxisIndex: number, yAxisIndex: number) => ({
    name: "Vehicle Volume",
    type: "line" as const,
    xAxisIndex,
    yAxisIndex,
    data: effVolume,
    smooth: true,
    symbol: "none" as const,
    connectNulls: false,
    z: 2,
    lineStyle: { width: 2, color: VOLUME_INK, type: "solid" as const },
    itemStyle: { color: VOLUME_INK },
    areaStyle: { color: VOLUME_INK, opacity: 0.08 },
  });
  // The Future days' volume input: dashed and unfilled, so a forecast input never passes for a count.
  const volumeForecastSeries = (xAxisIndex: number, yAxisIndex: number) => ({
    name: VOLUME_FORECAST_NAME,
    type: "line" as const,
    xAxisIndex,
    yAxisIndex,
    data: effVolumeF,
    smooth: true,
    symbol: "none" as const,
    connectNulls: false,
    z: 2,
    lineStyle: { width: 2, color: VOLUME_INK, type: "dashed" as const },
    itemStyle: { color: VOLUME_INK },
  });
  const volumeLayers = (xAxisIndex: number, yAxisIndex: number) =>
    hasVolumeForecast
      ? [volumeSeries(xAxisIndex, yAxisIndex), volumeForecastSeries(xAxisIndex, yAxisIndex)]
      : [volumeSeries(xAxisIndex, yAxisIndex)];

  // start/end pinned to 0/100 explicitly (not just omitted) on every build --
  // ECharts treats a dataZoom component's zoomed window as runtime state that
  // survives a setOption call even with notMerge:true, the same way legend
  // "selected" state does. Without an explicit value here, switching Range
  // from a wide window to a narrow one (or back) can leave the slider parked
  // on whatever fraction it last computed, silently showing a stale slice of
  // the new data instead of the full window the Range control just asked for.
  const dataZoomOf = (xAxisIndex: number | number[]) => [
    {
      type: "slider" as const,
      xAxisIndex,
      start: 0,
      end: 100,
      bottom: 30,
      height: 16,
      borderColor: "transparent",
      backgroundColor: withAlpha(T.textPrimary, 0.03),
      fillerColor: withAlpha(T.textPrimary, 0.1),
      dataBackground: { lineStyle: { color: withAlpha(T.textPrimary, 0.3) }, areaStyle: { color: withAlpha(T.textPrimary, 0.08) } },
      selectedDataBackground: { lineStyle: { color: withAlpha(T.textPrimary, 0.55) }, areaStyle: { color: withAlpha(T.textPrimary, 0.14) } },
      handleStyle: { color: T.textSecondary, borderColor: T.textSecondary },
      moveHandleStyle: { color: T.textSecondary },
      textStyle: { color: T.textMuted, fontSize: 11 },
      showDetail: false,
    },
    /* Wheel zoom only with Ctrl held (19 Oct 2026, testers IN-10). A plain wheel over the chart zoomed the axis
       instead of scrolling the page, so reading on past the card quietly narrowed the 3-month forecast to a
       couple of weeks. The slider above, drag-to-pan and Ctrl+wheel still zoom. */
    { type: "inside" as const, xAxisIndex, start: 0, end: 100, zoomOnMouseWheel: "ctrl" as const, moveOnMouseWheel: false },
  ];

  // Split layout: two stacked panels (Accidents on top, Breakdowns below),
  // each with its own y-axis -- see SPLIT_PANELS/SPLIT_PANEL_SERIES above.
  // Rainfall and Volume overlay each panel the same way they overlay the
  // Total view's single chart (own axis, same plot area) rather than getting
  // a separate panel of their own, so the split view reads as the Total
  // view's look applied twice.
  const SPLIT_CHART_HEIGHT = 450;
  const SPLIT_TOP = 30;
  const SPLIT_BOTTOM = 96;
  const SPLIT_GAP = 34;
  const splitPanelH = Math.max(70, (SPLIT_CHART_HEIGHT - SPLIT_TOP - SPLIT_BOTTOM - SPLIT_GAP) / SPLIT_PANELS.length);
  const splitTopOf = (i: number) => SPLIT_TOP + i * (splitPanelH + SPLIT_GAP);
  const splitLastPanel = SPLIT_PANELS.length - 1;

  const splitOption: EChartsOption = {
    // One title per panel, in the series' own colour, same pattern as the
    // Descriptive tab's Incident Trend chart.
    title: SPLIT_PANELS.map((p, i) => ({
      text: p.name,
      left: 60,
      top: splitTopOf(i) - 19,
      textStyle: { fontSize: 11, fontWeight: 600 as const, color: p.color },
    })),
    // Both panels now carry the same possible right-side axes (Rainfall,
    // Volume), so both reserve the same margin for them.
    grid: SPLIT_PANELS.map((_, i) => ({
      left: 60,
      right: showVolume ? 90 : showWeather ? 48 : 24,
      top: splitTopOf(i),
      height: splitPanelH,
    })),
    dataZoom: dataZoomOf([0, 1]),
    tooltip: {
      trigger: "axis",
      // Links the two panels' hover pointers so pointing at a month in
      // Accidents marks the same month in Breakdowns.
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      backgroundColor: T.tooltipBg,
      borderColor: T.border,
      textStyle: { color: T.tooltipText },
      formatter: tooltipFormatter,
    },
    legend: {
      data: legendData,
      bottom: 0,
      itemWidth: 28,
      itemHeight: 3,
      itemGap: 16,
      textStyle: { color: T.chartText },
    },
    xAxis: SPLIT_PANELS.map((_, i) => ({
      gridIndex: i,
      type: "category" as const,
      data: effDates,
      triggerEvent: true,
      axisLabel: i === splitLastPanel ? { color: T.chartText } : { show: false },
      axisLine: { show: i === splitLastPanel, lineStyle: { color: T.chartAxis } },
      axisTick: { show: false },
    })),
    yAxis: [
      {
        gridIndex: 0,
        type: "value",
        min: 0,
        splitNumber: 3,
        axisLabel: { color: T.chartText },
        splitLine: { lineStyle: { color: T.chartSplit } },
      },
      {
        gridIndex: 1,
        type: "value",
        min: 0,
        splitNumber: 3,
        axisLabel: { color: T.chartText },
        splitLine: { lineStyle: { color: T.chartSplit } },
      },
      // Rainfall on both panels now -- it's a plausible factor for
      // breakdowns too (water intrusion into electrical components, wet-road
      // stress interacting with an existing mechanical fault), even though
      // the correlation is less clean than accidents' (one NSW vehicle-
      // breakdown study found MORE rain correlated with FEWER breakdowns,
      // likely via reduced trip-taking) -- worth showing alongside the
      // series it might affect rather than only the one it more clearly does.
      {
        gridIndex: 0,
        type: "value",
        name: "Rainfall (mm)",
        nameLocation: "middle",
        nameGap: 34,
        min: 0,
        position: "right",
        show: showWeather,
        axisLabel: { color: RAIN_COLOR },
        splitLine: { show: false },
      },
      {
        gridIndex: 1,
        type: "value",
        name: "Rainfall (mm)",
        nameLocation: "middle",
        nameGap: 34,
        min: 0,
        position: "right",
        show: showWeather,
        axisLabel: { color: RAIN_COLOR },
        splitLine: { show: false },
      },
      {
        gridIndex: 0,
        type: "value",
        name: "Volume",
        nameLocation: "middle",
        nameGap: 42,
        position: "right",
        offset: 54,
        show: showVolume,
        scale: true,
        axisLabel: { color: VOLUME_INK, formatter: (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`) },
        axisLine: { show: true, lineStyle: { color: VOLUME_INK } },
        splitLine: { show: false },
      },
      {
        gridIndex: 1,
        type: "value",
        name: "Volume",
        nameLocation: "middle",
        nameGap: 42,
        position: "right",
        offset: 54,
        show: showVolume,
        scale: true,
        axisLabel: { color: VOLUME_INK, formatter: (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`) },
        axisLine: { show: true, lineStyle: { color: VOLUME_INK } },
        splitLine: { show: false },
      },
    ],
    series: [
      ...(showWeather ? [rainfallSeries(0, 2), rainfallSeries(1, 3)] : []),
      ...(showVolume ? [...volumeLayers(0, 4), ...volumeLayers(1, 5)] : []),
      ...SPLIT_PANEL_SERIES,
    ],
  };

  const totalOption: EChartsOption = {
    grid: { left: 60, right: 24, top: 28, bottom: 96 },
    // A scrub/zoom bar under the chart, same as PredictiveVolumeChart's —
    // useful specifically because Range can put hundreds of daily points on
    // screen at once; the slider lets a reader narrow in without switching
    // Range or Granularity. "inside" mirrors the slider for scroll/pinch.
    dataZoom: dataZoomOf(0),
    tooltip: {
      trigger: "axis",
      backgroundColor: T.tooltipBg,
      borderColor: T.border,
      textStyle: { color: T.tooltipText },
      formatter: tooltipFormatter,
    },
    legend: {
      data: legendData,
      bottom: 0,
      itemWidth: 28,
      itemHeight: 3,
      itemGap: 16,
      textStyle: { color: T.chartText },
    },
    xAxis: {
      type: "category",
      data: effDates,
      // Labels are click targets too — a wider hit area than the line symbols
      // (matches PredictiveVolumeChart's xAxis).
      triggerEvent: true,
      axisLabel: { color: T.chartText },
      axisLine: { lineStyle: { color: T.chartAxis } },
    },
    yAxis: [
      {
        type: "value",
        name: "Incident Count",
        nameLocation: "middle",
        nameGap: 40,
        min: 0,
        nameTextStyle: { color: T.chartText },
        axisLabel: { color: T.chartText },
        splitLine: { lineStyle: { color: T.chartSplit } },
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
          color: VOLUME_INK,
          formatter: (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`),
        },
        axisLine: { show: true, lineStyle: { color: VOLUME_INK } },
        splitLine: { show: false },
      },
    ],
    series: [
      // Weather overlay, same pattern as Volume below: an empty array when
      // off rather than a hidden series, so ECharts drops the bars and their
      // axis space entirely instead of just visually hiding them.
      ...(showWeather ? [rainfallSeries(0, 1)] : []),
      // Exposure. A line rather than a second bar set: rainfall already holds
      // the bars, and two bar series on one chart compete for the same visual
      // slot. Drawn under the incident lines (z:2) so it reads as context.
      // connectNulls stays FALSE deliberately — a gap in the warehouse should
      // look like a gap, not like a straight line drawn through missing days.
      ...(showVolume ? volumeLayers(0, 2) : []),
      {
        name: "Actual Count",
        type: "line" as const,
        data: effActual,
        smooth: true,
        symbol: "circle",
        symbolSize: 5,
        // Never bridged: a day with no log is a gap, not a straight line.
        connectNulls: false,
        z: 3,
        lineStyle: { width: 2, color: ACTUAL_COLOR },
        itemStyle: { color: ACTUAL_COLOR },
        emphasis: { scale: 2.2 },
        // The bands ride on the ground-truth series so they stay anchored
        // regardless of which models are toggled on. Each band is included
        // independently (not one hasZones on/off for all three) — a window
        // narrower than the holdout should still show Present+Future even
        // though Past has nothing to show. Coordinates are plain indices, not
        // dates[i] label strings — see the comment above showPast/etc. for why.
        ...bandProps,
      },
      ...activeModels.map((key) => ({
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
        connectNulls: false,
        symbol: "circle" as const,
        symbolSize: 5,
        // Model output is dashed (chart kit), recorded actuals solid, so a
        // prediction can never pass for history.
        lineStyle: { width: 2, color: META[key].color, type: "dashed" as const },
        itemStyle: { color: META[key].color },
        emphasis: { scale: 2.2 },
      })),
    ],
  };

  const option: EChartsOption = splitOn ? splitOption : totalOption;

  // Which horizon-accuracy bucket covers the currently-selected Ahead
  // preset, so the caption row can quote the real measured error for THIS
  // stretch instead of the day-1 figure in modelInfo.metrics (see
  // measure_incident_horizon_accuracy.py — one-step-ahead validation cannot
  // describe a 90-day recursive run). Picks the bucket whose range contains
  // effectiveFutureDays; falls back to the widest stored bucket if the
  // selection sits past everything measured so far.
  const futureHorizonBucket =
    data.horizonAccuracy.find((b) => effectiveFutureDays >= b.hLo && effectiveFutureDays <= b.hHi) ??
    [...data.horizonAccuracy].sort((a, b) => b.hHi - a.hHi)[0] ??
    null;

  const modelToolbar = (
    <div className="inc-models" role="group" aria-label="Models">
      <span className="inc-subhead">Models</span>
      {/* Each chip carries its model's series colour, so the row doubles as the
          legend for the prediction lines. */}
      {availableModels.map((m) => {
        const on = activeModels.includes(m.key);
        const locked = on && activeModels.length === 1;
        return (
          <button
            key={m.key}
            onClick={() => toggleModel(m.key)}
            aria-pressed={on}
            title={locked ? "At least one model must stay selected" : `${on ? "Hide" : "Show"} ${m.label}`}
            className={`inc-model-chip${on ? " is-on" : ""}${locked ? " is-locked" : ""}`}
            style={{ ["--chip" as string]: m.color }}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );

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

  const championTitle = "Selected on the full holdout window when the model was trained, not on the currently visible Range/Weather slice";

  const metricsTable = (
    <div className="inc-panel">
      <div className="inc-panel-head">
        <h4 className="inc-panel-title">Real-World ML Validation Metrics</h4>
      </div>
      <div className="inc-table-wrap">
        <table className="inc-table" style={{ minWidth: "760px" }}>
          <thead>
            <tr>
              <th>Model</th>
              <th><MetricHint hint={metricHintFor("RMSE")}>RMSE</MetricHint></th>
              <th><MetricHint hint={metricHintFor("MAE")}>MAE</MetricHint></th>
              <th><MetricHint hint={metricHintFor("WMAPE")}>WMAPE</MetricHint></th>
              <th><MetricHint hint={metricHintFor("MASE")}>MASE</MetricHint></th>
              <th><MetricHint hint={metricHintFor("R² Score")}>R² Score</MetricHint></th>
              <th><MetricHint hint={metricHintFor("Train R²")}>Train R²</MetricHint></th>
              <th><MetricHint hint={metricHintFor("Gap")}>Gap</MetricHint></th>
            </tr>
          </thead>
          <tbody>
            {shownMetrics.map((m) => {
              const meta = META[m.model as ModelKey];
              const color = meta?.color ?? "var(--text-muted)";
              return (
                <tr key={m.model}>
                  <td>
                    <span className="inc-model-cell">
                      <span className="inc-dot" style={{ background: color }} />
                      <MetricHint hint={modelHintFor(m.model as ModelKey)}>{meta?.label ?? m.model}</MetricHint>
                      {m.isChampion && (
                        <span className="inc-tag" title={championTitle}>
                          Champion
                        </span>
                      )}
                      {m.source === "holdout" && (
                        <span
                          className="inc-tag is-muted"
                          title="No scored days in the current Range/Weather selection — showing the pipeline's full-holdout numbers instead"
                        >
                          (full holdout)
                        </span>
                      )}
                    </span>
                  </td>
                  <td>{fmtNum(m.RMSE)}</td>
                  <td>{fmtNum(m.MAE)}</td>
                  <td>{m.WMAPE == null ? "—" : `${m.WMAPE.toFixed(2)}%`}</td>
                  <td>{fmtNum(m.MASE)}</td>
                  <td
                    style={{ fontWeight: 600, color }}
                    // The scored-day count used to sit in its own column and
                    // explain a blank R² on sight. With that column gone the
                    // explanation moves here, so "—" still says why.
                    title={m.R2 == null && m.n < 30 ? `R² is hidden below 30 scored days (${m.n} here)` : undefined}
                  >
                    {fmtNum(m.R2, 4)}
                  </td>
                  <td>{fmtNum(m.Train_R2, 4)}</td>
                  <td>{fmtNum(m.Gap, 4)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

  /* Weather split, the way the Traffic forecast card shows its weather evidence: inside the validation
     evidence, always there, rather than one half at a time behind a page filter (19 Oct 2026, user request).
     Every model is re-scored over only the dry, and only the wet, days of the same holdout window, so the
     reader can see whether the forecast holds up in the rain. */
  const ws = data.weatherSplit;
  const weatherPanel =
    ws == null ? null : (() => {
      const wetBy = new Map(ws.wet.models.map((m) => [m.model, m]));
      const rows = ws.dry.models.filter((m) => activeModels.includes(m.model as ModelKey));
      return (
        <div className="inc-panel">
          <div className="inc-panel-head">
            <h4 className="inc-panel-title">
              Dry vs wet days
              <InfoTooltip text="Each model's error on the same held-out window, split into dry days and wet days (expressway-average rainfall above 0.3 mm). MAE is the average miss in incidents per day; lower is better. Change is how much bigger (or smaller) the miss gets on wet days." />
            </h4>
            <span className="inc-panel-caption">
              {ws.dry.days} dry · {ws.wet.days} wet of {modelInfo.scoredDays ?? "—"} holdout days
            </span>
          </div>
          {ws.dry.days === 0 || ws.wet.days === 0 ? (
            <p className="inc-caption">No {ws.wet.days === 0 ? "wet" : "dry"} days in the scored window, so there is nothing to compare.</p>
          ) : (
            <div className="inc-table-wrap">
              <table className="inc-table" style={{ minWidth: "420px" }}>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>MAE, dry</th>
                    <th>MAE, wet</th>
                    <th>Change on wet days</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => {
                    const meta = META[m.model as ModelKey];
                    const color = meta?.color ?? "var(--text-muted)";
                    const wet = wetBy.get(m.model);
                    const change = wet && m.MAE > 0 ? ((wet.MAE - m.MAE) / m.MAE) * 100 : null;
                    return (
                      <tr key={m.model}>
                        <td>
                          <span className="inc-model-cell">
                            <span className="inc-dot" style={{ background: color }} />
                            {meta?.label ?? m.model}
                            {m.isChampion && (
                              <span className="inc-tag" title={championTitle}>
                                Champion
                              </span>
                            )}
                          </span>
                        </td>
                        <td>{fmtNum(m.MAE)}</td>
                        <td>{wet ? fmtNum(wet.MAE) : "—"}</td>
                        <td style={{ fontWeight: 600, color: change == null ? undefined : change > 0 ? "var(--color-danger)" : "var(--color-success)" }}>
                          {change == null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(1)}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      );
    })();

  // ---------- Model trust strip ----------
  // Compact pills built from the same response the table reads: the champion,
  // the window it was scored on, its error against the naive last-week
  // baseline (MASE) and its own error. Each one opens the full validation
  // evidence in a modal.
  const champ = modelMetrics.find((m) => m.isChampion) ?? null;
  const champKey = (champ?.model ?? data.summary.championModel ?? modelInfo.championModel) as ModelKey | null;
  const champLabel = champKey ? (META[champKey]?.label ?? champKey) : null;
  const champMase = champ?.MASE != null && isFinite(champ.MASE) ? champ.MASE : null;
  const futureFirst = futureAvailable > 0 ? fullDaily[fullFutureStart]?.date ?? null : null;
  const futureLast = futureAvailable > 0 ? fullDaily[fullDaily.length - 1]?.date ?? null : null;

  return (
    <article className="chart-card wide inc-card">
      {/* Title and the view toggles share one row and only stack when the card
          is too narrow to hold both. */}
      <div className="inc-card-head">
        <div className="inc-card-titles">
          <h3 className="inc-card-title">
            Incident Walk-Forward Forecast
            <InfoTooltip text="Daily incident forecast, scored against real held-out data. Past = training history, Present = the model's held-out accuracy check (never trained on), Future = the published forecast for days that haven't happened yet." />
          </h3>
          <p className="inc-card-sub">Click any point to view that day&apos;s hourly breakdown</p>
        </div>
      </div>

      {/* The answer: how far the published forecast reaches. */}
      {futureFirst && futureLast && (
        <div className="fc-answer">
          <span className="fc-answer-label">Published forecast</span>
          <span className="fc-answer-value">{fmtInt(futureAvailable)} days</span>
          <span className="fc-answer-context">
            <b>{fmtDateFull(futureFirst)}</b> to <b>{fmtDateFull(futureLast)}</b>
            {champLabel ? <> · champion <b>{champLabel}</b></> : null}
          </span>
        </div>
      )}

      {/* The model picker has its own row instead of sharing the flex-wrapping cluster
          above, and keeps its height in split view (saying why the picker doesn't
          apply) so nothing below shifts when the view changes. */}
      <div className="fc-row fc-models" style={{ minHeight: 36 }}>
        {splitOn && split ? (
          <span className="inc-model-note">
            Model picker off in this view: accidents use{" "}
            {split.championModel ? (META[split.championModel as ModelKey]?.label ?? split.championModel) : "their own champion model"}; breakdowns = total − accidents.
            <InfoTooltip
              text={`Model picker not used in this view — the accident forecast is ${split.championModel ? (META[split.championModel as ModelKey]?.label ?? split.championModel) : "its own champion model"}, fitted on accidents alone; breakdowns are derived as blended total minus accidents.`}
            />
          </span>
        ) : (
          modelToolbar
        )}
        {/* Overlay toggles at the end of the models row, as on the Traffic forecast. */}
        <span className="fc-group fc-push">
          {/* Exposure overlay toggle — same pill the traffic forecast uses for
              its Weather overlay, so the two charts are operated the same way. */}
          <button
            onClick={() => setShowVolume(!showVolume)}
            aria-pressed={showVolume}
            className={`inc-toggle${showVolume ? " is-on" : ""}`}
            title={
              hasVolumeFreeTwin
                ? showVolume
                  ? "Volume ON: forecasts fitted WITH traffic volume, overlay shown. Click to switch to the volume-free models."
                  : "Volume OFF: forecasts fitted WITHOUT traffic volume. Click to use the volume-aware models and show the overlay."
                : showVolume
                  ? "Hide the volume overlay (this training run stored no volume-free models, so the forecast lines do not change)"
                  : "Show the volume overlay (this training run stored no volume-free models, so the forecast lines do not change)"
            }
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M3 17h2l1-4h12l1 4h2M6 13l1.5-5h9L18 13M7.5 17.5h.01M16.5 17.5h.01"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              />
            </svg>
            Volume
          </button>
          {/* Says what the line is, now that it runs the whole window (see effVolume's doc comment). Shown only
              with the toggle on: there is nothing to explain about an overlay that isn't drawn. */}
          {showVolume && (
            <InfoTooltip text="The daily vehicle volume the volume-aware models read. Solid: recorded volume, through Past and Present (Present is held-out history, so the models saw the real day's traffic). Dashed: the traffic module's volume forecast, the input the models take for each Future day. Turn Volume off to see the same models fitted without it." />
          )}
          {/* Rainfall toggle — same pill, independent of Volume so the user can
              show either, both, or neither. Like Volume, it switches the
              forecast itself when the pipeline stored a weather-free twin
              (has_weather_free_twin), not merely the rainfall overlay. */}
          <button
            onClick={() => setShowWeather(!showWeather)}
            aria-pressed={showWeather}
            className={`inc-toggle${showWeather ? " is-on" : ""}`}
            title={
              hasWeatherFreeTwin
                ? showWeather
                  ? "Weather ON: forecasts fitted WITH rainfall, overlay shown. Click to switch to the weather-free models."
                  : "Weather OFF: forecasts fitted WITHOUT rainfall. Click to use the weather-aware models and show the overlay."
                : showWeather
                  ? "Hide the rainfall overlay (this training run stored no weather-free models, so the forecast lines do not change)"
                  : "Show the rainfall overlay (this training run stored no weather-free models, so the forecast lines do not change)"
            }
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M17 15.5a4 4 0 0 0-1.2-7.85 5.5 5.5 0 0 0-10.6 1.5A3.75 3.75 0 0 0 6.5 16.5"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              />
              <path d="M8 18.5l-1 2M12 18.5l-1 2M16 18.5l-1 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Weather
          </button>
        </span>
      </div>

      {/* Controls, then the key: the order every forecast card uses. Show (the
          Total / Accident-Breakdown split), View, then Ahead with the window
          the forecast was validated over. */}
      <div className="fc-row fc-controls">
        {data.accidentSplit && (
          <div className="fc-group">
            <span className="fc-label">Show</span>
            <div
              className="inc-seg"
              role="group"
              aria-label="Forecast view"
              title="Total: the blended forecast with every candidate model. Split: a dedicated accident forecast, with breakdowns derived as blended total minus accidents."
            >
              {([false, true] as const).map((on) => (
                <button key={String(on)} onClick={() => setSplitView(on)} aria-pressed={splitView === on} className={splitView === on ? "is-on" : ""}>
                  {on ? "Accident / Breakdown" : "Total"}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="fc-group">
          <span className="fc-label">View</span>
          <span className="inc-seg">
            {(["Daily", "Weekly", "Monthly"] as const).map((g) => (
              <button
                key={g}
                onClick={() => setGranularity(g)}
                aria-pressed={granularity === g}
                className={granularity === g ? "is-on" : ""}
                title={
                  g === "Daily"
                    ? "One point per day — the resolution the models actually forecast"
                    : `Averaged per ${g.replace("ly", "").toLowerCase()} — a viewing aid, not a separate forecast`
                }
              >
                {g}
              </button>
            ))}
          </span>
        </div>
        {/* Hidden outright when the visible window has no Future band at all (a
            custom range ending before the horizon starts), since there would be
            nothing for the preset buttons to trim. */}
        {futureAvailable > 0 && (
          <div className="fc-group">
            <span className="fc-label">Ahead</span>
            <span className="inc-seg">
              {FUTURE_PRESETS.map((item) => {
                const unavailable = item.d > futureAvailable;
                const active = effectiveFutureDays === item.d;
                return (
                  <button
                    key={item.label}
                    onClick={() => setFutureDays(item.d)}
                    disabled={unavailable}
                    aria-pressed={active}
                    className={active ? "is-on" : ""}
                    title={
                      unavailable
                        ? `The forecast only runs ${futureAvailable} day${futureAvailable === 1 ? "" : "s"} ahead — retrain the incident pipeline with a longer horizon to use this`
                        : `Show ${item.d} days of forecast`
                    }
                  >
                    {item.label}
                  </button>
                );
              })}
            </span>
            {futureHorizonBucket && (
              <span className={`fc-note${futureHorizonBucket.usable ? "" : " is-warn"}`} title={futureHorizonBucket.note ?? undefined}>
                typical error {futureHorizonBucket.wmape != null ? `${futureHorizonBucket.wmape.toFixed(0)}%` : "n/a"}
                {!futureHorizonBucket.usable ? " (beyond what this champion clears)" : ""}
              </span>
            )}
          </div>
        )}
      </div>

      {/* The key: what each band of the chart is, with the averaging notice at
          the end once points are means rather than days (without it a weekly
          mean reads as a total to anyone skimming the axis). */}
      <div className="fc-legend">
        {showPast && (
          <span className="fc-legend-item">
            <i className="inc-zone-swatch is-past" aria-hidden="true" />
            <b>Past</b>
            {modelInfo.trainedDays != null && (
              <span>
                {fmtInt(modelInfo.trainedDays)}d trained{trainedPct != null ? ` · ${trainedPct.toFixed(2)}%` : ""} · showing last {fmtInt(effHoldoutStart)}d
              </span>
            )}
          </span>
        )}
        {showPresent && (
          <span className="fc-legend-item">
            <i className="inc-zone-swatch is-present" aria-hidden="true" />
            <b>Present</b>
            <span>
              {presentScoredDays}d scored{scoredPct != null ? ` · ${scoredPct.toFixed(2)}%` : ""} · fixed by evaluation
            </span>
          </span>
        )}
        {futureAvailable > 0 && (
          <span className="fc-legend-item">
            <i className="inc-zone-swatch is-future" aria-hidden="true" />
            <b>Future</b>
            <span>
              {effectiveFutureDays}d forecast shown
              {daily.length > 0 && <> · to {fmtDateFull(daily[daily.length - 1].date)}</>}
            </span>
          </span>
        )}
        {isAggregated && (
          <span className="inc-agg-badge fc-push">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Each point = {granularity === "Weekly" ? "7-day" : "~30-day"} mean, not a total
          </span>
        )}
      </div>

      <div className="inc-chart-frame" style={{ height: "450px" }}>
        <DashboardChart option={option} height={450} onEvents={{ click: onChartClick as (p: never) => void }} />
      </div>

      {/* Without this key the rainfall bars are anonymous blue blocks. Heavier
          rain here reads as a warning, not a calming signal: fewer cars are out,
          but slicker roads drive collisions and breakdowns per mile up. */}
      {showWeather && (
        <div className="inc-rainkey">
          <b>Rainfall</b>
          {RAIN_BANDS.map((b, i) => (
            <span key={b.label}>
              <i style={{ background: b.color }} aria-hidden="true" />
              {b.label}
              <em>
                {i === 0 ? `≤ ${b.max} mm/h`
                  : b.max === Infinity ? `> ${RAIN_BANDS[i - 1].max} mm/h`
                  : `${RAIN_BANDS[i - 1].max}–${b.max} mm/h`}
              </em>
            </span>
          ))}
          <span className="inc-rainkey-aside">Colour = the wettest hour (PAGASA classes) · taller bar = more rain that day</span>
        </div>
      )}

      {/* Model trust strip: the headline figures on the card; the strip opens
          the full validation evidence (metrics table, rainfall evidence) in a
          modal, the same strip every forecast card carries. */}
      <EvidenceModal
        subtitle={scoringCaption}
        strip={<>
          {champLabel && (
            <span className="nct-trust-pill" title={championTitle}>
              <span className="nct-trust-k">Champion</span>
              {champLabel}
            </span>
          )}
          <span className="nct-trust-pill" title={scoringCaption}>
            <span className="nct-trust-k">Tested on</span>
            {data.scoringWindow
              ? <>{data.scoringWindow.n} days · {fmtDateFull(data.scoringWindow.start)} – {fmtDateFull(data.scoringWindow.end)}</>
              : <>full holdout · trained {fmtTrainedAt(modelInfo.trainedAt)}</>}
          </span>
          {champMase != null && (
            <span className="nct-trust-pill" title={metricHintFor("MASE", champ)}>
              <span className="nct-trust-k">Accuracy</span>
              MASE {champMase.toFixed(3)}
              <span className={champMase < 1 ? "nct-ok" : "nct-bad"}>
                {champMase < 1 ? " · beats last week" : " · does not beat last week"}
              </span>
            </span>
          )}
          {champ?.MAE != null && (
            <span className="nct-trust-pill" title={metricHintFor("MAE")}>
              <span className="nct-trust-k">Held-out error</span>
              MAE {fmtNum(champ.MAE)} incidents/day{champ.WMAPE != null ? ` · WMAPE ${champ.WMAPE.toFixed(2)}%` : ""}
            </span>
          )}
        </>}
      >
        <div className="inc-ev-body">
          {metricsTable}
          {weatherPanel}
        </div>
      </EvidenceModal>

      {splitOn && split && (
        <div className="inc-note">
          <dl className="inc-kv">
            <div>
              <dt>Accident forecast</dt>
              <dd>
                <b>{split.championModel ? (META[split.championModel as ModelKey]?.label ?? split.championModel) : "champion"}</b>{" "}
                <em>· accidents only · trained {fmtTrainedAt(split.trainedAt)}</em>
              </dd>
            </div>
            {typeof split.metrics?.MAE === "number" && typeof split.metrics?.R2 === "number" && (
              <div>
                <dt>Held-out</dt>
                <dd>
                  MAE <b>{fmtNum(split.metrics.MAE as number)}</b> incidents/day · R² <b>{fmtNum(split.metrics.R2 as number, 3)}</b>
                </dd>
              </div>
            )}
            <div>
              <dt>Skill</dt>
              <dd>
                Modest: not clearly better than the historical average without volume <em>(re-measured 2026-09-21)</em>
              </dd>
            </div>
            <div>
              <dt>Breakdowns</dt>
              <dd>Derived, not separately modeled: blended − accident forecast</dd>
            </div>
            <div>
              <dt>Metrics below</dt>
              <dd>Blended forecast</dd>
            </div>
          </dl>
          <details className="nc-details">
            <summary>Details</summary>
            <p style={{ margin: 0 }}>
              Accidents are only ~12% of daily incidents, so a fit tuned to the combined count is tuned to breakdowns: on the current
              holdout, scaling the blended forecast down to an accident estimate does worse than simply assuming the historical average,
              and this dedicated model beats it clearly. A dedicated breakdown model was tested and did no better than the blended fit.
            </p>
          </details>
        </div>
      )}

      <section id="incident-validation" className="inc-validation" tabIndex={-1} aria-label="Validation details">

        {/* Narrative is composed from the same modelMetrics rows that feed the
            metrics table (in the validation modal), so the prose can never
            drift away from the numbers. scoringCaption is reused verbatim from
            the table so the two can't disagree about which window they're
            describing. */}
        <IncidentNarrative
          selected={activeModels}
          metrics={shownMetrics}
          scoringCaption={scoringCaption}
          weather={weather ?? "all"}
          horizonDays={modelInfo.forecastHorizon}
        />
      </section>
    </article>
  );
}
