"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { cachedJson } from "../../../lib/cached-json";
import { attachCategoryClick } from "../../../lib/chart-click";
import { useChartTheme, applyChartTheme, liftDarkText, seriesRamp, seriesPair, seriesNominal } from "../../../lib/chart-theme";
import { useNlexExits } from "../../../lib/nlex-exits";
import { createExitLookup, postRangeForBin, SOUTH_OF_CORRIDOR_BIN } from "../../../lib/exit-lookup";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { AlertTriangle, ArrowDownWideNarrow, ArrowUpNarrowWide, CloudRain, HeartPulse, MapPin, Timer, Siren, X } from "lucide-react";
import DashboardChart from "../../../components/dashboard/DashboardChart";
import ChartSkeleton, { KpiSkeleton } from "../../../components/dashboard/ChartSkeleton";
import CustomSelect from "../../../components/dashboard/CustomSelect";
import PageHeader from "../../../components/dashboard/PageHeader";
import ModeTabLabel, { modeIndex } from "../../../components/dashboard/ModeTabLabel";
import { HourDayHeatmap, type HeatCell } from "../../../components/dashboard/IncidentHeatmaps";
import { areaFade } from "../../../lib/chart-kit";
import PredictiveIncidentChart from "../../../components/dashboard/PredictiveIncidentChart";
import PredictiveCorridorChart from "../../../components/dashboard/PredictiveCorridorChart";
import BreakdownResponseModel from "../../../components/dashboard/BreakdownResponseModel";
import PrescriptiveDeploymentPanel from "../../../components/dashboard/PrescriptiveDeploymentPanel";
import PatrolAlertWindowPanel from "../../../components/dashboard/PatrolAlertWindowPanel";
import ClearanceResponsePanel from "../../../components/dashboard/ClearanceResponsePanel";
import InfoTooltip from "../../../components/dashboard/InfoTooltip";
import EventBreakdownPanel from "../../../components/dashboard/EventBreakdownPanel";
import DateRangePicker from "../traffic/components/DateRangePicker";
import { rangeDays, grainBlockedReason, bestGrainFor, bucketLabelFor, timeAxisLabels } from "../../../lib/granularity";
import styles from "../traffic/traffic.module.css";
import CountUpValue from "../../../components/dashboard/CountUpValue";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";


const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];

const SOURCE_LABEL: Record<"accident" | "breakdown", string> = {
  accident: "Accidents",
  breakdown: "Breakdowns",
};

const RANGE_LABEL: Record<RangeMode, string> = { "3": "3 mo", "12": "12 mo", all: "All", custom: "Custom" };

// ---------- Data contract ----------
/** The three rankings the analytics endpoint returns, in the order shown. */
const CAUSE_MODES = ["Accident causes", "Breakdown causes", "Types"] as const;
type CauseMode = (typeof CAUSE_MODES)[number];

type Analytics = {
  range: { from: string; to: string };
  meta: { minDate: string; maxDate: string };
  kpis: {
    totalIncidents: number;
    prevTotalIncidents: number;
    injuries: number;
    fatalities: number;
    // Breakdown-only: accidents have no per-dispatch record to measure this
    // from, so they contribute nothing here rather than a fabricated value.
    // Replaced the old single avgResponseMin, which conflated accidents and
    // breakdowns despite having no accident-side data behind it at all.
    avgTimeToFirstResponder: { min: number | null; medianMin?: number | null; p90Min?: number | null; n: number; totalBreakdowns: number };
    /** Time to clear (MTTC), by type, with how many incidents carry the times (K9, K15). */
    mttc?: {
      overallMin: number | null;
      accident?: { meanMin: number | null; medianMin: number | null; p90Min: number | null };
      breakdown?: { meanMin: number | null; medianMin: number | null; p90Min: number | null };
      coverage: { pctValid: number | null };
    };
    rainyCrashes: number;
    weatherKnown: number;
  };
  dailyTrend: { d: string; accident: number; breakdown: number }[];
  hotspots: { km_bin: number; total: number; accident: number; breakdown: number; injuries: number; fatalities: number }[];
  // accident/breakdown split the cell's total (v); optional so an older cached response still draws.
  heatmap: { dow: number; hour: number; v: number; accident?: number; breakdown?: number }[];
  /* The API splits causes in two. Accidents are logged against a driver or
     road cause, breakdowns against a mechanical fault, and the service keeps
     them as separate rankings on purpose -- "a different vocabulary entirely",
     as it puts it -- so one list would rank flat tyres against tailgating.

     This page asked for `causes`, which the API stopped sending, and read
     `.length` off undefined on first render. */
  accidentCauses: { label: string; total: number; injuries: number; fatalities: number }[];
  breakdownCauses: { label: string; total: number; injuries: number; fatalities: number }[];
  types: { label: string; total: number; injuries: number; fatalities: number }[];
  weather: {
    wetHours: number;
    dryHours: number;
    incidents: { wet: Record<"accident" | "breakdown", number>; dry: Record<"accident" | "breakdown", number> };
    /** The same comparison per day of week (0 = Sunday) x hour, for the card's Day and Hour filters. */
    cells?: WeatherCell[];
    jam: { wet: { speed: number; jam_level: number } | null; dry: { speed: number; jam_level: number } | null };
    /** Wet/dry hours and incidents by weekday x hour (dow 0 = Sunday), for the Dry vs Wet slice. */
    byHourDow?: {
      exposure: { dow: number; hour: number; wet: boolean; hours: number }[];
      incidents: { dow: number; hour: number; wet: boolean; src: "accident" | "breakdown"; n: number }[];
    };
  };
};

type WeatherCell = {
  dow: number; hour: number; wetHours: number; dryHours: number;
  wetAccident: number; wetBreakdown: number; dryAccident: number; dryBreakdown: number;
};
/** Dry vs Wet card's own filters: a day (0 = Sunday, as the API numbers them) or a day group, and an hour. */
type WxDay = "all" | "weekday" | "weekend" | `${number}`;
type WxHour = "all" | `${number}`;

type Granularity = "daily" | "weekly" | "monthly";
type RangeMode = "3" | "12" | "all" | "custom";
type WeatherFilter = "all" | "dry" | "wet";
/** Matches the source enum the incident endpoint validates against. */
type SourceFilter = "all" | "accident" | "breakdown";
type Detail = { title: string; subtitle?: string; rows: [string, string][]; note?: string };

// ---------- Formatting ----------
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmt1 = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtHour = (h: number) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);
const fmtPct = (p: number) => `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
/* A hotspot bin is already an official km post (the backend bins on them; lib/exit-lookup.ts), so it is
   labelled with its posts: Km 12–14, Km 15–19 … and "South of Km 12" for records before Balintawak, where
   NLEX has no posts. Never a Km 0. */
const kmLabel = (bin: number) => (bin === SOUTH_OF_CORRIDOR_BIN ? `South of Km ${postRangeForBin(bin).replace("below ", "")}` : `Km ${postRangeForBin(bin)}`);
/** Kept for its callers: the label already is the roadside km post, so there is nothing to put beside it. */
const kmLabelBoth = kmLabel;
const weekdayOf = (dateStr: string) =>
  new Date(`${dateStr}T00:00:00`).toLocaleDateString("en-US", { weekday: "long" });

/* The hour x day grid and the type breakdown under it. Hover state lives here, not on the page: a hover that
   re-rendered the whole tab handed every chart on it fresh click handlers, and echarts-for-react rebuilds a
   chart whose handlers change. Here only the breakdown re-renders; the grid itself is memoised. */
function HeatmapWithBreakdown({
  heatmap,
  range,
  renderMix,
}: {
  heatmap: Analytics["heatmap"];
  range: Analytics["range"];
  renderMix: (focus: { cell: HeatCell; pinned: boolean } | null, clearPin: () => void) => ReactNode;
}) {
  const [hover, setHover] = useState<HeatCell | null>(null);
  const [pin, setPin] = useState<HeatCell | null>(null);
  // Clicking the kept cell again lets it go.
  const pick = useCallback((c: HeatCell) => setPin((p) => (p && p.dow === c.dow && p.hour === c.hour ? null : c)), []);
  const clearPin = useCallback(() => setPin(null), []);
  // A new Range or filter is a new grid: a kept cell from the old one would describe numbers no longer shown.
  useEffect(() => setPin(null), [heatmap]);
  const focus = hover ? { cell: hover, pinned: !!pin && pin.dow === hover.dow && pin.hour === hover.hour } : pin ? { cell: pin, pinned: true } : null;
  return (
    <>
      <HourDayHeatmap heatmap={heatmap} range={range} onHoverCell={setHover} onPickCell={pick} />
      {renderMix(focus, clearPin)}
    </>
  );
}

function weekStart(dateStr: string): string {
  const dt = new Date(`${dateStr}T00:00:00`);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

export default function IncidentPage() {
  // Chart furniture follows the active theme; series hues stay fixed.
  const chartTheme = useChartTheme();
  // Brighter axis/legend text for dark mode on this tab (feature test IN-9).
  const frameTheme = liftDarkText(chartTheme);

  // km -> nearest exit, built once and used everywhere a km value is shown.
  const { exits } = useNlexExits();
  const exitAt = useMemo(() => createExitLookup(exits), [exits]);
  /** "Km 0–4 · Balintawak": the segment label with its nearest exit. */
  const segLabel = (bin: number) => {
    const n = exitAt.nameForBin(bin);
    return n ? `${kmLabelBoth(bin)} · ${n}` : kmLabelBoth(bin);
  };

  /* This tab's colour family. The ramp is ordinal — lightest to darkest — and
     both modes are selected steps validated against their own surface, not an
     automatic flip. A pair of nominal series takes the outer two steps, which is
     where the separation margin lives. See lib/chart-theme. */
  const RAMP = seriesRamp("incident", chartTheme);
  // The three incident types have no order between them, so they take hues
  // rather than three steps of one. See seriesNominal.
  const TYPE_HUES = seriesNominal("incident", chartTheme);
  const [PAIR_A, PAIR_B] = seriesPair("incident", chartTheme);
  const SEQ = [chartTheme.seqLightest, ...RAMP];
  const [activeTab, setActiveTab] = useState<"Descriptive" | "Predictive" | "Prescriptive">("Descriptive");

  // Global filters
  const [rangeMode, setRangeMode] = useState<RangeMode>("12");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [weather, setWeather] = useState<WeatherFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");

  // Chart-local interactivity
  const [hotspotSort, setHotspotSort] = useState<"desc" | "asc">("desc");
  const [causeSort, setCauseSort] = useState<"desc" | "asc">("desc");
  const [grain, setGrain] = useState<Granularity>("monthly");
  const [causeMode, setCauseMode] = useState<CauseMode>("Accident causes");
  const [allHotspotsOpen, setAllHotspotsOpen] = useState(false);
  // Dry vs Wet card: narrow the comparison to a day and/or hour (19 Oct 2026, testers IN-7).
  const [wxDay, setWxDay] = useState<WxDay>("all");
  const [wxHour, setWxHour] = useState<WxHour>("all");
  const [detail, setDetail] = useState<Detail | null>(null);

  // Earliest observed / latest forecast date reported by the predictive
  // endpoint. Lifted from PredictiveIncidentChart's first response so the
  // Range control's Custom date picker can be bounded by it.
  const [predictiveDataBounds, setPredictiveDataBounds] = useState<{ minDate: string; maxDate: string } | null>(null);

  // Whether the predictive endpoint's current Range has any scored rows for
  // Weather to filter.
  const [weatherApplicable, setWeatherApplicable] = useState(true);

  // Restore the view the hourly drill-down was opened from
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("tab");
    if (t && ["Descriptive", "Predictive", "Prescriptive"].includes(t)) setActiveTab(t as typeof activeTab);
    const w = q.get("weather");
    if (w === "all" || w === "dry" || w === "wet") setWeather(w);
    const f = q.get("from");
    const t2 = q.get("to");
    if (f && t2) { setCustomFrom(f); setCustomTo(t2); setRangeMode("custom"); return; }
    const m = q.get("months");
    if (m === "3" || m === "12" || m === "all") setRangeMode(m);
  }, []);

  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped by the KPI strip's Try again: refetches the same query.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (rangeMode === "custom" && (!customFrom || !customTo)) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (rangeMode === "custom") {
      qs.set("from", customFrom);
      qs.set("to", customTo);
    } else {
      qs.set("months", rangeMode);
    }
    if (weather !== "all") qs.set("weather", weather);
    if (source !== "all") qs.set("source", source);
    // Memoised per query string: switching tabs or returning to this page
    // renders from memory instead of refetching. Five minutes, refreshed
    // quietly in the background once stale. See lib/cached-json.
    /* A deadline on the request (19 Oct 2026, testers IN-2). With the backend's database pool stuck, the
       request never settled and every KPI tile sat on its skeleton, or on "No data" and a dash after a
       failure, with nothing to say why. Now it fails after a deadline (see below; an uncached "All" measures about 7 s) and
       the strip says so, with Try again. The deadline is this effect's own, raced against the request:
       cachedJson shares one fetch per URL, so an abort signal passed in would abort it for every caller
       waiting on it (the deployment panel reads the same URL), and a re-run that joined the fetch in flight
       would have no deadline at all once the first run's timer was cleared. The shared fetch is never aborted. */
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      // 125 s: just past the backend's own 120 s query limit. At 45 s a cold Weather = Dry or Wet (59-61 s on
      // 2 Nov 2026) gave up before the server could answer.
      deadline = setTimeout(() => reject(new Error("The incident analytics request timed out")), 125_000);
    });
    Promise.race([cachedJson<{ success: boolean; message?: string; data: Analytics }>(`${BACKEND}/api/incident/analytics?${qs}`, 5 * 60_000), timeout])
      .then((json) => {
        if (cancelled) return;
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setData(json.data);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        clearTimeout(deadline);
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(deadline);
    };
  }, [rangeMode, customFrom, customTo, weather, source, reloadKey]);

  /* How long a window is on screen, and what that allows.

     Measured from the range the API resolved rather than the raw custom inputs,
     so the 3-month and 12-month presets are governed by the same rule. */
  const spanDays = rangeDays(data?.range.from, data?.range.to);

  // A grain that stops being possible is demoted rather than left selected: the
  // control disables it, so without this the chart would sit on an impossible
  // bucket with no way to change it.
  useEffect(() => {
    if (spanDays == null) return;
    if (grainBlockedReason(grain, spanDays)) {
      setGrain(bestGrainFor(spanDays, false) as typeof grain);
    }
  }, [spanDays, grain]);

  // ---------- Derived ----------
  const derived = useMemo(() => {
    if (!data) return null;
    const { kpis, hotspots, weather: wx } = data;
    // null, not 0: with no prior-period incidents there is nothing to compare
    // against, and "+0.0%" would claim the count was flat.
    const deltaPct =
      kpis.prevTotalIncidents > 0
        ? ((kpis.totalIncidents - kpis.prevTotalIncidents) / kpis.prevTotalIncidents) * 100
        : null;
    const hotspotTotal = hotspots.reduce((s, h) => s + h.total, 0);
    const topHotspot = hotspots[0] ?? null;

    // Crash rate per day of each weather, wet vs dry (crashes = road + moto).
    // Exposure-normalized: wet hours are far rarer than dry, so raw counts can't be compared.
    const wetCrashes = wx.incidents.wet.accident;
    const dryCrashes = wx.incidents.dry.accident;
    const wetRate = wx.wetHours > 0 ? (wetCrashes / wx.wetHours) * 24 : 0;
    const dryRate = wx.dryHours > 0 ? (dryCrashes / wx.dryHours) * 24 : 0;

    /* The wet-vs-dry multiplier needs both sides. The API used to apply the
       Weather filter to the incident counts but not to the hours of exposure,
       so under Wet or Dry one side was always zero, and this tile was blanked
       with "set Weather to All". Since 17 Oct the API keeps this one block
       whole whatever Weather says (it IS the wet-vs-dry comparison), so the
       tile now answers under every Weather setting (19 Oct 2026, testers IN-2).
       Accidents-only still: choosing Breakdowns removes every crash. When it is
       genuinely empty, say which reason it is. */
    let rainMultiplier: number | null = null;
    let rainEmptyReason: string | null = null;
    if (source === "breakdown") rainEmptyReason = "Counts crashes only: Incident type is set to Breakdowns";
    else if (wx.wetHours === 0) rainEmptyReason = "No wet hours in this Range";
    else if (wx.dryHours === 0) rainEmptyReason = "No dry hours in this Range";
    else if (dryRate === 0) rainEmptyReason = "No crashes in dry hours to compare against";
    else rainMultiplier = wetRate / dryRate;

    /* Same hour of day on both sides (2 Nov 2026). Rain falls mostly in the afternoon, when traffic and crashes peak
       whatever the weather, so the plain ratio partly measured the time of day: 1.19x over 12 months, 1.02x with the
       hour held fixed. Each wet hour is now set against the dry crash rate of that same hour of the day: observed wet
       crashes over the crashes those wet hours would have had at their own hours' dry rate. Falls back to the plain
       ratio when the API sends no per-hour cells. */
    let rainSameHour = false;
    /* 95% interval (fix list A13, 2 Nov 2026), approximate, on the log scale. Plain ratio: exp(ln RR +/- 1.96
       sqrt(1/n_wet + 1/n_dry)). Same-hour ratio: the expected count is built from the dry crashes, so its own Poisson
       variance, sum of (wet hours / dry hours)^2 x dry crashes per hour, is added to 1/observed. */
    let rainLo: number | null = null;
    let rainHi: number | null = null;
    const ci = (r: number, varLog: number) => {
      const half = 1.96 * Math.sqrt(varLog);
      rainLo = Math.exp(Math.log(r) - half);
      rainHi = Math.exp(Math.log(r) + half);
    };
    if (rainMultiplier != null && wetCrashes > 0 && dryCrashes > 0) ci(rainMultiplier, 1 / wetCrashes + 1 / dryCrashes);
    if (rainMultiplier != null && Array.isArray(wx.cells) && wx.cells.length > 0) {
      const byHour = new Map<number, { wetH: number; dryH: number; wetA: number; dryA: number }>();
      for (const c of wx.cells) {
        const b = byHour.get(c.hour) ?? { wetH: 0, dryH: 0, wetA: 0, dryA: 0 };
        b.wetH += c.wetHours; b.dryH += c.dryHours; b.wetA += c.wetAccident; b.dryA += c.dryAccident;
        byHour.set(c.hour, b);
      }
      let observed = 0;
      let expected = 0;
      let varExpected = 0;
      for (const b of byHour.values()) {
        if (b.wetH === 0 || b.dryH === 0) continue;
        observed += b.wetA;
        expected += b.wetH * (b.dryA / b.dryH);
        varExpected += (b.wetH / b.dryH) ** 2 * b.dryA;
      }
      if (expected > 0) {
        rainMultiplier = observed / expected;
        rainSameHour = true;
        rainLo = rainHi = null;
        if (observed > 0) ci(rainMultiplier, 1 / observed + varExpected / expected ** 2);
      }
    }

    return { deltaPct, topHotspot, hotspotTotal, wetRate, dryRate, rainMultiplier, rainEmptyReason, rainSameHour, rainLo: rainLo as number | null, rainHi: rainHi as number | null };
  }, [data, source]);

    // ---------- Trend ----------
  type TrendRow = { label: string; accident: number; breakdown: number; total: number };
  const trendRows = useMemo<TrendRow[]>(() => {
    if (!data) return [];
    const keyOf = grain === "daily" ? (d: string) => d : grain === "weekly" ? weekStart : (d: string) => d.slice(0, 7);
    const acc = new Map<string, { accident: number; breakdown: number }>();
    for (const r of data.dailyTrend) {
      const k = keyOf(r.d);
      const cur = acc.get(k) ?? { accident: 0, breakdown: 0 };
      acc.set(k, { accident: cur.accident + r.accident, breakdown: cur.breakdown + r.breakdown });
    }
    const rows = [...acc.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([label, v]) => ({ label, ...v, total: v.accident + v.breakdown }));
    if (grain === "daily" || rows.length < 3) return rows;

    /* A bucket at either end is only drawn if the data covers the whole of it.
       The first and last buckets are the ones a range boundary can cut in half,
       and a half-month summed against whole months plots as a collapse. Which
       days a bucket spans is derived from the calendar, not from how many rows
       happen to be present, because a day with no incident has no row. */
    const dates = data.dailyTrend.map((r) => r.d).sort();
    const firstDay = dates[0];
    const lastDay = dates[dates.length - 1];
    const spanOf = (key: string): [string, string] => {
      if (grain === "weekly") {
        const start = new Date(`${key}T00:00`);
        const end = new Date(start);
        end.setDate(end.getDate() + 6);
        return [key, end.toISOString().slice(0, 10)];
      }
      const [y, m] = key.split("-").map(Number);
      return [`${key}-01`, new Date(y, m, 0).toISOString().slice(0, 10)];
    };
    const whole = (key: string) => {
      const [s0, e0] = spanOf(key);
      return s0 >= firstDay && e0 <= lastDay;
    };
    let lo = 0;
    let hi = rows.length - 1;
    if (!whole(rows[lo].label)) lo += 1;
    if (hi > lo && !whole(rows[hi].label)) hi -= 1;
    return rows.slice(lo, hi + 1);
  }, [data, grain]);

  const trendOption = useMemo<EChartsOption | null>(() => {
    if (trendRows.length === 0) return null;
    const labels = trendRows.map((r) => r.label);
    const timeAxis = timeAxisLabels(labels, grain);

    /* Small multiples, one panel per type, rather than three lines on one
       scale.

       Stacked vehicles run around 900 a month, road crashes around 150 and
       motorcycle crashes around 10. On a single linear axis the top series
       fills the plot and the other two lie flat on the floor - two of the
       three series were drawn but could not be read, and the chart had 1264
       by 384 pixels in which to fail at it. Giving each its own y-axis makes
       all three legible, and the axis labels still carry the magnitude
       difference that the shared scale used to show.

       Same three series, same values, same buckets. Only the arrangement. */
    const PANELS = [
      { name: "Accidents", key: "accident" as const, color: TYPE_HUES[0] },
      { name: "Breakdowns", key: "breakdown" as const, color: TYPE_HUES[2] },
    ];

    // Laid out in the chart's own pixels so the three panels divide the height
    // evenly whatever the card is given.
    const TOP = 22, BOTTOM = 34, GAP = 30;
    const panelH = Math.max(46, (384 - TOP - BOTTOM - GAP * (PANELS.length - 1)) / PANELS.length);
    const topOf = (i: number) => TOP + i * (panelH + GAP);
    const last = PANELS.length - 1;

    return {
      /* One title per panel, in the series' own colour: it names the panel
         where the reader is already looking, which a legend at the foot of a
         stack of three cannot do. */
      title: PANELS.map((p, i) => ({
        text: p.name,
        left: 56,
        top: topOf(i) - 17,
        textStyle: { fontSize: 11, fontWeight: 600 as const, color: p.color },
      })),
      grid: PANELS.map((_, i) => ({ left: 56, right: 18, top: topOf(i), height: panelH })),
      xAxis: PANELS.map((_, i) => ({
        gridIndex: i,
        type: "category" as const,
        data: labels,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: chartTheme.axis } },
        // Only the bottom panel carries dates; three copies of the same axis
        // is noise, and it costs the panels the height instead.
        axisLabel:
          i === last
            ? { formatter: timeAxis.formatter, interval: timeAxis.interval, hideOverlap: true }
            : { show: false },
      })),
      yAxis: PANELS.map((_, i) => ({
        gridIndex: i,
        type: "value" as const,
        splitNumber: 2,
        axisLabel: { formatter: (v: number) => fmtInt(v) },
        splitLine: { lineStyle: { color: chartTheme.split } },
      })),
      tooltip: {
        trigger: "axis" as const,
        axisPointer: {
          // Linked, so hovering any panel marks the same month in all three.
          link: [{ xAxisIndex: "all" }],
          label: { formatter: (o) => bucketLabelFor(grain)(String((o as { value: unknown }).value)) },
        },
        valueFormatter: (v) => (v == null ? "—" : fmtInt(Number(v))),
      },
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      series: PANELS.map((p, i) => ({
        name: p.name,
        type: "line" as const,
        xAxisIndex: i,
        yAxisIndex: i,
        data: trendRows.map((r) => r[p.key]),
        symbol: "none" as const,
        smooth: true,
        itemStyle: { color: p.color },
        lineStyle: { width: 2, color: p.color },
        // A soft fill under each line: with three separate panels the shape is
        // the message, and the fill makes it legible at 90px tall. Night
        // Corridor kit: fades from 28% at the line to nothing at the base.
        areaStyle: areaFade(p.color) as never,
      })),
    };
  }, [trendRows, grain, chartTheme, TYPE_HUES]);

  const hotspotChart = useMemo<{ option: EChartsOption; rows: Analytics["hotspots"] } | null>(() => {
    if (!data || data.hotspots.length === 0) return null;
    const top = data.hotspots.slice(0, 10);
    const display = hotspotSort === "desc" ? [...top].reverse() : [...top];
    const maxV = top[0]?.total ?? 1;
    return {
      rows: display,
      option: {
        grid: { left: 168, right: 46, top: 8, bottom: 18 },
        xAxis: { type: "value", splitNumber: 3, axisLabel: { formatter: (v: number) => fmtInt(v) } },
        yAxis: {
          type: "category",
          data: display.map((r) => kmLabel(r.km_bin)),
          // Two lines per segment: the km range, then the exit it sits nearest.
          axisLabel: {
            interval: 0,
            lineHeight: 15,
            formatter: (_v: string, i: number) => {
              const r = display[i];
              const n = exitAt.nameForBin(r.km_bin) ?? "";
              return `{k|${kmLabelBoth(r.km_bin)}}\n{n|${n.length > 22 ? `${n.slice(0, 21)}…` : n}}`;
            },
            rich: { k: { fontSize: 12, fontWeight: 600, color: chartTheme.ink, lineHeight: 15 }, n: { fontSize: 11, lineHeight: 15 } },
          },
          axisTick: { show: false },
        },
        tooltip: {
          axisPointer: { type: "shadow" },
          formatter: (p) => {
            const i = (p as { dataIndex: number }).dataIndex;
            const r = display[i];
            return `<b>${segLabel(r.km_bin)}</b><br/>${fmtInt(r.total)} incidents · ${fmtInt(r.injuries)} injured · ${fmtInt(r.fatalities)} fatalities`;
          },
        },
        /* No legend: one series, and the axis already says these are incidents
           by segment. A single chip naming the only thing on the chart is
           furniture, and the bars are shaded on a ramp, so its lone swatch
           matches no bar in particular. */
        series: [
          {
            name: "Incidents by segment",
            type: "bar",
            data: display.map((r) => ({
              value: r.total,
              itemStyle: { color: SEQ[Math.min(3, 1 + Math.floor((r.total / maxV) * 2.99))], borderRadius: [0, 4, 4, 0] },
            })),
            barMaxWidth: 12,
            barCategoryGap: "25%",
          },
        ],
      },
    };
  }, [data, hotspotSort, chartTheme, exitAt]);

  /* One place decides what a mode means, so the chart, the click handler and
     the heading cannot drift apart. Defaulted to an empty list rather than
     indexed blindly: the page should show "no rows" if a ranking ever goes
     missing again, not throw on first render. */
  const causeRows = (d: Analytics | null, mode: CauseMode) =>
    (mode === "Accident causes"
      ? d?.accidentCauses
      : mode === "Breakdown causes"
        ? d?.breakdownCauses
        : d?.types) ?? [];

  const causeChart = useMemo<{ option: EChartsOption; rows: Analytics["types"] } | null>(() => {
    if (!data) return null;
    const src = causeRows(data, causeMode);
    if (src.length === 0) return null;
    const top = src.slice(0, 9);
    const display = causeSort === "desc" ? [...top].reverse() : [...top];
    return {
      rows: display,
      option: {
        grid: { left: 160, right: 42, top: 8, bottom: 18 },
        xAxis: { type: "value", splitNumber: 3, axisLabel: { formatter: (v: number) => fmtInt(v) } },
        yAxis: { type: "category", data: display.map((r) => (r.label.length > 24 ? `${r.label.slice(0, 24)}…` : r.label)), axisLabel: { interval: 0 }, axisTick: { show: false } },
        tooltip: {
          axisPointer: { type: "shadow" },
          formatter: (p) => {
            const i = (p as { dataIndex: number }).dataIndex;
            const r = display[i];
            return `<b>${r.label}</b><br/>${fmtInt(r.total)} incidents · ${fmtInt(r.injuries)} injured · ${fmtInt(r.fatalities)} fatalities`;
          },
        },
        /* No legend: one series named "Incidents" on a chart titled the same,
           beneath a category axis that names every bar. */
        series: [
          {
            name: "Incidents",
            type: "bar",
            data: display.map((r) => ({ value: r.total, itemStyle: { color: RAMP[1], borderRadius: [0, 4, 4, 0] } })),
            barMaxWidth: 12,
            barCategoryGap: "25%",
          },
        ],
      },
    };
  }, [data, causeMode, causeSort, chartTheme]);

  /* The wet-vs-dry block for the card's Day and Hour selection (19 Oct 2026, testers IN-7). Summed from the
     API's per day x hour cells, so incidents are still divided by the hours of that weather in the same
     slots. With both filters on All it is the API's own whole-range block, unchanged. An hour filter changes
     the unit: one hour a day cannot be scaled to a 24-hour day honestly, so it reads per hour of that weather. */
  const weatherSlot = useMemo(() => {
    if (!data) return null;
    const w = data.weather;
    const filtered = wxDay !== "all" || wxHour !== "all";
    const perHour = wxHour !== "all";
    if (!filtered || !w.cells) {
      return { wetHours: w.wetHours, dryHours: w.dryHours, wet: w.incidents.wet, dry: w.incidents.dry, filtered: false, perHour: false, available: !!w.cells };
    }
    const dayOk = (dow: number) =>
      wxDay === "all" ? true : wxDay === "weekday" ? dow >= 1 && dow <= 5 : wxDay === "weekend" ? dow === 0 || dow === 6 : dow === Number(wxDay);
    const hourOk = (h: number) => wxHour === "all" || h === Number(wxHour);
    const acc = { wetHours: 0, dryHours: 0, wet: { accident: 0, breakdown: 0 }, dry: { accident: 0, breakdown: 0 } };
    for (const c of w.cells) {
      if (!dayOk(c.dow) || !hourOk(c.hour)) continue;
      acc.wetHours += c.wetHours;
      acc.dryHours += c.dryHours;
      acc.wet.accident += c.wetAccident;
      acc.wet.breakdown += c.wetBreakdown;
      acc.dry.accident += c.dryAccident;
      acc.dry.breakdown += c.dryBreakdown;
    }
    return { ...acc, filtered: true, perHour, available: true };
  }, [data, wxDay, wxHour]);
  const wxDayLabel = (d: WxDay) =>
    d === "all" ? "Every day" : d === "weekday" ? "Weekdays" : d === "weekend" ? "Weekends" : ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"][Number(d)];
  const wxSlotPhrase =
    wxDay === "all" && wxHour === "all"
      ? null
      : `${wxDayLabel(wxDay)}${wxHour !== "all" ? `, ${fmtHour(Number(wxHour))} – ${fmtHour((Number(wxHour) + 1) % 24)}` : ""}`;
  // Rate per day of that weather (× 24) or, under an hour filter, per hour of it.
  const wxRate = (n: number, hours: number, perHour: boolean) => (hours > 0 ? (n / hours) * (perHour ? 1 : 24) : null);

  const weatherChart = useMemo<EChartsOption | null>(() => {
    if (!data || !derived || !weatherSlot) return null;
    const w = weatherSlot;
    if (w.wetHours === 0 && w.dryHours === 0) return null;
    const cats = ["Accidents", "Breakdowns"] as const;
    const keys = ["accident", "breakdown"] as const;
    const unit = w.perHour ? "per hour" : "per day";
    // Per day of that weather = incidents / hours-of-exposure × 24, so rare wet
    // hours compare fairly against abundant dry hours.
    const rate = (n: number, hours: number) => {
      const r = wxRate(n, hours, w.perHour);
      return r == null ? null : Number(r.toFixed(w.perHour ? 2 : 1));
    };
    return {
      grid: { left: 52, right: 16, top: 24, bottom: 68 },
      xAxis: { type: "category", data: [...cats], axisLabel: { interval: 0, fontSize: 12 }, axisTick: { show: false } },
      yAxis: { type: "value", name: w.perHour ? "avg incidents / hour" : "avg incidents / day", nameGap: 10, nameTextStyle: { align: "left" }, splitNumber: 3 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (p) => {
          const items = p as { seriesName: string; dataIndex: number; value: number | null }[];
          const i = items[0].dataIndex;
          const k = keys[i];
          const v = (name: string) => items.find((x) => x.seriesName === name)?.value;
          const fmtV = (x: number | null | undefined) => (x == null ? "no hours of it" : `${x} ${unit}`);
          return `<b>${cats[i]}</b>${wxSlotPhrase ? ` · ${wxSlotPhrase}` : ""}<br/>Dry weather: ${fmtV(v("Dry weather"))}, ${fmtInt(w.dry[k])} incidents over ${fmtInt(w.dryHours)} dry hrs<br/>Wet weather: ${fmtV(v("Wet weather"))}, ${fmtInt(w.wet[k])} incidents over ${fmtInt(w.wetHours)} wet hrs`;
        },
      },
      legend: { show: true, bottom: 0, left: "center", padding: 0, textStyle: { fontSize: 12 } },
      /* Thicker bars (testers IN-7: "make the bars thicker"): two categories in a half-width card left the
         26 px cap looking like hairlines in a wide plot. A value label on each so the pair reads without
         hovering, and a sliver of surface between the two bars of a pair so they read as two marks. */
      series: [
        { name: "Dry weather", type: "bar", data: keys.map((k) => rate(w.dry[k], w.dryHours)), itemStyle: { color: RAMP[2], borderRadius: [4, 4, 0, 0] }, barMaxWidth: 64, barGap: "4%", barCategoryGap: "30%", label: { show: true, position: "top", fontSize: 12, fontWeight: 600, color: chartTheme.ink } },
        { name: "Wet weather", type: "bar", data: keys.map((k) => rate(w.wet[k], w.wetHours)), itemStyle: { color: RAMP[0], borderRadius: [4, 4, 0, 0] }, barMaxWidth: 64, label: { show: true, position: "top", fontSize: 12, fontWeight: 600, color: chartTheme.ink } },
      ],
    };
  }, [data, derived, weatherSlot, wxSlotPhrase, chartTheme]);

  // ---------- Click-to-inspect ----------
  const filtersNote = `${weather === "all" ? "All weather" : weather === "wet" ? "Wet hours only (rainfall > 0.3 mm)" : "Dry hours only"}${data ? ` · ${data.range.from} to ${data.range.to}` : ""}`;

  const onTrendClick = (p: { dataIndex: number }) => {
    const r = trendRows[p.dataIndex];
    if (!r) return;
    const totals = trendRows.map((x) => x.total);
    const avg = totals.reduce((s, v) => s + v, 0) / totals.length;
    const rank = 1 + totals.filter((v) => v > r.total).length;
    const periodWord = grain === "daily" ? "day" : grain === "weekly" ? "week" : "month";
    const title = grain === "daily" ? `${weekdayOf(r.label)}, ${r.label}` : grain === "weekly" ? `Week of ${r.label}` : r.label;
    setDetail({
      title,
      subtitle: `Incidents · ${periodWord}ly`,
      rows: [
        ["Total incidents", fmtInt(r.total)],
        ["Accidents", fmtInt(r.accident)],
        ["Breakdowns", fmtInt(r.breakdown)],
        ["vs range average", avg > 0 ? fmtPct(((r.total - avg) / avg) * 100) : "—"],
        ["Rank in range", `#${rank} of ${totals.length} ${periodWord}s`],
      ],
      note: filtersNote,
    });
  };

  const showHotspotDetail = (r: Analytics["hotspots"][number]) => {
    if (!derived) return;
    setDetail({
      title: kmLabelBoth(r.km_bin),
      subtitle: "Incident hotspot (5-km segment of official km posts, Balintawak = Km 12)",
      rows: [
        ["Nearest exit", exitAt.nameForBin(r.km_bin) ?? "—"],
        ["Total incidents", fmtInt(r.total)],
        ["Accidents", fmtInt(r.accident)],
        ["Breakdowns", fmtInt(r.breakdown)],
        ["Injuries", fmtInt(r.injuries)],
        ["Fatalities", fmtInt(r.fatalities)],
        ["Share of located incidents", derived.hotspotTotal > 0 ? `${((r.total / derived.hotspotTotal) * 100).toFixed(1)}%` : "—"],
      ],
      note: `Km-post parsed from the operations log location field. ${filtersNote}`,
    });
  };

  const onHotspotClick = (p: { dataIndex: number }) => {
    const r = hotspotChart?.rows[p.dataIndex];
    if (r) showHotspotDetail(r);
  };

  const onCauseClick = (p: { dataIndex: number }) => {
    if (!causeChart || !data) return;
    const r = causeChart.rows[p.dataIndex];
    if (!r) return;
    const pool = causeRows(data, causeMode);
    const total = pool.reduce((s, x) => s + x.total, 0);
    setDetail({
      title: r.label,
      subtitle:
        causeMode === "Accident causes"
          ? "Reported cause (crashes)"
          : causeMode === "Breakdown causes"
            ? "Reported fault (breakdowns)"
            : "Accident type (crashes only)",
      rows: [
        ["Incidents", fmtInt(r.total)],
        ["Share", total > 0 ? `${((r.total / total) * 100).toFixed(1)}%` : "—"],
        ["Injuries", fmtInt(r.injuries)],
        ["Fatalities", fmtInt(r.fatalities)],
      ],
      note: filtersNote,
    });
  };

  const onWeatherClick = (p: { dataIndex: number; seriesName?: string }) => {
    if (!data || !derived || !weatherSlot) return;
    const keys = ["accident", "breakdown"] as const;
    const k = keys[p.dataIndex];
    const w = data.weather;
    const s = weatherSlot;
    const unit = s.perHour ? "per hour" : "per day";
    const fmtRate = (n: number, hours: number) => {
      const r = wxRate(n, hours, s.perHour);
      return r == null ? "—" : `${r.toFixed(s.perHour ? 2 : 1)} ${unit}`;
    };
    setDetail({
      title: `${SOURCE_LABEL[k]} — weather impact${wxSlotPhrase ? ` · ${wxSlotPhrase}` : ""}`,
      subtitle: "Wet = expressway-average rainfall > 0.3 mm in that hour",
      rows: [
        ["Incidents in dry hours", `${fmtInt(s.dry[k])} over ${fmtInt(s.dryHours)} hrs`],
        ["Incidents in wet hours", `${fmtInt(s.wet[k])} over ${fmtInt(s.wetHours)} hrs`],
        ["Rate in dry weather", fmtRate(s.dry[k], s.dryHours)],
        ["Rate in wet weather", fmtRate(s.wet[k], s.wetHours)],
        // Jam speeds are whole-range only: the API does not cut them by day or hour.
        ["Avg jam speed (dry, whole Range)", w.jam.dry ? `${w.jam.dry.speed} km/h` : "—"],
        ["Avg jam speed (wet, whole Range)", w.jam.wet ? `${w.jam.wet.speed} km/h` : "—"],
      ],
      note: s.perHour
        ? "Rates are exposure-normalized: incidents ÷ hours with that weather in the chosen hour of the day. Wet hours are much rarer than dry, so raw counts can't be compared directly."
        : "Rates are exposure-normalized: incidents ÷ hours with that weather, scaled to a 24-hour day. Wet hours are much rarer than dry, so raw counts can't be compared directly.",
    });
  };

  const chartFrame = (option: EChartsOption | null, emptyNote: string, onClick?: (p: never) => void) => {
    if (loading && !data) return <ChartSkeleton />;
    if (error) return <div className={styles.placeholder}>Live data unavailable — is the backend running on port 4000?</div>;
    if (!option) return <div className={styles.placeholder}>{emptyNote}</div>;
    return (
      <ReactECharts
        option={applyChartTheme(option, frameTheme)}
        notMerge
        lazyUpdate
        style={{ width: "100%", height: "100%" }}
        opts={{ renderer: "canvas" }}
        onEvents={onClick ? { click: onClick as (p: unknown) => void } : undefined}
        // Lines are drawn with symbol:"none", so they have no clickable points
        // and ECharts' item click never fires with the right index. Resolve the
        // category from the cursor position instead.
        onChartReady={
          onClick
            ? (chart) => attachCategoryClick(chart as never, onClick as never)
            : undefined
        }
      />
    );
  };

  // A skeleton rather than an ellipsis: the tile keeps its height, so the KPI
  // row does not resize under the cursor as the numbers arrive.
  /* "No data" is kept for a value the loaded data genuinely lacks; a request that failed says Unavailable,
     and the hint under it says it did not load rather than printing a dash (19 Oct 2026, testers IN-2). */
  const kpiValue = (v: string | null) =>
    loading && !data ? (
      <KpiSkeleton />
    ) : !data && error ? (
      <span className="inc-kpi-empty">Unavailable</span>
    ) : v == null ? (
      <span className="inc-kpi-empty">No data</span>
    ) : (
      <CountUpValue text={v} />
    );
  const pendingHint = error ? "Not loaded: see the note above" : "Loading…";

  // One-glance explanation of what a KPI tile actually measures — same
  // portal-based popup used on every Predictive-tab card title.
  const kpiInfo = (text: string) => <InfoTooltip text={text} />;

  // ---------- Global filter controls ----------
  // One sticky bar under the mode switch, on every tab, so the strip above the
  // page means the same thing whichever tab is open. Defined once rather than
  // duplicated, so a change to Range or Weather can't drift between the tabs.
  /* The same bar as the Traffic tab's (19 Oct 2026, user request): Custom is a Descriptive control only.
     The forecast and plan cards take the presets, which set how much history they read. */
  /* Custom stays a Descriptive control. Carried onto Predictive or Prescriptive it used to send an empty
     from/to, and the forecast card waited forever for a range it would never get (19 Oct 2026). Those tabs
     read 12 mo instead, and show it, until a preset is pressed; Descriptive keeps the custom dates. */
  const presetRange: "3" | "12" | "all" = rangeMode === "custom" ? "12" : rangeMode;
  const shownRange = activeTab === "Descriptive" ? rangeMode : presetRange;

  const rangeFilter = (
    <div className={styles.filterGroup}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: "var(--text-muted)" }} aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" strokeWidth="1.4" /><path d="M2 6h12" stroke="currentColor" strokeWidth="1.4" /><path d="M5.5 2V4M10.5 2V4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      <span className={styles.filterLabel}>Range</span>
      <div className={styles.segmented} role="group" aria-label="Range">
        {(activeTab === "Descriptive" ? (["3", "12", "all", "custom"] as const) : (["3", "12", "all"] as const)).map((m) => (
          <button key={m} className={shownRange === m ? "active" : ""} aria-pressed={shownRange === m} onClick={() => setRangeMode(m)}>
            {RANGE_LABEL[m]}
          </button>
        ))}
      </div>
      {activeTab === "Descriptive" && rangeMode === "custom" && (
        <DateRangePicker
          startDate={customFrom}
          minDate={data?.meta.minDate}
          maxDate={data?.meta.maxDate}
          endDate={customTo}
          onChange={(start, end) => {
            setCustomFrom(start);
            setCustomTo(end);
          }}
        />
      )}
    </div>
  );

  const weatherFilter = (
    <div className={styles.filterGroup}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: "var(--text-muted)" }} aria-hidden="true"><path d="M4.5 11.5a3 3 0 1 1 .4-5.97 4 4 0 0 1 7.75 1.1A2.5 2.5 0 0 1 12 11.5H4.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M6 13.2v1M9 13.2v1M12 13.2v1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      <span className={styles.filterLabel}>Weather</span>
      <div className={styles.segmented} role="group" aria-label="Weather">
        {(["all", "dry", "wet"] as const).map((w) => (
          <button key={w} className={weather === w ? "active" : ""} aria-pressed={weather === w} onClick={() => setWeather(w)}>
            {w === "all" ? "All" : w === "dry" ? "Dry" : "Wet"}
          </button>
        ))}
      </div>
    </div>
  );

  // Incident type scopes the whole analytics fetch (every Descriptive card and
  // KPI), so it lives in the page's filter bar rather than on one card.
  const sourceFilter = (
    <div className={styles.filterGroup}>
      <span className={styles.filterLabel}>Incident type</span>
      <CustomSelect
        value={source}
        onChange={(v) => setSource(v as SourceFilter)}
        options={[
          { label: "All types", value: "all" },
          { label: "Accidents", value: "accident" },
          { label: "Breakdowns", value: "breakdown" },
        ]}
      />
    </div>
  );

  // Active, non-default filters as removable chips. Each one's × calls that
  // filter's own setter with its default value: exactly what pressing the
  // default pill (12 mo, All, All types) already does.
  const activeFilters: { key: string; label: string; clear: () => void }[] = [];
  if (shownRange !== "12")
    activeFilters.push({
      key: "range",
      label: shownRange === "custom" ? (customFrom && customTo ? `${customFrom} – ${customTo}` : "Custom range") : `Range ${RANGE_LABEL[shownRange]}`,
      clear: () => setRangeMode("12"),
    });
  if (activeTab === "Descriptive" && weather !== "all")
    activeFilters.push({ key: "weather", label: weather === "wet" ? "Wet hours" : "Dry hours", clear: () => setWeather("all") });
  if (activeTab === "Descriptive" && source !== "all")
    activeFilters.push({ key: "source", label: SOURCE_LABEL[source], clear: () => setSource("all") });

  const filterChips =
    activeFilters.length > 0 ? (
      <div className="inc-chips" role="group" aria-label="Active filters">
        <span className="inc-chips-label">Active</span>
        {activeFilters.map((f) => (
          <button key={f.key} type="button" className="inc-chip" onClick={f.clear} aria-label={`Remove filter: ${f.label}`}>
            {f.label}
            <X aria-hidden="true" />
          </button>
        ))}
      </div>
    ) : null;

  // ---------- Mode switch: one segmented control under the page title ----------
  const modeTabs = (
    <div className={styles.modeTabs} style={{ ["--mode-i" as string]: modeIndex(activeTab) }}>
      {(["Descriptive", "Predictive", "Prescriptive"] as const).map((t) => (
        <button key={t} className={`${styles.modeTab} ${activeTab === t ? styles.modeTabActive : ""}`} onClick={() => setActiveTab(t)} aria-pressed={activeTab === t}>
          <ModeTabLabel mode={t} />
        </button>
      ))}
      <span className={styles.modeIndicator} aria-hidden="true" />
    </div>
  );

  // ---------- Card answers, computed from the loaded data at render time ----------
  const trendPeak = trendRows.length > 0 ? trendRows.reduce((a, r) => (r.total > a.total ? r : a)) : null;
  const trendPeriod = grain === "daily" ? "day" : grain === "weekly" ? "week" : "month";
  const topCause = data ? [...causeRows(data, causeMode)].sort((a, b) => b.total - a.total)[0] ?? null : null;
  const causeNoun = causeMode === "Accident causes" ? "accident cause" : causeMode === "Breakdown causes" ? "breakdown cause" : "accident type";
  const wetBreakdownRate = data && data.weather.wetHours > 0 ? (data.weather.incidents.wet.breakdown / data.weather.wetHours) * 24 : null;
  const dryBreakdownRate = data && data.weather.dryHours > 0 ? (data.weather.incidents.dry.breakdown / data.weather.dryHours) * 24 : null;
  /* Incident types in view: what the hour x day grid cannot say. Same Range, Weather
     and Incident type as everything else on the tab, from rows already loaded. */
  /* The hovered or clicked cell, broken into its types (19 Oct 2026, testers IN-8: "use the white space below
     the heatmap for incident-type details"). Falls back to the whole grid when no cell is in focus. */
  const renderIncidentMix = (focus: { cell: HeatCell; pinned: boolean } | null, clearPin: () => void) => {
    if (!data || error) return null;
    const cellRow = focus ? data.heatmap.find((r) => r.dow === focus.cell.dow && r.hour === focus.cell.hour) : null;
    if (focus && cellRow && cellRow.accident != null) {
      const dowCount = [0, 0, 0, 0, 0, 0, 0];
      const end = new Date(`${data.range.to}T00:00:00`);
      for (const d = new Date(`${data.range.from}T00:00:00`); d <= end; d.setDate(d.getDate() + 1)) dowCount[d.getDay()]++;
      const days = Math.max(1, dowCount[focus.cell.dow]);
      const dayName = DOW_LABELS[DOW_ORDER.indexOf(focus.cell.dow)];
      const acc = cellRow.accident ?? 0;
      const brk = cellRow.breakdown ?? 0;
      const all = acc + brk;
      const pct = (n: number) => (all > 0 ? `${((n / all) * 100).toFixed(0)}%` : "0%");
      // This weekday's average hour, so the cell reads against its own day rather than the week.
      const dayTotal = data.heatmap.filter((r) => r.dow === focus.cell.dow).reduce((s, r) => s + r.v, 0);
      const vsDay = dayTotal > 0 ? all / (dayTotal / 24) : null;
      return (
        <div className="inc-mix" aria-live="polite">
          <div className="inc-mix-head">
            <h4 className="inc-subhead">
              {dayName} · {fmtHour(focus.cell.hour)} – {fmtHour((focus.cell.hour + 1) % 24)}
            </h4>
            {focus.pinned ? (
              <button type="button" className="btn-muted inc-mix-clear" onClick={clearPin}>Show whole grid</button>
            ) : (
              <span className="inc-mix-hint">Click the cell to keep it here</span>
            )}
          </div>
          <div className="inc-mix-bar" role="img" aria-label={`${pct(acc)} accidents, ${pct(brk)} breakdowns`}>
            {acc > 0 && <span style={{ width: `${(acc / all) * 100}%`, background: TYPE_HUES[0] }} />}
            {brk > 0 && <span style={{ width: `${(brk / all) * 100}%`, background: TYPE_HUES[2] }} />}
          </div>
          <div className="inc-mix-rows">
            <div className="inc-mix-row">
              <i style={{ background: TYPE_HUES[0] }} aria-hidden="true" />
              <span className="inc-mix-name">Accidents</span>
              <span className="inc-mix-count">{fmt1(acc / days)} / day · {pct(acc)}</span>
            </div>
            <div className="inc-mix-row">
              <i style={{ background: TYPE_HUES[2] }} aria-hidden="true" />
              <span className="inc-mix-name">Breakdowns</span>
              <span className="inc-mix-count">{fmt1(brk / days)} / day · {pct(brk)}</span>
            </div>
          </div>
          <p className="inc-mix-facts" style={{ gridColumn: "auto" }}>
            <b>{fmtInt(all)}</b> incidents across {fmtInt(dowCount[focus.cell.dow])} {dayName}s in the Range
            {vsDay != null && <> · <b>{vsDay.toFixed(1)}×</b> {dayName}&apos;s average hour</>}.
          </p>
        </div>
      );
    }
    const acc = data.dailyTrend.reduce((s, r) => s + r.accident, 0);
    const brk = data.dailyTrend.reduce((s, r) => s + r.breakdown, 0);
    const all = acc + brk;
    if (all === 0) return null;
    const pct = (n: number) => `${((n / all) * 100).toFixed(1)}%`;
    const topSeg = (key: "accident" | "breakdown") => {
      const h = [...data.hotspots].sort((a, b) => b[key] - a[key])[0];
      return h && h[key] > 0 ? h : null;
    };
    const segAcc = topSeg("accident");
    const segBrk = topSeg("breakdown");
    const topType = data.types[0];
    const topAccCause = data.accidentCauses[0];
    const topBrkCause = data.breakdownCauses[0];
    return (
      <div className="inc-mix">
        <div className="inc-mix-head">
          <h4 className="inc-subhead">Incident types in view</h4>
          <span className="inc-mix-hint">Hover a cell for its own split</span>
        </div>
        <div className="inc-mix-bar" role="img" aria-label={`${pct(acc)} accidents, ${pct(brk)} breakdowns`}>
          {acc > 0 && <span style={{ width: `${(acc / all) * 100}%`, background: TYPE_HUES[0] }} title={`Accidents: ${fmtInt(acc)} (${pct(acc)})`} />}
          {brk > 0 && <span style={{ width: `${(brk / all) * 100}%`, background: TYPE_HUES[2] }} title={`Breakdowns: ${fmtInt(brk)} (${pct(brk)})`} />}
        </div>
        <div className="inc-mix-rows">
          {acc > 0 && (
            <div className="inc-mix-row">
              <i style={{ background: TYPE_HUES[0] }} aria-hidden="true" />
              <span className="inc-mix-name">Accidents</span>
              <span className="inc-mix-count">{fmtInt(acc)} · {pct(acc)}</span>
              <p className="inc-mix-facts">
                {topType && <>Most common type <b>{topType.label}</b> ({fmtInt(topType.total)}). </>}
                {topAccCause && <>Top cause <b>{topAccCause.label}</b> ({fmtInt(topAccCause.total)}). </>}
                <b>{fmtInt(data.kpis.injuries)}</b> injured, <b>{fmtInt(data.kpis.fatalities)}</b> fatal.
                {segAcc && <> Busiest near <b>{exitAt.nameForBin(segAcc.km_bin) ?? kmLabel(segAcc.km_bin)}</b> ({kmLabelBoth(segAcc.km_bin)}).</>}
              </p>
            </div>
          )}
          {brk > 0 && (
            <div className="inc-mix-row">
              <i style={{ background: TYPE_HUES[2] }} aria-hidden="true" />
              <span className="inc-mix-name">Breakdowns</span>
              <span className="inc-mix-count">{fmtInt(brk)} · {pct(brk)}</span>
              <p className="inc-mix-facts">
                {topBrkCause && <>Top fault <b>{topBrkCause.label}</b> ({fmtInt(topBrkCause.total)}). </>}
                {segBrk && <>Busiest near <b>{exitAt.nameForBin(segBrk.km_bin) ?? kmLabel(segBrk.km_bin)}</b> ({kmLabelBoth(segBrk.km_bin)}).</>}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  };

  const answer = (value: ReactNode, label: ReactNode) =>
    data && !error ? (
      <p className="inc-answer inc-chart-answer">
        <span className="inc-answer-value">{value}</span>
        <span className="inc-answer-label">{label}</span>
      </p>
    ) : null;

  return (
    <section className={`${styles.page} viz-incident`}>
      <PageHeader accent="incident" icon={AlertTriangle} title="Incident Overview" subtitle="Road crashes, hazards, and response patterns across NLEX" />

      {modeTabs}

      {/* Sticky filter bar, as on the Traffic tab: Predictive and Prescriptive take the Range presets only;
          Descriptive adds Custom, Weather, Incident type and the "Updating…" note. The forecast card
          carries its own Weather toggle (models fitted with or without rainfall). */}
      <div className={styles.filterRow}>
        {rangeFilter}
        {activeTab === "Descriptive" && weatherFilter}
        {activeTab === "Descriptive" && sourceFilter}
        {activeTab === "Descriptive" && loading && data && <span className={styles.updating}>Updating…</span>}
        <span className={styles.spacer} />
        {filterChips}
      </div>

      <div className={styles.modeStage} key={activeTab}>
        {activeTab === "Predictive" && (
          <>
            <div className={styles.spanFull}>
              <PredictiveIncidentChart
                months={presetRange}
                weather="all"
                onDataBoundsChange={setPredictiveDataBounds}
                onWeatherApplicableChange={setWeatherApplicable}
              />
            </div>
            <div className={styles.spanFull}>
              <PredictiveCorridorChart />
            </div>
            <div className={styles.spanFull}>
              <BreakdownResponseModel />
            </div>
          </>
        )}

        {activeTab === "Prescriptive" && (
          <>
            <div className={styles.spanFull}>
              <PrescriptiveDeploymentPanel
                months={presetRange}
              />
            </div>
            <div className={styles.spanFull}>
              <PatrolAlertWindowPanel
                months={presetRange}
              />
            </div>
            <div className={styles.spanFull}>
              <ClearanceResponsePanel
                months={presetRange}
              />
            </div>
          </>
        )}

        {activeTab === "Descriptive" && (
          <>
            {/* KPI strip: the answer, its context, the method behind the (i). */}
            {error && (
              <div className={`${styles.spanFull} inc-notice is-warning`} role="alert">
                <AlertTriangle size={16} aria-hidden="true" />
                <span>
                  {data
                    ? <>Couldn&apos;t refresh the incident analytics ({error}). The tiles and charts show the last loaded result.</>
                    : <>Couldn&apos;t load the incident analytics ({error}), so the tiles below have no values yet. This is a connection problem, not an empty Range.</>}
                </span>
                <button type="button" className="btn-muted inc-retry" onClick={() => setReloadKey((k) => k + 1)}>Try again</button>
              </div>
            )}
            <div className={`${styles.kpiRow} ds-rise`}>
              <article className={styles.kpiTile}>
                <span className={styles.kpiIcon} aria-hidden="true"><AlertTriangle size={15} /></span>
                <h3>
                  Total Incidents
                  {kpiInfo("All logged incidents — accidents and breakdowns — in the selected Range, compared to the equivalent prior period.")}
                </h3>
                <div className={styles.kpiValue}>{kpiValue(data ? fmtInt(data.kpis.totalIncidents) : null)}</div>
                <p className={styles.kpiHint}>
                  {derived && derived.deltaPct != null ? (
                    <>
                      <span className={derived.deltaPct <= 0 ? styles.deltaUp : styles.deltaDown}>{fmtPct(derived.deltaPct)}</span>{" "}
                      vs previous period
                    </>
                  ) : derived && data && data.range.from <= data.meta.minDate ? (
                    "Range starts at the first record: no earlier period to compare"
                  ) : derived ? (
                    "No incidents in the previous period to compare against"
                  ) : (
                    pendingHint
                  )}
                </p>
              </article>
              <article className={styles.kpiTile}>
                <span className={styles.kpiIcon} aria-hidden="true"><HeartPulse size={15} /></span>
                <h3>
                  Injuries
                  {kpiInfo("Total people injured across all incidents in the Range, including incidents that also had a fatality.")}
                </h3>
                <div className={styles.kpiValue}>{kpiValue(data ? fmtInt(data.kpis.injuries) : null)}</div>
                <p className={styles.kpiHint}>{data ? `${fmtInt(data.kpis.fatalities)} fatalities in range` : pendingHint}</p>
              </article>
              <article className={styles.kpiTile}>
                <span className={styles.kpiIcon} aria-hidden="true"><Timer size={15} /></span>
                <h3>
                  Avg Response Time
                  {kpiInfo("Breakdowns only: average minutes from a breakdown being reported to the first responder being dispatched. Accidents have no per-dispatch record to measure this from, so they aren't included.")}
                </h3>
                <div className={styles.kpiValue}>
                  {kpiValue(data?.kpis.avgTimeToFirstResponder.min != null ? `${data.kpis.avgTimeToFirstResponder.min} min` : null)}
                </div>
                <p className={styles.kpiHint}>
                  {data && data.kpis.avgTimeToFirstResponder.min != null
                    ? `${data.kpis.avgTimeToFirstResponder.medianMin != null ? `median ${data.kpis.avgTimeToFirstResponder.medianMin} · p90 ${data.kpis.avgTimeToFirstResponder.p90Min} min · ` : ""}breakdowns only · ${fmtInt(data.kpis.avgTimeToFirstResponder.n)} of ${fmtInt(data.kpis.avgTimeToFirstResponder.totalBreakdowns)} logged`
                    : data && source === "accident"
                      ? "Breakdowns only: Incident type is set to Accidents"
                      : data && data.kpis.avgTimeToFirstResponder.totalBreakdowns === 0
                        ? "No breakdowns in this Range and Weather"
                        : data
                          ? `None of the ${fmtInt(data.kpis.avgTimeToFirstResponder.totalBreakdowns)} breakdowns in range has a dispatch response logged`
                          : pendingHint}
                </p>
              </article>
              {/* Time to clear (MTTC, KPI 3.6.2): computed by the API since October but never shown (fix list A15,
                  2 Nov 2026). Mean beside median and 90th percentile, because a few very long clearances pull the
                  mean up; and how many incidents carry the times at all. */}
              <article className={styles.kpiTile}>
                <span className={styles.kpiIcon} aria-hidden="true"><Timer size={15} /></span>
                <h3>
                  Avg Time to Clear
                  {kpiInfo("Minutes from an incident being reported until the road was cleared: accidents from their recorded clearance time, breakdowns until the last responding unit left. The headline is the mean of both, weighted by how many of each have times; the hint gives the median and 90th percentile by type, since a few very long clearances pull the mean up.")}
                </h3>
                <div className={styles.kpiValue}>
                  {kpiValue(data?.kpis.mttc?.overallMin != null ? `${data.kpis.mttc.overallMin} min` : null)}
                </div>
                <p className={styles.kpiHint}>
                  {data?.kpis.mttc
                    ? [
                        data.kpis.mttc.accident?.medianMin != null ? `accidents median ${data.kpis.mttc.accident.medianMin} · p90 ${data.kpis.mttc.accident.p90Min}` : "",
                        data.kpis.mttc.breakdown?.medianMin != null ? `breakdowns median ${data.kpis.mttc.breakdown.medianMin} · p90 ${data.kpis.mttc.breakdown.p90Min}` : "",
                        data.kpis.mttc.coverage.pctValid != null ? `${data.kpis.mttc.coverage.pctValid}% have times` : "",
                      ].filter(Boolean).join(" min · ") || "No clearance times in this Range"
                    : pendingHint}
                </p>
              </article>
              <article className={styles.kpiTile}>
                <span className={styles.kpiIcon} aria-hidden="true"><MapPin size={15} /></span>
                <h3>
                  Top Hotspot
                  {kpiInfo("The 5km corridor segment with the most incidents in the Range, among segments whose location could be resolved.")}
                </h3>
                <div className={styles.kpiValue}>{kpiValue(derived?.topHotspot ? kmLabel(derived.topHotspot.km_bin) : null)}</div>
                <p className={styles.kpiHint}>
                  {derived?.topHotspot && derived.hotspotTotal > 0
                    ? `${kmLabel(derived.topHotspot.km_bin)} · near ${exitAt.nameForBin(derived.topHotspot.km_bin) ?? "—"} · ${((derived.topHotspot.total / derived.hotspotTotal) * 100).toFixed(1)}% of located incidents`
                    : data
                      ? "No incident in this Range and Weather has a resolved location"
                      : pendingHint}
                </p>
              </article>
              <article className={styles.kpiTile}>
                <span className={styles.kpiIcon} aria-hidden="true"><CloudRain size={15} /></span>
                <h3>
                  Crash Rate in Rain
                  {kpiInfo("Crashes in rainy hours against what those same hours of the day usually see when dry. Each wet hour is compared with the dry crash rate of that hour of the day, because rain falls mostly in the busy afternoon. Above 1× means rain adds crashes beyond the time of day. Always compares both weathers, so the Weather filter does not change it.")}
                </h3>
                <div className={styles.kpiValue}>{kpiValue(derived?.rainMultiplier != null ? `${derived.rainMultiplier.toFixed(2)}×` : null)}</div>
                <p className={styles.kpiHint}>
                  {derived
                    ? derived.rainMultiplier != null
                      ? `${derived.wetRate.toFixed(1)} vs ${derived.dryRate.toFixed(1)} crashes/day, wet vs dry${derived.rainLo != null && derived.rainHi != null ? ` · 95% CI ${derived.rainLo.toFixed(2)}–${derived.rainHi.toFixed(2)}×` : ""}${derived.rainSameHour ? " · same hours compared" : ""}${weather !== "all" ? " · always both weathers" : ""}`
                      : derived.rainEmptyReason
                    : pendingHint}
                </p>
              </article>
            </div>

            {/* Main time series, full width */}
            <article className={`${styles.chartCard} ${styles.chart1} ${styles.hero}`}>
              <div className={styles.chartHead}>
                <div className={styles.headText}>
                  <h3>
                    Incident Trend
                    <InfoTooltip text="Incident counts over the selected Range, by type (accidents, breakdowns). Daily, weekly, or monthly — click a point to see that period's breakdown." />
                  </h3>
                </div>
                <div className={styles.heroFilterGroup}>
                  <span className={styles.heroFilterLabel}>Granularity</span>
                  <div className={styles.segmentedSmall}>
                    {(["daily", "weekly", "monthly"] as const).map((g) => (
                      <button
                        key={g}
                        className={grain === g ? "active" : ""}
                        aria-pressed={grain === g}
                        disabled={Boolean(grainBlockedReason(g, spanDays))}
                        title={grainBlockedReason(g, spanDays) ?? undefined}
                        onClick={() => setGrain(g)}
                      >
                        {g.charAt(0).toUpperCase() + g.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {trendPeak &&
                answer(
                  fmtInt(trendPeak.total),
                  <>
                    incidents in <b>{bucketLabelFor(grain)(trendPeak.label)}</b>, the busiest {trendPeriod} shown
                  </>
                )}
              {data && !error && <p className="inc-context" style={{ margin: "-6px 0 12px" }}>{filtersNote}</p>}
              <div className={styles.chartBody}>{chartFrame(trendOption, "No incident data for the selected filters", onTrendClick)}</div>
            </article>

            {/* Breakdowns, two columns */}
            <article className={`${styles.chartCard} inc-half`}>
              <div className={styles.chartHead}>
                <div className={styles.headText}>
                  <h3>
                    Hotspots by Km Segment
                    <InfoTooltip text="Top 10 km segments by total located incidents in the Range, each named by its nearest exit. Bar shade repeats the length: deeper purple = more incidents. Hover a bar for its injury and fatality counts." />
                  </h3>
                </div>
                <button
                  type="button"
                  className={styles.sortBtn}
                  onClick={() => setHotspotSort(hotspotSort === "desc" ? "asc" : "desc")}
                  title={hotspotSort === "desc" ? "Sorted highest first — click for lowest first" : "Sorted lowest first — click for highest first"}
                  aria-label={`Sort order: ${hotspotSort === "desc" ? "highest first" : "lowest first"}. Activate to reverse.`}
                >
                  {hotspotSort === "desc" ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
                </button>
                <button className={styles.secondaryButton} onClick={() => setAllHotspotsOpen(true)}>
                  View all
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 12l4-4-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
              {derived?.topHotspot &&
                answer(
                  kmLabel(derived.topHotspot.km_bin),
                  <>
                    <b>{fmtInt(derived.topHotspot.total)}</b> incidents near <b>{exitAt.nameForBin(derived.topHotspot.km_bin) ?? "—"}</b>
                    {derived.hotspotTotal > 0 ? ` · ${((derived.topHotspot.total / derived.hotspotTotal) * 100).toFixed(1)}% of located` : ""}
                  </>
                )}
              <div className={styles.chartBody}>{chartFrame(hotspotChart?.option ?? null, "No located incidents in range", onHotspotClick)}</div>
            </article>

            <article className={`${styles.chartCard} inc-half`}>
              <div className={styles.chartHead}>
                <div className={styles.headText}>
                  <h3>
                    {causeMode === "Accident causes"
                      ? "Top Accident Causes"
                      : causeMode === "Breakdown causes"
                        ? "Top Breakdown Causes"
                        : "Top Accident Types"}
                    <InfoTooltip text="Top 9 logged causes or collision types by incident count in the Range, with injuries and fatalities on hover. Toggle between Causes and Types on the right." />
                  </h3>
                </div>
                <button
                  type="button"
                  className={styles.sortBtn}
                  onClick={() => setCauseSort(causeSort === "desc" ? "asc" : "desc")}
                  title={causeSort === "desc" ? "Sorted highest first — click for lowest first" : "Sorted lowest first — click for highest first"}
                  aria-label={`Sort order: ${causeSort === "desc" ? "highest first" : "lowest first"}. Activate to reverse.`}
                >
                  {causeSort === "desc" ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
                </button>
                <div className={styles.segmentedSmall} style={{ flexBasis: "100%" }}>
                  {CAUSE_MODES.map((m) => (
                    <button key={m} className={causeMode === m ? "active" : ""} aria-pressed={causeMode === m} onClick={() => setCauseMode(m)}>
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              {topCause &&
                answer(
                  fmtInt(topCause.total),
                  <>
                    incidents · <b>{topCause.label}</b>, the top {causeNoun}
                  </>
                )}
              <div className={styles.chartBody}>{chartFrame(causeChart?.option ?? null, "No data for the selected filters", onCauseClick)}</div>
            </article>

            <article className={`${styles.chartCard} inc-half`}>
              <div className={styles.chartHead}>
                <div className={styles.headText}>
                  <h3>
                    Dry vs Wet: Incidents per Day
                    <InfoTooltip text="Average incidents per day by type, dry vs. wet hours — normalized by hours of exposure (× 24) so rare wet hours compare fairly against far more abundant dry ones, not raw counts. Day and Hour narrow both sides to the same slots; choosing an hour reads per hour of that weather instead of per day." />
                  </h3>
                </div>
                {/* Day and Hour (testers IN-7). Card-local: they narrow this comparison only, never the tab. */}
                <div className={styles.heroFilterGroup} style={{ flexWrap: "wrap", rowGap: 6 }}>
                  <span className={styles.heroFilterLabel}>Day</span>
                  <CustomSelect
                    value={wxDay}
                    onChange={(v) => setWxDay(v as WxDay)}
                    disabled={weatherSlot?.available === false}
                    title={weatherSlot?.available === false ? "Reload the page: this response predates the day and hour breakdown" : undefined}
                    options={[
                      { label: "Every day", value: "all" },
                      { label: "Weekdays", value: "weekday" },
                      { label: "Weekends", value: "weekend" },
                      ...DOW_ORDER.map((d, i) => ({ label: DOW_LABELS[i], value: String(d) })),
                    ]}
                  />
                  <span className={styles.heroFilterLabel}>Hour</span>
                  <CustomSelect
                    value={wxHour}
                    onChange={(v) => setWxHour(v as WxHour)}
                    disabled={weatherSlot?.available === false}
                    options={[{ label: "All hours", value: "all" }, ...Array.from({ length: 24 }, (_, h) => ({ label: `${fmtHour(h)} – ${fmtHour((h + 1) % 24)}`, value: String(h) }))]}
                  />
                </div>
              </div>

              {(() => {
                if (!weatherSlot) return null;
                const s = weatherSlot;
                if (!s.filtered) {
                  return derived?.rainMultiplier != null
                    ? answer(
                        `${derived.rainMultiplier.toFixed(2)}×`,
                        <>
                          crash rate in wet vs dry hours
                          {wetBreakdownRate != null && dryBreakdownRate != null ? (
                            <>
                              {" "}· breakdowns <b>{wetBreakdownRate.toFixed(1)}</b> vs <b>{dryBreakdownRate.toFixed(1)}</b> per day
                            </>
                          ) : null}
                        </>
                      )
                    : null;
                }
                // The slot's own multiplier, on the same accidents-only rule as the KPI tile.
                const wetR = wxRate(s.wet.accident, s.wetHours, s.perHour);
                const dryR = wxRate(s.dry.accident, s.dryHours, s.perHour);
                const mult = wetR != null && dryR != null && dryR > 0 && source !== "breakdown" ? wetR / dryR : null;
                return answer(
                  mult != null ? `${mult.toFixed(2)}×` : "—",
                  <>
                    {mult != null ? "crash rate in wet vs dry hours" : source === "breakdown" ? "crash rate: Incident type is set to Breakdowns" : "no crash rate: one weather has no hours or no crashes here"} on <b>{wxSlotPhrase}</b>
                    {" "}· <b>{fmtInt(s.wetHours)}</b> wet and <b>{fmtInt(s.dryHours)}</b> dry hours
                  </>
                );
              })()}
              {weatherSlot?.filtered && weatherSlot.wetHours > 0 && weatherSlot.wetHours < 24 && (
                <p className="inc-caption" style={{ margin: "-6px 0 10px" }}>
                  Only {fmtInt(weatherSlot.wetHours)} wet hours fall in this slot, so the wet rate rests on few hours and moves a lot with each incident.
                </p>
              )}
              <div className={styles.chartBody}>{chartFrame(weatherChart, "No weather data in range", onWeatherClick)}</div>
            </article>

            <article className={`${styles.chartCard} inc-half`}>
              <div className={styles.chartHead}>
                <div className={styles.headText}>
                  <h3>
                    Incidents by Hour and Day
                    <InfoTooltip text="Average incidents in each hour of each weekday, normalized for how many of that weekday the Range contains. Follows Range, Weather and Incident type. Hover or click a cell for that hour’s accident and breakdown split below the grid." />
                  </h3>
                </div>
              </div>
              {loading && !data ? (
                <div className={styles.chartBody}><ChartSkeleton /></div>
              ) : error ? (
                <div className={styles.placeholder} style={{ height: 200 }}>Live data unavailable — is the backend running on port 4000?</div>
              ) : data && data.heatmap.length > 0 ? (
                <>
                  <HeatmapWithBreakdown heatmap={data.heatmap} range={data.range} renderMix={renderIncidentMix} />
                </>
              ) : (
                <div className={styles.placeholder} style={{ height: 200 }}>No data for the selected filters</div>
              )}
            </article>

            {/* Dispatch response times (breakdown log); follows Range like every other card.
                Full width: with When Incidents Happen removed (it repeated the Hour x Day grid) it is the
                fifth half-width card and would otherwise sit alone beside an empty column. */}
            <div className={`${styles.spanFull} inc-full`}>
              <EventBreakdownPanel
                months={rangeMode === "custom" ? "all" : rangeMode}
                from={rangeMode === "custom" ? customFrom : undefined}
                to={rangeMode === "custom" ? customTo : undefined}
              />
            </div>
          </>
        )}
      </div>

      {/* Click-to-inspect detail modal */}
      {activeTab === "Descriptive" && detail && (
        <div className={styles.detailBackdrop} role="dialog" aria-modal="true" aria-label={detail.title} onClick={() => setDetail(null)}>
          <div className={styles.detailModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.detailAccent} />
            <div className={styles.detailHeader}>
              <div className={styles.detailIcon}><Siren size={18} aria-hidden="true" /></div>
              <div className={styles.detailTitles}>
                <h3>{detail.title}</h3>
                {detail.subtitle && <p>{detail.subtitle}</p>}
              </div>
              <button className={styles.detailClose} onClick={() => setDetail(null)} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4.5 4.5L13.5 13.5M13.5 4.5L4.5 13.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            </div>
            <div className={styles.detailBody}>
              {detail.rows.map(([k, v], i) => (
                <div key={k} className={`${styles.detailRow} ${i % 2 === 0 ? styles.detailRowAlt : ""}`}>
                  <span className={styles.detailKey}>{k}</span>
                  <span className={styles.detailVal}>{v}</span>
                </div>
              ))}
            </div>
            {detail.note && (
              <div className={styles.detailFooter}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.4" /><path d="M8 7v4M8 5.2v.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                <p>{detail.note}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* View-all hotspots modal */}
      {activeTab === "Descriptive" && allHotspotsOpen && data && derived && (
        <div className={styles.detailBackdrop} role="dialog" aria-modal="true" aria-label="All hotspots" onClick={() => setAllHotspotsOpen(false)}>
          <div className={`${styles.detailModal} ${styles.impactModal}`} onClick={(e) => e.stopPropagation()}>
            <div className={styles.detailAccent} />
            <div className={styles.detailHeader}>
              <div className={styles.detailIcon}><MapPin size={18} aria-hidden="true" /></div>
              <div className={styles.detailTitles}>
                <h3>Hotspots — Full Ranking</h3>
                <p>{data.hotspots.length} five-km segments · click a row for details</p>
              </div>
              <button className={styles.detailClose} onClick={() => setAllHotspotsOpen(false)} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4.5 4.5L13.5 13.5M13.5 4.5L4.5 13.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            </div>
            <div className={styles.plazaTableWrap}>
              <table className={styles.plazaTable}>
                <thead>
                  <tr><th>#</th><th>Segment</th><th>Nearest exit</th><th>Total</th><th>Accident</th><th>Breakdown</th><th>Injured</th><th>Fatal</th></tr>
                </thead>
                <tbody>
                  {data.hotspots.map((r, i) => (
                    <tr key={r.km_bin} className={styles.clickableRow} onClick={() => { setAllHotspotsOpen(false); showHotspotDetail(r); }}>
                      <td className={styles.plazaRank}>{i + 1}</td>
                      <td>{kmLabelBoth(r.km_bin)}</td>
                      <td>{exitAt.nameForBin(r.km_bin) ?? "—"}</td>
                      <td className={styles.plazaNum}>{fmtInt(r.total)}</td>
                      <td className={styles.plazaNum}>{fmtInt(r.accident)}</td>
                      <td className={styles.plazaNum}>{fmtInt(r.breakdown)}</td>
                      <td className={styles.plazaNum}>{fmtInt(r.injuries)}</td>
                      <td className={styles.plazaNum}>{fmtInt(r.fatalities)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
